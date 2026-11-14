import { clean, encodeBase64Url, fail, json, originError } from "./http.js";
import { allowedAreas, areaRules, assertNotSuspended, outranks, requireAccount, requireAdmin, requireStaff, rosterRank, signAdmin } from "./auth.js";
import { ADMIN_LEVEL, ALL_PERMISSIONS, AREAS, PERMISSIONS, RANKS, rankLevel, validPermissions } from "./permissions.js";
import { identitiesByIds, identitiesFor } from "./identity.js";
import { redeemHandoff } from "./discord-auth.js";
import { BLACKLIST_MESSAGE, activeBlacklist, assertNotLocked, cleanLoginId, editAccount, recordAttempt, removeMember, setOwnLoginId } from "./members.js";
const MAX_BODY_BYTES = 16000;
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();

export function normalizeName(value) {
  return clean(value, 80).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function syntheticEmail(normalized) {
  return "rota." + normalized + "@members.invalid";
}

export function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function config(env) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const serviceKey = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const publicKey = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  if (!/^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)[:/])/i.test(url) || !serviceKey || !publicKey) {
    throw new Error("O administrador precisa configurar as variáveis Supabase na hospedagem.");
  }
  return { url, serviceKey, publicKey };
}

export async function callSupabase(env, path, options, usePublicKey) {
  const cfg = config(env);
  const key = usePublicKey ? cfg.publicKey : cfg.serviceKey;
  const init = options || {};
  const headers = { apikey: key, "Content-Type": "application/json", ...(init.headers || {}) };
  if (!/^sb_(?:publishable|secret)_/i.test(key)) headers.Authorization = "Bearer " + key;
  init.headers = headers;
  const response = await fetch(cfg.url + path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.msg || body.message || body.error_description || body.error || "Falha ao acessar o banco de dados.");
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function db(env, path, method, body, prefer) {
  const headers = {};
  if (prefer) headers.Prefer = prefer;
  return callSupabase(env, "/rest/v1/" + path, {
    method: method || "GET",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function getTicketTable(kind) {
  if (kind === "ouvidoria") return "ouvidoria_tickets";
  if (kind === "bo") return "bo_tickets";
  throw fail(400, "Tipo de ticket inválido.");
}

async function createAccessRequest(env, input, requestType) {
  const name = clean(input.name, 80);
  const normalized = normalizeName(name);
  if (name.length < 2 || normalized.length < 2) throw fail(400, "Informe seu nome para continuar.");
  const row = { display_name: name, normalized_name: normalized, request_type: requestType, status: "Pendente" };
  try {
    await db(env, "access_requests", "POST", row, "return=minimal");
  } catch (error) {
    if (error.status === 409 || /duplicate|unique/i.test(error.message)) {
      return { ok: true, message: requestType === "acesso" ? "Se o nome foi enviado, a solicitação está aguardando análise." : "Se houver uma conta com este nome, a solicitação está aguardando análise." };
    }
    throw error;
  }
  return { ok: true, message: requestType === "acesso" ? "Pedido enviado. Aguarde a aprovação da administração da ROTA." : "Pedido enviado. Se a conta existir, a administração poderá gerar um novo token." };
}

// Login pelo ID no servidor + senha. Conta antiga ainda sem ID entra pelo nome até registrar o ID (depois disso, só pelo ID).
async function officerLogin(env, input, request) {
  const loginId = cleanLoginId(input.loginId);
  const legacyName = loginId ? "" : normalizeName(input.name);
  const token = clean(input.token, 100);
  if ((!loginId && legacyName.length < 2) || token.length < 8) throw fail(400, "Informe o seu ID no servidor e a sua senha (ou o token recebido na recepção).");
  if (loginId && await activeBlacklist(env, loginId)) throw fail(403, BLACKLIST_MESSAGE);
  const keys = await assertNotLocked(env, request, "login", loginId || legacyName);
  let email = "";
  if (loginId) {
    const rows = await db(env, "police_users?select=login_email&login_id=eq." + encodeURIComponent(loginId) + "&removed_at=is.null&limit=1", "GET");
    email = rows.length ? rows[0].login_email : "";
  } else {
    const rows = await db(env, "police_users?select=login_email,login_id&normalized_name=eq." + encodeURIComponent(legacyName) + "&removed_at=is.null&limit=1", "GET");
    if (rows.length && rows[0].login_id) throw fail(400, "Esta conta já entra pelo ID no servidor. Use o seu ID e a sua senha.");
    email = rows.length ? (rows[0].login_email || syntheticEmail(legacyName)) : "";
  }
  let session = null;
  if (email) {
    try {
      session = await callSupabase(env, "/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password: token }) }, true);
    } catch (error) {
      if (error.status !== 400 && error.status !== 401) throw error;
    }
  }
  await recordAttempt(env, keys, "login", !!session);
  if (!session) throw fail(401, loginId ? "ID ou senha incorretos. Se esqueceu a senha, peça a troca de token." : "Nome ou senha incorretos.");
  const members = await db(env, "police_users?select=user_id,display_name,normalized_name,role,enabled,suspended_until,suspension_reason,must_set_password,login_id&user_id=eq." + encodeURIComponent(session.user.id) + "&enabled=eq.true", "GET");
  if (!Array.isArray(members) || !members.length) throw fail(403, "Esta conta não está autorizada. Peça aprovação à administração.");
  assertNotSuspended(members[0]);
  await db(env, "login_events", "POST", { user_id: session.user.id, display_name: members[0].display_name, role: members[0].role || "policial", logged_at: new Date().toISOString() }, "return=minimal");
  await db(env, "police_users?user_id=eq." + encodeURIComponent(session.user.id), "PATCH", { last_seen_at: new Date().toISOString() }, "return=minimal").catch(() => {});
  session.user.user_metadata = session.user.user_metadata || {};
  session.user.user_metadata.full_name = members[0].display_name;
  session.user.user_metadata.role = members[0].role || "visitante";
  return { session, mustSetPassword: members[0].must_set_password !== false, mustSetLoginId: !members[0].login_id, loginId: members[0].login_id || "" };
}

const ADMIN_LOCK_MINUTES = 15;
const ADMIN_MAX_FAILURES_PER_CLIENT = 5;
const ADMIN_MAX_FAILURES_TOTAL = 30;

async function adminClientKey(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(env.ROTA_SESSION_SECRET || "") + "|" + ip.split(",")[0].trim()));
  return encodeBase64Url(new Uint8Array(digest)).slice(0, 32);
}

// Bloqueia novas tentativas depois de muitos erros recentes, por IP e no total
// (o limite total cobre quem troca de IP a cada tentativa).
async function assertAdminNotLocked(env, clientKey) {
  const since = new Date(Date.now() - ADMIN_LOCK_MINUTES * 60 * 1000).toISOString();
  let failures;
  try {
    failures = await db(env, "admin_login_attempts?select=client_key&succeeded=eq.false&attempted_at=gte." + encodeURIComponent(since) + "&limit=" + ADMIN_MAX_FAILURES_TOTAL, "GET");
  } catch (_) {
    throw fail(503, "Login administrativo indisponível: execute no Supabase os arquivos SQL na ordem indicada no README.");
  }
  const rows = Array.isArray(failures) ? failures : [];
  if (rows.length >= ADMIN_MAX_FAILURES_TOTAL || rows.filter((row) => row.client_key === clientKey).length >= ADMIN_MAX_FAILURES_PER_CLIENT) {
    throw fail(429, "Muitas tentativas de login. Aguarde " + ADMIN_LOCK_MINUTES + " minutos e tente novamente.");
  }
}

async function adminLogin(env, input, request) {
  config(env);
  const clientKey = await adminClientKey(request, env);
  await assertAdminNotLocked(env, clientKey);
  const expectedUser = String(env.ROTA_ADMIN_USERNAME || "");
  const expectedPassword = String(env.ROTA_ADMIN_PASSWORD || "");
  if (expectedPassword.length < 12) throw fail(503, "Defina uma senha administrativa forte na variável ROTA_ADMIN_PASSWORD.");
  const submittedUser = clean(input.username, 60);
  const submittedPassword = encoder.encode(String(input.password || ""));
  const expectedBuffer = encoder.encode(expectedPassword);
  const userOk = expectedUser.length > 0 && submittedUser.toLowerCase() === expectedUser.toLowerCase();
  let difference = submittedPassword.length ^ expectedBuffer.length;
  const length = Math.max(submittedPassword.length, expectedBuffer.length);
  for (let i = 0; i < length; i++) difference |= (submittedPassword[i] || 0) ^ (expectedBuffer[i] || 0);
  const succeeded = userOk && difference === 0;
  await db(env, "admin_login_attempts", "POST", { client_key: clientKey, succeeded }, "return=minimal");
  if (!succeeded) throw fail(401, "Usuário ou senha administrativa incorretos.");
  const now = Math.floor(Date.now() / 1000);
  return { adminToken: await signAdmin(env, { role: "admin", iat: now, exp: now + SESSION_SECONDS }) };
}

async function dashboardRows(env, key, path, issues) {
  try {
    return await db(env, path, "GET") || [];
  } catch (_) {
    issues.push(key);
    return [];
  }
}

async function dashboard(env, actor) {
  const issues = [];
  const [requests, officers, logins, boTickets, ouvidoriaTickets, applications, arrests, blacklist, roster] = await Promise.all([
    dashboardRows(env, "solicitações de acesso", "access_requests?select=id,display_name,normalized_name,request_type,status,created_at&order=created_at.desc&limit=150", issues),
    dashboardRows(env, "contas policiais", "police_users?select=user_id,display_name,normalized_name,role,enabled,created_at,roster_id,suspended_until,suspension_reason,suspended_by,login_id,removed_at,removed_by,removal_kind,removal_reason,photo_url,discord_id,discord_username,discord_left_at&order=display_name.asc&limit=1000", issues),
    dashboardRows(env, "histórico de acesso", "login_events?select=id,user_id,display_name,role,logged_at&order=logged_at.desc&limit=40", issues),
    dashboardRows(env, "B.O.", "bo_tickets?select=id,public_id,player,legacy_name,category,status,created_at&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "Ouvidoria", "ouvidoria_tickets?select=id,public_id,player,legacy_name,category,status,created_at&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "candidaturas", "edital_applications?select=id,edital_title,full_name,candidate_name,status,created_at&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "registros de prisão", "arrest_records?select=id,character_name,player_id,officer,created_at&is_active=eq.true&order=created_at.desc&limit=30", issues),
    dashboardRows(env, "blacklist", "rota_blacklist?select=id,character_name,player_id,created_at&is_active=eq.true&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "efetivo ROTA", "rota_roster?select=id,qra,full_name,rank,passport,admitted_on,birth_date,status,photo_path,photo_url,created_at,updated_at&order=qra.asc&limit=500", issues),
  ]);

  // As listas acima são só as mais recentes; a contagem de pendentes considera todos os tickets.
  const [pendingBo, pendingOuvidoria] = await Promise.all([
    dashboardRows(env, "B.O. pendentes", "bo_tickets?select=id&status=eq.Pendente&limit=10000", issues),
    dashboardRows(env, "Ouvidoria pendente", "ouvidoria_tickets?select=id&status=eq.Pendente&limit=10000", issues)
  ]);

  // Tags: quem as tem e o histórico recente. Sem tags.sql executado, as listas ficam vazias.
  const [tags, userTags, tagLog] = await Promise.all([
    db(env, "rota_tags?select=id,name,description,permissions,created_by,updated_at&order=name.asc", "GET").catch(() => []),
    db(env, "rota_user_tags?select=user_id,tag_id,granted_by,granted_at", "GET").catch(() => []),
    db(env, "rota_tag_log?select=id,action,actor,tag_name,target_name,created_at&order=created_at.desc&limit=40", "GET").catch(() => [])
  ]);
  const [userPermissions, rules, rankHistory] = await Promise.all([
    db(env, "rota_user_permissions?select=user_id,permission,granted_by,granted_at", "GET").catch(() => []),
    areaRules(env),
    db(env, "rota_rank_history?select=id,qra,from_rank,to_rank,actor,reason,created_at&order=created_at.desc&limit=30", "GET").catch(() => [])
  ]);
  const [auditLog, blacklistAdmin] = await Promise.all([
    db(env, "rota_audit_log?select=id,action,result,target_login_id,target_name,reason,actor_login_id,actor_name,created_at&order=created_at.desc&limit=150", "GET").catch(() => []),
    db(env, "rota_blacklist?select=id,character_name,player_id,reason,created_by_name,created_by_login,created_at,photo_url&is_active=eq.true&order=created_at.desc&limit=500", "GET").catch(() => [])
  ]);
  const identities = await identitiesFor(env, officers || []).catch(() => ({}));
  const result = { identities, auditLog: auditLog || [], blacklistAdmin: blacklistAdmin || [], userPermissions: userPermissions || [], rules, rankHistory: rankHistory || [], areas: AREAS, ranks: RANKS, actorLevel: actor ? actor.level : ADMIN_LEVEL, actorRank: actor ? actor.rank : "", requests, officers, logins, boTickets, ouvidoriaTickets, applications, arrests, blacklist, roster, pendingBoCount: pendingBo.length, pendingOuvidoriaCount: pendingOuvidoria.length, dataIssues: issues, tags: (tags || []).map((t) => ({ ...t, permissions: validPermissions(t.permissions) })), userTags: userTags || [], tagLog: tagLog || [], catalog: PERMISSIONS };
  // Quem entra por tag só recebe os dados das áreas que pode gerenciar.
  if (actor && actor.role !== "admin") {
    const can = (p) => actor.permissions.includes(p), people = can("acessos.gerenciar") || can("tags.gerenciar");
    if (!can("acessos.gerenciar")) { result.requests = []; result.logins = []; }
    if (!people) { result.officers = []; result.userPermissions = []; }
    if (!can("editais.gerenciar")) result.applications = [];
    if (!can("tags.gerenciar")) result.tagLog = [];
    if (!can("blacklist.gerenciar")) result.blacklistAdmin = [];
    if (!can("acessos.gerenciar") && !can("integrantes.remover") && !can("blacklist.gerenciar")) result.auditLog = [];
    const open = allowedAreas(actor, rules);
    if (!open.includes("bo.ver")) { result.boTickets = []; result.pendingBoCount = 0; }
    if (!open.includes("ouvidoria.ver")) { result.ouvidoriaTickets = []; result.pendingOuvidoriaCount = 0; }
    if (!open.includes("prisoes.ver")) result.arrests = [];
    result.permissions = actor.permissions;
  }
  return result;
}

async function issueForOfficer(env, userId, reactivate) {
  const rows = await db(env, "police_users?select=user_id,display_name,normalized_name,role,enabled,removed_at&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
  if (!Array.isArray(rows) || !rows.length) throw fail(404, "Integrante não encontrado.");
  if (rows[0].removed_at) throw fail(409, "Esta conta foi removida da corporação. Para voltar, a pessoa passa de novo pela recepção.");
  if (!rows[0].enabled && !reactivate) throw fail(409, "Esta conta está desativada. Reative antes de trocar o token.");
  const token = randomToken();
  await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(userId), { method: "PUT", body: JSON.stringify({ password: token }) });
  await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { must_set_password: true }, "return=minimal");
  await revokeSessions(env, userId);
  if (!rows[0].enabled) await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { enabled: true }, "return=minimal");
  await db(env, "access_requests?normalized_name=eq." + encodeURIComponent(rows[0].normalized_name) + "&request_type=eq.troca_token&status=eq.Pendente", "PATCH", { status: "Aprovado", decided_at: new Date().toISOString() }, "return=minimal");
  return { ok: true, displayName: rows[0].display_name, token };
}

// ---------- tags e perfil ----------

function canHandle(actor, permissions) {
  return actor.role === "admin" || permissions.every((p) => actor.permissions.includes(p));
}

// Nível da patente de uma conta (pela ficha do efetivo; sem ficha = Recruta).
async function accountLevel(env, userId) {
  const rows = await db(env, "police_users?select=roster_id,display_name&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
  if (!rows.length) throw fail(404, "Integrante não encontrado.");
  return { level: rankLevel(await rosterRank(env, rows[0].roster_id)), name: rows[0].display_name };
}
async function assertOutranks(env, actor, userId) {
  const target = await accountLevel(env, userId);
  if (!outranks(actor, target.level)) throw fail(403, "Você só pode agir sobre integrantes de patente menor que a sua.");
  return target;
}

async function permAssign(env, actor, actorName, input, grant) {
  const userId = clean(input.userId, 80), permission = clean(input.permission, 60);
  if (!Object.hasOwn(PERMISSIONS, permission)) throw fail(400, "Poder inválido.");
  if (!canHandle(actor, [permission])) throw fail(403, "Você só pode " + (grant ? "dar" : "tirar") + " poderes que você mesmo tem.");
  const target = await assertOutranks(env, actor, userId);
  if (grant) await db(env, "rota_user_permissions", "POST", { user_id: userId, permission, granted_by: actorName }, "resolution=ignore-duplicates,return=minimal");
  else await db(env, "rota_user_permissions?user_id=eq." + encodeURIComponent(userId) + "&permission=eq." + encodeURIComponent(permission), "DELETE", undefined, "return=minimal");
  await logTag(env, { action: grant ? "poder" : "tirar-poder", actor: actorName, tag_name: PERMISSIONS[permission], target_user: userId, target_name: target.name });
  return { ok: true };
}

async function suspendAccount(env, actor, actorName, input, suspend) {
  const userId = clean(input.userId, 80), reason = clean(input.reason, 300);
  if (reason.length < 5) throw fail(400, suspend ? "Escreva o motivo da suspensão." : "Escreva o motivo para tirar a suspensão antes do prazo.");
  const target = await assertOutranks(env, actor, userId);
  let change, details;
  if (suspend) {
    const days = Number(input.days);
    if (!Number.isFinite(days) || days < 0.04 || days > 90) throw fail(400, "O prazo da suspensão vai de 1 hora a 90 dias.");
    const until = new Date(Date.now() + Math.round(days * 86400000)).toISOString();
    change = { suspended_until: until, suspension_reason: reason, suspended_by: actorName };
    details = { until, reason };
  } else {
    change = { suspended_until: null, suspension_reason: "", suspended_by: "" };
    details = { reason };
  }
  await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", change, "return=minimal");
  if (suspend) await revokeSessions(env, userId);
  await logTag(env, { action: suspend ? "suspender" : "cancelar-suspensao", actor: actorName, target_user: userId, target_name: target.name, details });
  return { ok: true };
}

async function rankRulesSave(env, actor, actorName, input) {
  const area = clean(input.area, 40), minRank = clean(input.minRank, 40);
  if (!Object.hasOwn(AREAS, area)) throw fail(400, "Área inválida.");
  if (!RANKS.includes(minRank)) throw fail(400, "Patente inválida.");
  // Ninguém exige para uma área uma patente acima da própria (isso bloquearia os superiores).
  if (actor.role !== "admin" && rankLevel(minRank) > actor.level) throw fail(403, "Você só pode exigir até a sua própria patente.");
  await db(env, "rota_area_rules", "POST", { area, min_rank: minRank, updated_by: actorName, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
  await logTag(env, { action: "regra", actor: actorName, tag_name: AREAS[area], details: { minRank } });
  return { ok: true };
}

// Derruba as sessões abertas da conta (o login salvo nos aparelhos deixa de valer).
export async function revokeSessions(env, userId) {
  await db(env, "rpc/rota_revoke_sessions", "POST", { uid: userId }).catch(() => {});
}

// Senha própria: criada no primeiro login com o token. Depois o token não vale mais (vira só recuperação).
async function setOwnPassword(request, env, input) {
  const member = await requireAccount(request, env);
  if (member.must_set_password === false) throw fail(403, "A sua senha já foi criada. Para trocar, peça a troca de token ao comando.");
  const password = String(input.password || "");
  if (password.length < 8) throw fail(400, "A senha precisa ter pelo menos 8 caracteres.");
  if (password.length > 72) throw fail(400, "A senha pode ter no máximo 72 caracteres.");
  if (/^\d+$/.test(password)) throw fail(400, "Use letras na senha, não só números.");
  const plain = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const name = plain(member.display_name);
  if (name.length >= 3 && plain(password).includes(name)) throw fail(400, "A senha não pode conter o seu nome.");
  await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(member.user_id), { method: "PUT", body: JSON.stringify({ password }) });
  await db(env, "police_users?user_id=eq." + encodeURIComponent(member.user_id), "PATCH", { must_set_password: false }, "return=minimal");
  // Trocar a senha encerra as sessões da conta: entrega uma sessão nova para quem acabou de criar a senha.
  const session = await callSupabase(env, "/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: member.login_email || syntheticEmail(member.normalized_name), password }) }, true);
  session.user.user_metadata = { ...(session.user.user_metadata || {}), full_name: member.display_name, role: member.role };
  return { ok: true, session };
}

export async function logTag(env, entry) {
  await db(env, "rota_tag_log", "POST", entry, "return=minimal").catch(() => {});
}

async function myProfile(env, actor) {
  const rules = await areaRules(env);
  if (actor.role === "admin") return { role: "admin", name: "Administração", permissions: ALL_PERMISSIONS, tags: [], roster: null, rank: "", level: 99, areas: Object.keys(AREAS) };
  let roster = null;
  if (actor.rosterId) {
    const rows = await db(env, "rota_roster?select=id,qra,full_name,rank,passport,status,photo_url&id=eq." + encodeURIComponent(actor.rosterId) + "&limit=1", "GET").catch(() => []);
    if (Array.isArray(rows) && rows.length) roster = { id: rows[0].id, qra: rows[0].qra, fullName: rows[0].full_name, rank: rows[0].rank, passport: rows[0].passport, status: rows[0].status, photoUrl: rows[0].photo_url || "" };
  }
  return { identity: (await identitiesByIds(env, [actor.id]))[actor.id] || null, discordUsername: actor.discordUsername || "", role: actor.role, mustSetPassword: actor.mustSetPassword, mustSetLoginId: !actor.loginId, loginId: actor.loginId, name: actor.name, permissions: actor.permissions, direct: actor.direct, tags: actor.tags.map((t) => ({ id: t.id, name: t.name })), roster, rank: actor.rank || "Recruta", level: actor.level, areas: allowedAreas(actor, rules) };
}

// Quem edita ou apaga uma tag precisa estar acima de todos que a usam.
async function assertTagHoldersBelow(env, actor, tagId) {
  if (actor.role === "admin") return;
  const links = await db(env, "rota_user_tags?select=user_id&tag_id=eq." + encodeURIComponent(tagId), "GET").catch(() => []);
  for (const link of links || []) {
    if (link.user_id === actor.id) continue;
    const target = await accountLevel(env, link.user_id).catch(() => null);
    if (target && !outranks(actor, target.level)) throw fail(403, "Esta tag é usada por alguém de patente igual ou maior que a sua (" + target.name + ").");
  }
}

async function tagSave(env, actor, actorName, input) {
  const name = clean(input.name, 40), description = clean(input.description, 200), permissions = validPermissions(input.permissions);
  if (name.length < 2) throw fail(400, "Dê um nome para a tag.");
  if (!permissions.length) throw fail(400, "Escolha ao menos uma permissão para a tag.");
  if (!canHandle(actor, permissions)) throw fail(403, "Você só pode dar a uma tag permissões que você mesmo tem.");
  const id = clean(input.id, 40);
  if (id) {
    const existing = await db(env, "rota_tags?select=id,permissions&id=eq." + encodeURIComponent(id) + "&limit=1", "GET");
    if (!existing.length) throw fail(404, "Tag não encontrada.");
    if (!canHandle(actor, validPermissions(existing[0].permissions))) throw fail(403, "Esta tag tem permissões que você não tem; só quem tem todas pode editá-la.");
    await assertTagHoldersBelow(env, actor, id);
    try {
      const rows = await db(env, "rota_tags?id=eq." + encodeURIComponent(id), "PATCH", { name, description, permissions, updated_at: new Date().toISOString() }, "return=representation");
      await logTag(env, { action: "editar", actor: actorName, tag_id: id, tag_name: name, details: { permissions } });
      return { tag: rows[0] };
    } catch (error) {
      if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Já existe uma tag com este nome.");
      throw error;
    }
  }
  const newId = normalizeName(name).slice(0, 40);
  if (newId.length < 2) throw fail(400, "Use letras ou números no nome da tag.");
  try {
    const rows = await db(env, "rota_tags", "POST", { id: newId, name, description, permissions, created_by: actorName }, "return=representation");
    await logTag(env, { action: "criar", actor: actorName, tag_id: newId, tag_name: name, details: { permissions } });
    return { tag: rows[0] };
  } catch (error) {
    if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Já existe uma tag com este nome.");
    throw error;
  }
}

async function tagDelete(env, actor, actorName, input) {
  const id = clean(input.id, 40);
  const existing = await db(env, "rota_tags?select=id,name,permissions&id=eq." + encodeURIComponent(id) + "&limit=1", "GET");
  if (!existing.length) throw fail(404, "Tag não encontrada.");
  if (!canHandle(actor, validPermissions(existing[0].permissions))) throw fail(403, "Esta tag tem permissões que você não tem; só quem tem todas pode apagá-la.");
  await assertTagHoldersBelow(env, actor, id);
  await db(env, "rota_tags?id=eq." + encodeURIComponent(id), "DELETE", undefined, "return=minimal");
  await logTag(env, { action: "apagar", actor: actorName, tag_id: id, tag_name: existing[0].name });
  return { ok: true };
}

async function tagAssign(env, actor, actorName, input, grant) {
  const tagId = clean(input.tagId, 40), userId = clean(input.userId, 80);
  const [tags, users] = await Promise.all([
    db(env, "rota_tags?select=id,name,permissions&id=eq." + encodeURIComponent(tagId) + "&limit=1", "GET"),
    db(env, "police_users?select=user_id,display_name,discord_id&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET")
  ]);
  if (!tags.length) throw fail(404, "Tag não encontrada.");
  if (!users.length) throw fail(404, "Integrante não encontrado.");
  if (!canHandle(actor, validPermissions(tags[0].permissions))) throw fail(403, "Você só pode " + (grant ? "dar" : "tirar") + " tags cujas permissões você mesmo tem.");
  if (users[0].discord_id) {
    const mapped = await db(env, "rota_discord_roles?select=role_id&kind=eq.tag&value=eq." + encodeURIComponent(tagId) + "&limit=1", "GET").catch(() => []);
    if (mapped.length) throw fail(409, "Esta conta é gerenciada pelo Discord: esta tag segue um cargo do servidor. Dê ou tire o cargo lá.");
  }
  await assertOutranks(env, actor, userId);
  if (grant) await db(env, "rota_user_tags", "POST", { user_id: userId, tag_id: tagId, granted_by: actorName }, "resolution=ignore-duplicates,return=minimal");
  else await db(env, "rota_user_tags?user_id=eq." + encodeURIComponent(userId) + "&tag_id=eq." + encodeURIComponent(tagId), "DELETE", undefined, "return=minimal");
  await logTag(env, { action: grant ? "dar" : "tirar", actor: actorName, tag_id: tagId, tag_name: tags[0].name, target_user: userId, target_name: users[0].display_name });
  return { ok: true };
}

async function officerLink(env, actor, actorName, input) {
  const userId = clean(input.userId, 80), rosterId = clean(input.rosterId, 36);
  if (!userId) throw fail(400, "Conta inválida.");
  if (rosterId && !/^[0-9a-f-]{36}$/i.test(rosterId)) throw fail(400, "Ficha do efetivo inválida.");
  const linkedDiscord = await db(env, "police_users?select=discord_id&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET").catch(() => []);
  if (linkedDiscord[0] && linkedDiscord[0].discord_id) throw fail(409, "Esta conta é gerenciada pelo Discord: a ficha e a patente seguem os cargos do servidor.");
  await assertOutranks(env, actor, userId);
  if (rosterId && !outranks(actor, rankLevel(await rosterRank(env, rosterId)))) throw fail(403, "Você só pode vincular fichas de patente menor que a sua.");
  try {
    const rows = await db(env, "police_users?user_id=eq." + encodeURIComponent(userId) + "&role=in.(policial,visitante)", "PATCH", { roster_id: rosterId || null, role: rosterId ? "policial" : "visitante" }, "return=representation");
    if (!rows.length) throw fail(404, "Conta não encontrada.");
    await logTag(env, { action: "vincular", actor: actorName, target_user: userId, target_name: rows[0].display_name, details: { rosterId: rosterId || null } });
    return { officer: rows[0] };
  } catch (error) {
    if (error.status === 409 || /duplicate|unique/i.test(error.message)) throw fail(409, "Esta ficha do efetivo já está ligada a outra conta.");
    throw error;
  }
}

// Permissão exigida por ação. Ações fora da lista são só do administrador do servidor.
const ACTION_PERMISSION = {
  "request-decide": "acessos.gerenciar",
  "token-rotate": "acessos.gerenciar",
  "officer-toggle": "acessos.gerenciar",
  "officer-link": "acessos.gerenciar",
  "edital-applications-list": "editais.gerenciar",
  "tag-save": "tags.gerenciar",
  "tag-delete": "tags.gerenciar",
  "tag-grant": "tags.gerenciar",
  "tag-revoke": "tags.gerenciar",
  "perm-grant": "tags.gerenciar",
  "perm-revoke": "tags.gerenciar",
  "suspend": "integrantes.suspender",
  "unsuspend": "integrantes.suspender",
  "rank-rules-save": "regras.ajustar",
  "account-edit": "acessos.gerenciar",
  "member-remove": "integrantes.remover"
};
const MANAGE_ACTIONS = ["admin-dashboard"];

async function handleAdmin(request, env, input) {
  if (input.action === "admin-session") { await requireAdmin(request, env, "Sessão administrativa inválida ou expirada."); return { valid: true }; }
  if (input.action === "set-password") return setOwnPassword(request, env, input);
  // Sinal de vida de quem está com o portal aberto (lista Equipe: online / visto por último).
  if (input.action === "heartbeat") {
    const member = await requireAccount(request, env);
    await db(env, "police_users?user_id=eq." + encodeURIComponent(member.user_id), "PATCH", { last_seen_at: new Date().toISOString() }, "return=minimal");
    return { ok: true };
  }
  if (input.action === "set-login-id") return setOwnLoginId(env, await requireAccount(request, env), input);
  if (input.action === "my-profile") {
    if (!request.headers.get("x-rota-admin-session")) {
      const member = await requireAccount(request, env);
      if (member.role !== "policial" || !member.roster_id || member.must_set_password !== false) return { identity: (await identitiesByIds(env, [member.user_id]))[member.user_id] || null, role: member.role === "policial" && !member.roster_id ? "visitante" : member.role, mustSetPassword: member.must_set_password !== false, discordUsername: member.discord_id ? member.discord_username || "Discord" : "", mustSetLoginId: !member.login_id, loginId: member.login_id || "", name: member.display_name || "", permissions: [], tags: [], roster: null, rank: "", level: -1, areas: [] };
    }
    return myProfile(env, await requireStaff(request, env));
  }
  const actor = await requireStaff(request, env).catch((error) => { if (error.status === 401 && !request.headers.get("authorization")) throw fail(401, "Sessão administrativa inválida ou expirada."); throw error; });
  const isServerAdmin = actor.role === "admin", needed = ACTION_PERMISSION[input.action];
  if (!isServerAdmin) {
    const allowed = needed ? actor.permissions.includes(needed) : MANAGE_ACTIONS.includes(input.action) && actor.permissions.length > 0;
    if (!allowed) throw fail(403, "Sua conta não tem permissão para esta ação. Peça a tag correspondente ao comando.");
  }
  const actorName = isServerAdmin ? "Administração" : (actor.name || "Integrante");
  if (input.action === "admin-dashboard") return dashboard(env, actor);
  if (input.action === "tag-save") return tagSave(env, actor, actorName, input);
  if (input.action === "tag-delete") return tagDelete(env, actor, actorName, input);
  if (input.action === "tag-grant" || input.action === "tag-revoke") return tagAssign(env, actor, actorName, input, input.action === "tag-grant");
  if (input.action === "officer-link") return officerLink(env, actor, actorName, input);
  if (input.action === "perm-grant" || input.action === "perm-revoke") return permAssign(env, actor, actorName, input, input.action === "perm-grant");
  if (input.action === "suspend" || input.action === "unsuspend") return suspendAccount(env, actor, actorName, input, input.action === "suspend");
  if (input.action === "rank-rules-save") return rankRulesSave(env, actor, actorName, input);
  if (input.action === "account-edit") return editAccount(env, actor, actorName, input);
  if (input.action === "member-remove") return removeMember(env, request, actor, input);
  if (input.action === "token-rotate" || input.action === "officer-toggle") await assertOutranks(env, actor, clean(input.userId, 80));
  if (input.action === "edital-applications-list") {
    const rows = await db(env, "edital_applications?select=id,edital_id,edital_title,full_name,server_rg,candidate_name,player_id,real_age,rp_experience,police_experience,roleplay_definition,metagaming_definition,powergaming_definition,why_pmce,character_story,status,created_at&order=created_at.desc&limit=200", "GET");
    return { rows: rows || [] };
  }  if (input.action === "tickets-list") {
    const table = getTicketTable(input.kind);
    const rows = await db(env, table + "?select=id,public_id,discord,player,legacy_name,reason,category,detail,status,created_at,decision_at&order=created_at.desc&limit=300", "GET");
    return { rows: rows || [] };
  }
  if (input.action === "ticket-decide") {
    const table = getTicketTable(input.kind);
    const status = input.status === "Aceito" || input.status === "Recusado" ? input.status : "";
    const publicId = clean(input.publicId, 32);
    if (!status || !publicId) throw fail(400, "Decisão inválida.");
    const rows = await db(env, table + "?public_id=eq." + encodeURIComponent(publicId) + "&status=eq.Pendente", "PATCH", { status, decision_at: new Date().toISOString() }, "return=representation");
    if (!Array.isArray(rows) || !rows.length) throw fail(409, "Este ticket já foi decidido ou não está disponível.");
    return { row: rows[0] };
  }
  if (input.action === "request-decide") {
    const id = clean(input.id, 60);
    const decision = input.status === "Aprovado" || input.status === "Recusado" ? input.status : "";
    if (!id || !decision) throw fail(400, "Solicitação ou decisão inválida.");
    const requests = await db(env, "access_requests?select=id,display_name,normalized_name,request_type,status&id=eq." + encodeURIComponent(id) + "&limit=1", "GET");
    if (!requests.length || requests[0].status !== "Pendente") throw fail(409, "Solicitação não encontrada ou já analisada.");
    const requestRow = requests[0];
    if (requestRow.request_type === "troca_token" && decision === "Aprovado") {
      const account = await db(env, "police_users?select=user_id,enabled&normalized_name=eq." + encodeURIComponent(requestRow.normalized_name) + "&limit=1", "GET");
      if (!account.length) throw fail(404, "Não há conta policial para este pedido de troca.");
      await assertOutranks(env, actor, account[0].user_id);
      return issueForOfficer(env, account[0].user_id, true);
    }
    await db(env, "access_requests?id=eq." + encodeURIComponent(id), "PATCH", { status: decision, decided_at: new Date().toISOString() }, "return=minimal");
    return { ok: true };
  }
  if (input.action === "token-rotate") return issueForOfficer(env, clean(input.userId, 80));
  if (input.action === "officer-toggle") {
    const userId = clean(input.userId, 80);
    if (!userId) throw fail(400, "Conta inválida.");
    const rows = await db(env, "police_users?select=user_id,enabled,removed_at&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
    if (!rows.length) throw fail(404, "Conta não encontrada.");
    if (rows[0].removed_at) throw fail(409, "Esta conta foi removida da corporação e não pode ser reativada.");
    const updated = await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { enabled: !rows[0].enabled }, "return=representation");
    if (rows[0].enabled) await revokeSessions(env, userId);
    return { officer: updated[0] };
  }
  throw fail(400, "Ação desconhecida.");
}

export async function handlePoliceAccess(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const rejectedOrigin = originError(request);
  if (rejectedOrigin) return json(403, { error: rejectedOrigin });
  const bodyText = await request.text();
  if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
  let input;
  try { input = JSON.parse(bodyText || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
  try {
    let result;
    if (input.action === "request-reset") result = await createAccessRequest(env, input, "troca_token");
    else if (input.action === "officer-login") result = await officerLogin(env, input, request);
    else if (input.action === "discord-handoff") result = await redeemHandoff(env, input);
    else if (input.action === "admin-login") result = await adminLogin(env, input, request);
    else result = await handleAdmin(request, env, input);
    return json(200, result || { ok: true });
  } catch (error) {
    const status = error.status || (/variáveis Supabase|ROTA_SESSION_SECRET/.test(error.message || "") ? 503 : 500);
    return json(status, { error: error.message || "Erro inesperado." });
  }
}
