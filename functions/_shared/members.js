// Integrantes: ID no servidor como login, reautenticação para ações críticas, limite de tentativas,
// remoção (desligamento/exoneração), edição de ID e nome, bloqueio pela Blacklist e auditoria permanente.
import { clean, encodeBase64Url, fail } from "./http.js";
import { outranks, rosterRank } from "./auth.js";
import { rankLevel } from "./permissions.js";
import { configuration } from "./supabase.js";
import { callSupabase, db, normalizeName, revokeSessions } from "./police-access.js";
import { stripMappedRoles } from "./discord.js";

const encoder = new TextEncoder();
const LOCK_MINUTES = 15, MAX_FAILURES = 5, MAX_FAILURES_PER_IP = 25;
// Nome e sobrenome do personagem (mesma regra da recepção).
export const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'-]+ [A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'-]+$/;
export const REMOVAL_KINDS = { voluntario: "Desligamento voluntário", exoneracao: "Exoneração", administrativa: "Remoção administrativa", encerramento: "Encerramento de vínculo" };
export const BLACKLIST_MESSAGE = "Este ID está na Blacklist da ROTA: o acesso ao portal e o retorno à corporação estão bloqueados.";

export function cleanLoginId(value) {
  const id = clean(value, 12).replace(/\s+/g, "");
  return /^\d{1,10}$/.test(id) ? id : "";
}

// ---------- tentativas (contra força bruta) ----------
function clientIp(request) {
  return String(request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local").split(",")[0].trim();
}
async function hashKey(env, text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(env.ROTA_SESSION_SECRET || "") + "|" + text));
  return encodeBase64Url(new Uint8Array(digest)).slice(0, 40);
}
// Bloqueia depois de 5 erros na mesma conta/IP (ou 25 no mesmo IP) em 15 minutos. Devolve as chaves para registrar o resultado.
export async function assertNotLocked(env, request, kind, subject) {
  const ip = clientIp(request);
  const keys = { subject: await hashKey(env, kind + "|" + subject + "|" + ip), ip: await hashKey(env, kind + "|ip|" + ip) };
  const since = new Date(Date.now() - LOCK_MINUTES * 60000).toISOString();
  const rows = await db(env, "rota_auth_attempts?select=key&succeeded=eq.false&kind=eq." + encodeURIComponent(kind) + "&attempted_at=gte." + encodeURIComponent(since) + "&key=in.(" + [keys.subject, keys.ip].map(encodeURIComponent).join(",") + ")&limit=100", "GET").catch(() => []);
  const list = Array.isArray(rows) ? rows : [];
  if (list.filter((r) => r.key === keys.subject).length >= MAX_FAILURES || list.filter((r) => r.key === keys.ip).length >= MAX_FAILURES_PER_IP) {
    throw fail(429, "Muitas tentativas erradas. Aguarde " + LOCK_MINUTES + " minutos e tente de novo.");
  }
  return keys;
}
export async function recordAttempt(env, keys, kind, succeeded) {
  const rows = [{ key: keys.subject, kind, succeeded }];
  if (!succeeded) rows.push({ key: keys.ip, kind, succeeded });
  await db(env, "rota_auth_attempts", "POST", rows, "return=minimal").catch(() => {});
}

// ---------- auditoria e Blacklist ----------
export async function audit(env, entry) {
  await db(env, "rota_audit_log", "POST", entry, "return=minimal").catch(() => {});
}
export async function activeBlacklist(env, loginId) {
  if (!loginId) return null;
  const rows = await db(env, "rota_blacklist?select=id,character_name,player_id&is_active=eq.true&player_id=eq." + encodeURIComponent(loginId) + "&limit=1", "GET").catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}
async function assertLoginIdFree(env, loginId, exceptUserId) {
  if (await activeBlacklist(env, loginId)) throw fail(403, "Este ID está na Blacklist da ROTA e não pode ser usado.");
  const taken = await db(env, "police_users?select=user_id&login_id=eq." + encodeURIComponent(loginId) + "&removed_at=is.null&limit=2", "GET");
  if ((taken || []).some((row) => row.user_id !== exceptUserId)) throw fail(409, "Este ID já está cadastrado em outra conta.");
}

