// Recepção da delegacia: sala de espera pública, fila por ordem de chegada e atendimento por quem tem o poder Acessos.
// O solicitante guarda um bilhete secreto (só o hash fica no banco). O token de login só é gerado na retirada.
import { clean, encodeBase64Url, fail, json, originError, publicMessage } from "./http.js";
import { requireAccount, requireStaff } from "./auth.js";
import { RANKS, rankLevel, validPermissions } from "./permissions.js";
import { callSupabase, db, logTag, normalizeName, randomToken, syntheticEmail } from "./police-access.js";
import { configuration } from "./supabase.js";
import { BLACKLIST_MESSAGE, NAME_RE, activeBlacklist } from "./members.js";
import { identitiesFor } from "./identity.js";

const MAX_BODY_BYTES = 8000;
const ONLINE_MS = 45 * 1000;          // solicitante na sala: visto há menos de 45 s (a sala atualiza a cada 15 s)
const STAFF_ONLINE_MS = 150 * 1000;   // policial no balcão: mesma janela da lista Equipe (sinal de vida a cada 60 s)
const EXPIRE_MS = 15 * 60 * 1000;     // quem sai da sala por 15 min perde a vez
const CLAIM_MS = 10 * 60 * 1000;      // atendimento parado por 10 min volta para a fila
const MAX_OPEN = 60;
const OPEN = "status=in.(Pendente,Em%20atendimento)";
const REQUEST_FIELDS = "id,photo_path,photo_url,age,age_checked_by,display_name,normalized_name,passport,purpose,note,status,created_at,last_seen_at,claimed_by,claimed_name,claimed_at,decided_by,decided_at,granted_role,granted_rank,refusal_reason,user_id,picked_up_at";
const encoder = new TextEncoder();
// Nome e sobrenome do personagem: duas palavras só com letras (acentos, apóstrofo e hífen permitidos).
const AGE_REVIEW = 16;

async function hashTicket(ticket) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode("rota-recepcao|" + ticket));
  return encodeBase64Url(new Uint8Array(digest));
}
const iso = (ms) => new Date(ms).toISOString();
const online = (row) => !!row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() < ONLINE_MS;
const minutes = (row) => Math.max(0, Math.floor((Date.now() - new Date(row.created_at).getTime()) / 60000));

// Avisa os navegadores (canal público do Realtime) que a fila mudou. O aviso não carrega dados:
// cada tela busca o estado de novo aqui no servidor.
async function notify(env) {
  try {
    const cfg = configuration(env);
    await fetch(cfg.url + "/realtime/v1/api/broadcast", {
      method: "POST",
      headers: { apikey: cfg.serviceKey, "Content-Type": "application/json", ...(/^sb_/i.test(cfg.serviceKey) ? {} : { Authorization: "Bearer " + cfg.serviceKey }) },
      body: JSON.stringify({ messages: [{ topic: "rota-recepcao", event: "fila", payload: { at: Date.now() } }] })
    });
  } catch (_) { /* sem tempo real, as telas atualizam sozinhas a cada 15 s */ }
}

// Limpa a fila: quem sumiu da sala perde a vez; atendimento esquecido volta a aguardar.
async function tidy(env) {
  // Pedidos do sistema antigo (sem presença registrada) também perdem a vez depois de 15 min.
  await db(env, "access_requests?request_type=eq.acesso&status=eq.Pendente&last_seen_at=is.null&created_at=lt." + encodeURIComponent(iso(Date.now() - EXPIRE_MS)), "PATCH", { status: "Desistiu", decided_at: new Date().toISOString() }, "return=minimal").catch(() => {});
  await db(env, "access_requests?request_type=eq.acesso&status=eq.Pendente&last_seen_at=lt." + encodeURIComponent(iso(Date.now() - EXPIRE_MS)), "PATCH", { status: "Desistiu", decided_at: new Date().toISOString() }, "return=minimal").catch(() => {});
  await db(env, "access_requests?request_type=eq.acesso&status=eq.Em%20atendimento&claimed_at=lt." + encodeURIComponent(iso(Date.now() - CLAIM_MS)), "PATCH", { status: "Pendente", claimed_by: null, claimed_name: "", claimed_at: null }, "return=minimal").catch(() => {});
}

async function openQueue(env) {
  await tidy(env);
  const rows = await db(env, "access_requests?select=" + REQUEST_FIELDS + "&request_type=eq.acesso&" + OPEN + "&order=created_at.asc&limit=" + MAX_OPEN, "GET");
  return Array.isArray(rows) ? rows : [];
}