// ---------- reautenticação ----------
function adminCredentialsOk(env, user, password) {
  const expectedUser = String(env.ROTA_ADMIN_USERNAME || ""), expected = encoder.encode(String(env.ROTA_ADMIN_PASSWORD || "")), given = encoder.encode(String(password || ""));
  if (expected.length < 12) return false;
  let difference = given.length ^ expected.length;
  for (let i = 0; i < Math.max(given.length, expected.length); i++) difference |= (given[i] || 0) ^ (expected[i] || 0);
  return expectedUser.length > 0 && clean(user, 60).toLowerCase() === expectedUser.toLowerCase() && difference === 0;
}
// Confere de novo quem está fazendo a ação: integrante informa o próprio ID e a senha; o administrador, usuário e senha.
export async function verifyActor(env, request, actor, input, action) {
  if (actor.role === "admin") {
    const keys = await assertNotLocked(env, request, "reauth", "admin");
    const ok = adminCredentialsOk(env, input.authUser, input.authPassword);
    await recordAttempt(env, keys, "reauth", ok);
    if (!ok) {
      await audit(env, { action, result: "negada", reason: "Usuário ou senha do administrador não conferem.", actor_login_id: "adm", actor_name: "Administração" });
      throw fail(401, "Usuário ou senha do administrador não conferem. Nada foi alterado.");
    }
    return { loginId: "adm", name: "Administração" };
  }
  const rows = await db(env, "police_users?select=login_id,login_email,normalized_name,display_name&user_id=eq." + encodeURIComponent(actor.id) + "&limit=1", "GET");
  const me = rows[0] || {};
  if (!me.login_id) throw fail(409, "Registre o seu ID no servidor antes de fazer esta ação.");
  const keys = await assertNotLocked(env, request, "reauth", me.login_id);
  let ok = cleanLoginId(input.authLoginId) === me.login_id && String(input.authPassword || "").length >= 8;
  if (ok) {
    try {
      const session = await callSupabase(env, "/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: me.login_email, password: String(input.authPassword) }) }, true);
      // A sessão usada só para conferir a senha é encerrada na hora.
      const cfg = configuration(env);
      await fetch(cfg.url + "/auth/v1/logout?scope=local", { method: "POST", headers: { apikey: cfg.publicKey, Authorization: "Bearer " + session.access_token } }).catch(() => {});
    } catch (_) { ok = false; }
  }
  await recordAttempt(env, keys, "reauth", ok);
  if (!ok) {
    await audit(env, { action, result: "negada", reason: "ID ou senha do responsável não conferem.", actor_login_id: me.login_id, actor_name: me.display_name || actor.name || "" });
    throw fail(401, "Seu ID ou sua senha não conferem. Nada foi alterado.");
  }
  return { loginId: me.login_id, name: me.display_name || actor.name || "Integrante" };
}

// ---------- ações sobre contas ----------
async function loadTarget(env, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw fail(400, "Conta inválida.");
  const rows = await db(env, "police_users?select=user_id,display_name,normalized_name,login_id,login_email,roster_id,enabled,removed_at,role,discord_id&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
  if (!rows.length) throw fail(404, "Conta não encontrada.");
  return rows[0];
}
async function assertOutranksTarget(env, actor, target) {
  if (!outranks(actor, rankLevel(await rosterRank(env, target.roster_id)))) throw fail(403, "Você só pode agir sobre integrantes de patente menor que a sua.");
}

// A própria conta registra o ID (contas antigas, uma única vez).
export async function setOwnLoginId(env, member, input) {
  if (member.login_id) throw fail(409, "Sua conta já tem ID registrado. Para trocar, fale com o comando.");
  const loginId = cleanLoginId(input.loginId);
  if (!loginId) throw fail(400, "O ID no servidor tem só números.");
  await assertLoginIdFree(env, loginId, member.user_id);
  try { await db(env, "police_users?user_id=eq." + encodeURIComponent(member.user_id) + "&login_id=is.null", "PATCH", { login_id: loginId }, "return=minimal"); }
  catch (error) { if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Este ID já está cadastrado em outra conta."); throw error; }
  await audit(env, { action: "registrar-id", result: "concluida", target_user: member.user_id, target_login_id: loginId, target_name: member.display_name || "", actor_login_id: loginId, actor_name: member.display_name || "" });
  return { ok: true, loginId };
}

// Comando/adm corrige o ID e o nome do personagem.
export async function editAccount(env, actor, actorName, input) {
  const target = await loadTarget(env, clean(input.userId, 36));
  if (target.removed_at) throw fail(409, "Esta conta foi removida da corporação.");
  if (target.discord_id) throw fail(409, "Esta conta é gerenciada pelo Discord: o nome e o ID vêm do apelido no servidor. Corrija o apelido lá.");
  await assertOutranksTarget(env, actor, target);
  const change = {}, before = { loginId: target.login_id || "", name: target.display_name || "" };
  if (input.loginId !== undefined && String(input.loginId).trim() !== String(target.login_id || "")) {
    const loginId = cleanLoginId(input.loginId);
    if (!loginId) throw fail(400, "O ID no servidor tem só números.");
    await assertLoginIdFree(env, loginId, target.user_id);
    change.login_id = loginId;
  }
  if (input.name !== undefined && clean(input.name, 80) !== target.display_name) {
    const name = clean(input.name, 80);
    if (!NAME_RE.test(name)) throw fail(400, "Use o nome e o sobrenome do personagem, só com letras (ex.: João Silva).");
    change.display_name = name;
    change.normalized_name = normalizeName(name);
  }
  if (!Object.keys(change).length) return { ok: true, unchanged: true };
  // O ID no servidor é o passaporte: a ficha do efetivo ligada à conta acompanha a correção.
  if (change.login_id && target.roster_id) {
    try { await db(env, "rota_roster?id=eq." + encodeURIComponent(target.roster_id), "PATCH", { passport: change.login_id, updated_at: new Date().toISOString() }, "return=minimal"); }
    catch (error) { if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Já existe outra ficha no efetivo com este passaporte."); throw error; }
  }
  try { await db(env, "police_users?user_id=eq." + encodeURIComponent(target.user_id), "PATCH", change, "return=minimal"); }
  catch (error) { if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, change.login_id ? "Este ID já está cadastrado em outra conta." : "Já existe uma conta com este nome."); throw error; }
  await audit(env, { action: "editar-conta", result: "concluida", target_user: target.user_id, target_login_id: change.login_id || target.login_id || "", target_name: change.display_name || target.display_name || "", reason: clean(input.reason, 300), actor_name: actorName, details: { before, after: { loginId: change.login_id || before.loginId, name: change.display_name || before.name } } });
  return { ok: true };
}

// Inclui um ID na Blacklist (usado pela remoção e pela inclusão manual). Derruba a conta ativa com aquele ID.
export async function blacklistInsert(env, entry) {
  try {
    const rows = await db(env, "rota_blacklist", "POST", entry, "return=representation");
    const accounts = await db(env, "police_users?select=user_id&login_id=eq." + encodeURIComponent(entry.player_id) + "&removed_at=is.null", "GET").catch(() => []);
    for (const account of accounts || []) await revokeSessions(env, account.user_id);
    return rows[0];
  } catch (error) {
    if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Este ID já está na Blacklist.");
    throw error;
  }
}

// Remoção (desligamento, exoneração...): exige poder, hierarquia, motivo, confirmação e ID + senha de quem remove.
export async function removeMember(env, request, actor, input) {
  if (actor.role !== "admin" && !actor.permissions.includes("integrantes.remover")) throw fail(403, "Remover integrantes exige o poder Remover integrantes.");
  const target = await loadTarget(env, clean(input.userId, 36));
  if (target.removed_at) throw fail(409, "Este integrante já foi removido.");
  await assertOutranksTarget(env, actor, target);
  const kind = Object.hasOwn(REMOVAL_KINDS, String(input.kind || "")) ? input.kind : "";
  const reason = clean(input.reason, 500, true);
  if (!kind) throw fail(400, "Escolha o tipo de remoção.");
  if (reason.length < 10) throw fail(400, "Escreva o motivo da remoção (pelo menos 10 caracteres).");
  if (input.confirm !== true) throw fail(400, "Confirme a remoção.");
  const toBlacklist = input.blacklist === true;
  const blacklistReason = clean(input.blacklistReason, 500, true);
  if (toBlacklist) {
    if (actor.role !== "admin" && !actor.permissions.includes("blacklist.gerenciar")) throw fail(403, "Incluir na Blacklist exige o poder Blacklist.");
    if (!target.login_id) throw fail(409, "Esta conta não tem ID registrado: registre o ID antes de incluir na Blacklist.");
    if (blacklistReason.length < 15) throw fail(400, "Escreva o motivo detalhado da inclusão na Blacklist (pelo menos 15 caracteres).");
    if (input.understood !== true) throw fail(400, "Confirme que entende as consequências da Blacklist.");
  }
  const who = await verifyActor(env, request, actor, input, toBlacklist ? "remover+blacklist" : "remover");
  const now = new Date().toISOString(), tag = target.user_id.slice(0, 8);
  const removedEmail = "removido." + target.user_id + "@members.invalid";
  // Desativa a conta e libera nome e e-mail para um recadastro futuro (se não estiver na Blacklist). O histórico fica.
  await db(env, "police_users?user_id=eq." + encodeURIComponent(target.user_id), "PATCH", { enabled: false, removed_at: now, removed_by: who.name, removal_kind: REMOVAL_KINDS[kind], removal_reason: reason, normalized_name: (target.normalized_name || "conta") + "-removido-" + tag, login_email: removedEmail }, "return=minimal");
  await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(target.user_id), { method: "PUT", body: JSON.stringify({ email: removedEmail, email_confirm: true }) }).catch(() => {});
  await revokeSessions(env, target.user_id);
  if (target.roster_id) await db(env, "rota_roster?id=eq." + encodeURIComponent(target.roster_id), "PATCH", { status: "Inativo", updated_at: now }, "return=minimal").catch(() => {});
  await db(env, "rota_user_tags?user_id=eq." + encodeURIComponent(target.user_id), "DELETE", undefined, "return=minimal").catch(() => {});
  await db(env, "rota_user_permissions?user_id=eq." + encodeURIComponent(target.user_id), "DELETE", undefined, "return=minimal").catch(() => {});
  if (target.discord_id) await stripMappedRoles(env, target.discord_id).catch(() => {});
  await audit(env, { action: "remover", result: "concluida", target_user: target.user_id, target_login_id: target.login_id || "", target_name: target.display_name || "", reason: REMOVAL_KINDS[kind] + ": " + reason, actor_login_id: who.loginId, actor_name: who.name });
  if (toBlacklist) {
    await blacklistInsert(env, { character_name: target.display_name || "Integrante removido", player_id: target.login_id, discord_id: target.discord_id || "", reason: blacklistReason, user_id: target.user_id, created_by: actor.id || null, created_by_name: who.name, created_by_login: who.loginId, photo_path: "", photo_url: "" }).catch((error) => { if (error.status !== 409) throw error; });
    await audit(env, { action: "blacklist-incluir", result: "concluida", target_user: target.user_id, target_login_id: target.login_id, target_name: target.display_name || "", reason: blacklistReason, actor_login_id: who.loginId, actor_name: who.name });
  }
  return { ok: true, blacklisted: toBlacklist };
}