// Quem pode liberar acesso: integrante ativo, não suspenso, com o poder Acessos (por tag ou avulso).
async function responsibles(env) {
  const [tags, links, direct] = await Promise.all([
    db(env, "rota_tags?select=id,permissions", "GET").catch(() => []),
    db(env, "rota_user_tags?select=user_id,tag_id", "GET").catch(() => []),
    db(env, "rota_user_permissions?select=user_id,permission", "GET").catch(() => [])
  ]);
  const perms = {};
  const add = (user, list) => { perms[user] = perms[user] || new Set(); list.forEach((p) => perms[user].add(p)); };
  const tagPerms = Object.fromEntries((tags || []).map((t) => [t.id, validPermissions(t.permissions)]));
  (links || []).forEach((l) => add(l.user_id, tagPerms[l.tag_id] || []));
  (direct || []).forEach((d) => add(d.user_id, validPermissions([d.permission])));
  const ids = Object.keys(perms).filter((id) => perms[id].has("acessos.gerenciar"));
  if (!ids.length) return [];
  const people = await db(env, "police_users?select=user_id,display_name,role,roster_id,login_id,photo_url,last_seen_at,suspended_until&role=eq.policial&enabled=eq.true&roster_id=not.is.null&user_id=in.(" + ids.map(encodeURIComponent).join(",") + ")", "GET");
  const active = (people || []).filter((p) => !p.suspended_until || new Date(p.suspended_until) <= new Date());
  if (!active.length) return [];
  const who = await identitiesFor(env, active);
  return active.map((p) => {
    const id = who[p.user_id] || {};
    return { label: id.label, name: id.name, loginId: id.loginId, photoUrl: id.photoUrl, nameColor: id.nameColor, rank: id.rank || "Recruta", online: !!p.last_seen_at && Date.now() - new Date(p.last_seen_at).getTime() < STAFF_ONLINE_MS, canGrantRank: perms[p.user_id].has("patentes.promover") };
  }).sort((a, b) => (b.online - a.online) || (rankLevel(b.rank) - rankLevel(a.rank)));
}

function publicRow(row, index, mine) {
  return { position: index + 1, name: row.display_name, waitingMinutes: minutes(row), online: online(row), status: row.status, attendedBy: row.claimed_name || "", mine: !!mine };
}

export async function requestByTicket(env, ticket) { return findByTicket(env, ticket); }
async function findByTicket(env, ticket) {
  const value = clean(ticket, 80);
  if (value.length < 20) throw fail(401, "Bilhete da recepção inválido. Entre na fila de novo.");
  const rows = await db(env, "access_requests?select=" + REQUEST_FIELDS + "&ticket_hash=eq." + encodeURIComponent(await hashTicket(value)) + "&limit=1", "GET");
  if (!Array.isArray(rows) || !rows.length) throw fail(404, "Não achamos o seu lugar na fila. Entre na fila de novo.");
  return rows[0];
}

// ---------- solicitante ----------

async function join(request, env, input) {
  let account = null;
  if (request.headers.get("authorization")) account = await requireAccount(request, env);
  if (account && account.role === "policial" && account.roster_id) throw fail(409, "Você já é integrante da ROTA.");
  const name = account ? account.display_name : clean(input.name, 80);
  const normalized = account ? account.normalized_name : normalizeName(name);
  const passport = account && account.login_id ? account.login_id : clean(input.passport, 20), note = clean(input.note, 300, true);
  const purpose = account ? "ingressar" : (input.purpose === "ingressar" ? "ingressar" : "visitar");
  if (!account && !NAME_RE.test(name)) throw fail(400, "Informe só o nome e o sobrenome do seu personagem na cidade (ex.: João Silva), sem números nem apelidos.");
  if (name.length < 2 || normalized.length < 2) throw fail(400, "Informe o nome do seu personagem na cidade.");
  if (!/^\d{1,10}$/.test(passport)) throw fail(400, "O passaporte (ID no servidor) tem só números.");
  const age = Number(input.age);
  if (!Number.isInteger(age) || age < 1 || age > 99) throw fail(400, "Informe a sua idade real.");
  if (age < 15) throw fail(403, "A idade mínima para ter conta no portal é 15 anos.");
  if (await activeBlacklist(env, passport)) throw fail(403, BLACKLIST_MESSAGE);
  const owner = await db(env, "police_users?select=user_id&login_id=eq." + encodeURIComponent(passport) + "&removed_at=is.null&limit=1", "GET");
  if (owner.length && (!account || owner[0].user_id !== account.user_id)) throw fail(409, "Este ID já tem conta ativa no portal. Entre com o seu ID e a sua senha, ou peça a troca de token.");
  if (!account) {
    const existing = await db(env, "police_users?select=user_id&normalized_name=eq." + encodeURIComponent(normalized) + "&limit=1", "GET");
    if (existing.length) throw fail(409, "Já existe uma conta com este nome. Entre com o seu token ou peça a troca de token.");
  }
  const queue = await openQueue(env);
  if (queue.length >= MAX_OPEN) throw fail(429, "A recepção está lotada. Tente de novo em alguns minutos.");
  // Pedido aberto com o mesmo nome: quem ficou fora da sala por mais de 2 min cede o lugar (perdeu o bilhete).
  const same = queue.find((row) => row.normalized_name === normalized);
  if (same) {
    if (same.last_seen_at && Date.now() - new Date(same.last_seen_at).getTime() < 2 * 60 * 1000) throw fail(409, "Já há alguém com este nome na fila agora. Se for você, volte pela mesma aba ou aguarde 2 minutos.");
    await db(env, "access_requests?id=eq." + encodeURIComponent(same.id), "PATCH", { status: "Desistiu", decided_at: new Date().toISOString() }, "return=minimal");
  }
  const ticket = randomToken() + randomToken();
  const now = new Date().toISOString();
  try {
    await db(env, "access_requests", "POST", { display_name: name, normalized_name: normalized, request_type: "acesso", status: "Pendente", passport, purpose, note, age, ticket_hash: await hashTicket(ticket), last_seen_at: now, user_id: account ? account.user_id : null }, "return=minimal");
  } catch (error) {
    if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Já há um pedido aberto com este nome.");
    throw error;
  }
  await notify(env);
  return { ticket };
}

async function room(env, input) {
  // Sem bilhete: só a vitrine (fila e balcão), para quem ainda vai entrar.
  if (!input.ticket) {
    const [queue, staff] = await Promise.all([openQueue(env), responsibles(env)]);
    return { me: null, queue: queue.map((row, i) => publicRow(row, i, false)), staff };
  }
  const me = await findByTicket(env, input.ticket);
  const isOpen = me.status === "Pendente" || me.status === "Em atendimento";
  if (isOpen) {
    await db(env, "access_requests?id=eq." + encodeURIComponent(me.id), "PATCH", { last_seen_at: new Date().toISOString() }, "return=minimal");
    me.last_seen_at = new Date().toISOString();
  }
  const [queue, staff] = await Promise.all([openQueue(env), responsibles(env)]);
  const index = queue.findIndex((row) => row.id === me.id);
  return {
    me: { name: me.display_name, purpose: me.purpose, ageReview: me.age != null && me.age <= AGE_REVIEW, status: index < 0 && isOpen ? "Desistiu" : me.status, position: index + 1, waitingMinutes: minutes(me), attendedBy: me.claimed_name || "", decidedBy: me.decided_by || "", grantedRole: me.granted_role || "", grantedRank: me.granted_rank || "", refusalReason: me.refusal_reason || "", readyToPickUp: me.status === "Aprovado" && !me.picked_up_at && !!me.user_id, pickedUp: !!me.picked_up_at },
    queue: queue.map((row, i) => publicRow(row, i, row.id === me.id)),
    staff
  };
}

async function leave(env, input) {
  const me = await findByTicket(env, input.ticket);
  await db(env, "access_requests?id=eq." + encodeURIComponent(me.id) + "&" + OPEN, "PATCH", { status: "Desistiu", decided_at: new Date().toISOString() }, "return=minimal");
  await notify(env);
  return { ok: true };
}

// Retirada do acesso aprovado: gera o token agora (uma única vez) e já devolve a sessão.
async function pickup(env, input) {
  const me = await findByTicket(env, input.ticket);
  if (me.status !== "Aprovado" || !me.user_id) throw fail(409, "Seu acesso ainda não foi aprovado.");
  const marked = await db(env, "access_requests?id=eq." + encodeURIComponent(me.id) + "&picked_up_at=is.null", "PATCH", { picked_up_at: new Date().toISOString() }, "return=representation");
  if (!Array.isArray(marked) || !marked.length) throw fail(409, "O token deste pedido já foi entregue. Se perdeu, peça a troca de token.");
  const token = randomToken();
  let session;
  try {
    const owner = await db(env, "police_users?select=login_email&user_id=eq." + encodeURIComponent(me.user_id) + "&limit=1", "GET");
    await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(me.user_id), { method: "PUT", body: JSON.stringify({ password: token }) });
    session = await callSupabase(env, "/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: (owner[0] && owner[0].login_email) || syntheticEmail(me.normalized_name), password: token }) }, true);
  } catch (error) {
    await db(env, "access_requests?id=eq." + encodeURIComponent(me.id), "PATCH", { picked_up_at: null }, "return=minimal").catch(() => {});
    throw error;
  }
  const account = await db(env, "police_users?select=display_name,role,login_id&user_id=eq." + encodeURIComponent(me.user_id) + "&limit=1", "GET");
  session.user.user_metadata = { ...(session.user.user_metadata || {}), full_name: account[0].display_name, role: account[0].role };
  await db(env, "login_events", "POST", { user_id: me.user_id, display_name: account[0].display_name, role: account[0].role, logged_at: new Date().toISOString() }, "return=minimal").catch(() => {});
  return { token, name: account[0].display_name, role: account[0].role, loginId: account[0].login_id || "", session };
}

// ---------- atendimento ----------

function staffName(actor) { return actor.role === "admin" ? "Administração" : (actor.name || "Integrante"); }
function grantableRanks(actor) {
  if (actor.role !== "admin" && !actor.permissions.includes("patentes.promover")) return [];
  return RANKS.filter((rank) => actor.role === "admin" || rankLevel(rank) < actor.level);
}

async function staffQueue(env, actor) {
  const [queue, staff] = await Promise.all([openQueue(env), responsibles(env)]);
  const myName = staffName(actor);
  return {
    queue: queue.map((row, i) => ({ id: row.id, position: i + 1, name: row.display_name, photoUrl: row.photo_url || "", passport: row.passport, age: row.age, ageReview: row.age != null && row.age <= AGE_REVIEW, purpose: row.purpose, note: row.note, createdAt: row.created_at, waitingMinutes: minutes(row), online: online(row), status: row.status, attendedBy: row.claimed_name || "", attendedByMe: row.status === "Em atendimento" && (actor.id ? row.claimed_by === actor.id : row.claimed_name === myName), existingAccount: !!row.user_id })),
    staff,
    grantableRanks: grantableRanks(actor)
  };
}

async function loadOpen(env, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw fail(400, "Pedido inválido.");
  const rows = await db(env, "access_requests?select=" + REQUEST_FIELDS + "&id=eq." + encodeURIComponent(id) + "&request_type=eq.acesso&limit=1", "GET");
  if (!rows.length) throw fail(404, "Pedido não encontrado.");
  const row = rows[0];
  if (row.status !== "Pendente" && row.status !== "Em atendimento") throw fail(409, "Este pedido já foi resolvido ou o solicitante saiu da fila.");
  return row;
}
function claimedByOther(row, actor) {
  if (row.status !== "Em atendimento") return false;
  if (row.claimed_at && Date.now() - new Date(row.claimed_at).getTime() > CLAIM_MS) return false;
  return actor.id ? row.claimed_by !== actor.id : row.claimed_name !== "Administração";
}

async function claim(env, actor, input) {
  const row = await loadOpen(env, clean(input.id, 36));
  if (claimedByOther(row, actor)) throw fail(409, "Este pedido já está em atendimento com " + (row.claimed_name || "outro policial") + ".");
  const free = row.status === "Pendente" ? "&status=eq.Pendente" : "&claimed_at=eq." + encodeURIComponent(row.claimed_at || "");
  const taken = await db(env, "access_requests?id=eq." + encodeURIComponent(row.id) + free, "PATCH", { status: "Em atendimento", claimed_by: actor.id, claimed_name: staffName(actor), claimed_at: new Date().toISOString() }, "return=representation");
  if (!Array.isArray(taken) || !taken.length) throw fail(409, "Outro policial acabou de pegar este atendimento.");
  await logTag(env, { action: "recepcao-atender", actor: staffName(actor), target_name: row.display_name, details: { requestId: row.id } }).catch(() => {});
  await notify(env);
  return { ok: true };
}

async function release(env, actor, input) {
  const row = await loadOpen(env, clean(input.id, 36));
  if (claimedByOther(row, actor)) throw fail(409, "Só quem está atendendo pode devolver este pedido para a fila.");
  await db(env, "access_requests?id=eq." + encodeURIComponent(row.id), "PATCH", { status: "Pendente", claimed_by: null, claimed_name: "", claimed_at: null }, "return=minimal");
  await notify(env);
  return { ok: true };
}

async function createAccount(env, row, role, rosterId) {
  const created = await callSupabase(env, "/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email: syntheticEmail(row.normalized_name), password: randomToken() + randomToken(), email_confirm: true, user_metadata: { full_name: row.display_name, name: row.display_name, role }, app_metadata: { role } }) });
  try {
    await db(env, "police_users", "POST", { user_id: created.id, display_name: row.display_name, normalized_name: row.normalized_name, login_email: syntheticEmail(row.normalized_name), role, enabled: true, roster_id: rosterId || null, login_id: /^\d{1,10}$/.test(row.passport || "") ? row.passport : null, photo_path: row.photo_path || "", photo_url: row.photo_url || "" }, "return=minimal");
  } catch (error) {
    await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(created.id), { method: "DELETE" }).catch(() => {});
    throw error;
  }
  return created.id;
}

async function decide(env, actor, input) {
  const row = await loadOpen(env, clean(input.id, 36));
  if (claimedByOther(row, actor)) throw fail(409, "Este pedido está em atendimento com " + (row.claimed_name || "outro policial") + ".");
  const actorName = staffName(actor), now = new Date().toISOString();

  if (input.decision === "recusar") {
    const reason = clean(input.reason, 300, true);
    if (reason.length < 5) throw fail(400, "Escreva o motivo da recusa. O solicitante vai ver esse motivo.");
    await db(env, "access_requests?id=eq." + encodeURIComponent(row.id), "PATCH", { status: "Recusado", refusal_reason: reason, decided_by: actorName, decided_at: now }, "return=minimal");
    await logTag(env, { action: "recepcao-recusar", actor: actorName, target_name: row.display_name, details: { reason } }).catch(() => {});
    await notify(env);
    return { ok: true };
  }
  if (input.decision !== "aprovar") throw fail(400, "Decisão inválida.");
  if (await activeBlacklist(env, row.passport)) throw fail(403, "Este ID está na Blacklist da ROTA: não pode ser aprovado.");
  if (row.age != null && row.age <= AGE_REVIEW && input.ageChecked !== true) throw fail(400, "Este solicitante tem " + row.age + " anos: confirme que verificou a idade antes de aprovar.");
  const role = input.role === "policial" ? "policial" : "visitante";
  if (!row.user_id) {
    const taken = await db(env, "police_users?select=user_id&normalized_name=eq." + encodeURIComponent(row.normalized_name) + "&limit=1", "GET");
    if (taken.length) throw fail(409, "Já existe uma conta com este nome. Recuse e oriente a pessoa a pedir troca de token.");
  }

  let userId = row.user_id, rosterId = null, rank = null, reusedRoster = false;
  if (role === "visitante") {
    if (!userId) userId = await createAccount(env, row, "visitante", null);
  } else {
    // Dar patente: poder de promover e só até uma patente abaixo da sua (validado aqui, não só na tela).
    rank = clean(input.rank, 40);
    if (!RANKS.includes(rank)) throw fail(400, "Escolha a patente.");
    if (!grantableRanks(actor).includes(rank)) throw fail(403, actor.role !== "admin" && !actor.permissions.includes("patentes.promover") ? "Dar patente exige o poder de promover e rebaixar. Aprove como visitante ou chame um superior." : "Você só pode dar patentes abaixo da sua.");
    const qra = clean(input.qra, 40), fullName = clean(input.fullName, 100), birthDate = clean(input.birthDate, 10);
    if (qra.length < 2) throw fail(400, "Informe o QRA do novo integrante.");
    if (fullName.length < 3) throw fail(400, "Informe o nome completo do personagem.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw fail(400, "Informe a data de nascimento do personagem.");
    try {
      const passport = row.passport;
      if (!/^\d{1,10}$/.test(passport || "")) throw fail(400, "Este pedido não tem um passaporte válido (só números).");
      // Quem foi removido e volta reaproveita a ficha antiga (Inativa) com o mesmo passaporte; o histórico continua.
      const old = await db(env, "rota_roster?select=id,status&passport=eq." + encodeURIComponent(passport) + "&limit=1", "GET");
      if (old.length && old[0].status !== "Inativo") throw fail(409, "Já existe uma ficha ativa no efetivo com este passaporte.");
      if (old.length) {
        await db(env, "police_users?roster_id=eq." + encodeURIComponent(old[0].id), "PATCH", { roster_id: null }, "return=minimal");
        const fichas = await db(env, "rota_roster?id=eq." + encodeURIComponent(old[0].id), "PATCH", { qra, full_name: fullName, rank, admitted_on: now.slice(0, 10), birth_date: birthDate, status: "Ativo", updated_at: now }, "return=representation");
        rosterId = fichas[0].id;
        reusedRoster = true;
      } else {
        const fichas = await db(env, "rota_roster", "POST", { qra, full_name: fullName, rank, passport, admitted_on: now.slice(0, 10), birth_date: birthDate, status: "Ativo", photo_path: "", photo_url: "" }, "return=representation");
        rosterId = fichas[0].id;
      }
    } catch (error) {
      if (/ficha ativa|passaporte válido/.test(error.message)) throw error;
      if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Já existe uma ficha no efetivo com este QRA ou passaporte.");
      throw error;
    }
    try {
      if (userId) {
        await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { role: "policial", roster_id: rosterId }, "return=minimal");
        await db(env, "police_users?user_id=eq." + encodeURIComponent(userId) + "&login_id=is.null", "PATCH", { login_id: row.passport }, "return=minimal").catch(() => {});
      } else userId = await createAccount(env, row, "policial", rosterId);
    } catch (error) {
      await db(env, "rota_roster?id=eq." + encodeURIComponent(rosterId), reusedRoster ? "PATCH" : "DELETE", reusedRoster ? { status: "Inativo" } : undefined, "return=minimal").catch(() => {});
      throw error;
    }
    await db(env, "rota_rank_history", "POST", { roster_id: rosterId, qra, from_rank: "", to_rank: rank, actor: actorName, reason: "Ingresso pela recepção" }, "return=minimal").catch(() => {});
  }
  // Foto enviada no pedido vale para a conta que já existia, se ela ainda estiver com a logo.
  if (row.user_id && row.photo_path) await db(env, "police_users?user_id=eq." + encodeURIComponent(row.user_id) + "&photo_path=eq.", "PATCH", { photo_path: row.photo_path, photo_url: row.photo_url }, "return=minimal").catch(() => {});
  // Conta que já existia (visitante pedindo ingresso) não precisa de token novo.
  const existed = !!row.user_id;
  await db(env, "access_requests?id=eq." + encodeURIComponent(row.id), "PATCH", { status: "Aprovado", decided_by: actorName, decided_at: now, granted_role: role, granted_rank: rank, user_id: userId, age_checked_by: row.age != null && row.age <= AGE_REVIEW ? actorName : "", picked_up_at: existed ? now : null }, "return=minimal");
  await logTag(env, { action: "recepcao-aprovar", actor: actorName, target_user: userId, target_name: row.display_name, details: { role, rank, age: row.age, ageChecked: row.age != null && row.age <= AGE_REVIEW } }).catch(() => {});
  await notify(env);
  return { ok: true, role, rank };
}

export async function handleReception(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const rejectedOrigin = originError(request);
  if (rejectedOrigin) return json(403, { error: rejectedOrigin });
  const bodyText = await request.text();
  if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
  let input;
  try { input = JSON.parse(bodyText || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
  try {
    const action = input.action;
    if (action === "join") return json(200, await join(request, env, input));
    if (action === "room") return json(200, await room(env, input));
    if (action === "leave") return json(200, await leave(env, input));
    if (action === "pickup") return json(200, await pickup(env, input));
    if (!["staff-queue", "claim", "release", "decide"].includes(action)) return json(400, { error: "Ação desconhecida." });
    const actor = await requireStaff(request, env);
    if (actor.role !== "admin" && !actor.permissions.includes("acessos.gerenciar")) return json(403, { error: "Atender a recepção exige o poder Acessos." });
    if (action === "staff-queue") return json(200, await staffQueue(env, actor));
    if (action === "claim") return json(200, await claim(env, actor, input));
    if (action === "release") return json(200, await release(env, actor, input));
    return json(200, await decide(env, actor, input));
  } catch (error) {
    return json(error.status || 500, { error: publicMessage(error) });
  }
}
