// Sessões do portal: administrador (token HMAC próprio) e policial (sessão do Supabase Auth).
import { decodeBase64Url, encodeBase64Url } from "./http.js";
import { configuration, supabase } from "./supabase.js";
import { ADMIN_LEVEL, ALL_PERMISSIONS, AREAS, isMemberRole, rankLevel, validPermissions } from "./permissions.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signAdmin(env, payload) {
  const secret = String(env.ROTA_SESSION_SECRET || "");
  if (secret.length < 32) throw new Error("Configure ROTA_SESSION_SECRET com pelo menos 32 caracteres.");
  const data = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return data + "." + encodeBase64Url(signature);
}

export async function verifyAdmin(request, env) {
  const secret = String(env.ROTA_SESSION_SECRET || ""), parts = String(request.headers.get("x-rota-admin-session") || "").split(".");
  if (secret.length < 32 || parts.length !== 2) return false;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(parts[0]))), actual = decodeBase64Url(parts[1]);
    if (actual.length !== expected.length) return false;
    let difference = 0; for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
    if (difference) return false;
    const payload = JSON.parse(decoder.decode(decodeBase64Url(parts[0])));
    return payload.role === "admin" && payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) { return false; }
}

export async function requireAdmin(request, env, message) {
  if (await verifyAdmin(request, env)) return { id: null, role: "admin" };
  throw Object.assign(new Error(message || "Somente o administrador pode fazer esta alteração."), { status: 401 });
}

// Conta logada (qualquer categoria: visitante ou policial), habilitada e não suspensa.
export async function requireAccount(request, env) {
  const authorization = String(request.headers.get("authorization") || ""), match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error("Entre com uma conta autorizada para acessar este recurso."), { status: 401 });
  const cfg = configuration(env), token = match[1];
  const userResponse = await fetch(cfg.url + "/auth/v1/user", { headers: { apikey: cfg.publicKey, Authorization: "Bearer " + token } });
  const user = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok || !user.id) throw Object.assign(new Error("Sessão inválida ou expirada."), { status: 401 });
  const members = await supabase(env, "/rest/v1/police_users?select=user_id,display_name,normalized_name,role,enabled,roster_id,suspended_until,suspension_reason,last_seen_at,must_set_password,login_id,removed_at,login_email,discord_id,discord_username&user_id=eq." + encodeURIComponent(user.id) + "&enabled=eq.true&limit=1", { method: "GET" });
  if (!Array.isArray(members) || !members.length) throw Object.assign(new Error("Esta conta não está autorizada para acessar este recurso."), { status: 403 });
  assertNotSuspended(members[0]);
  if (members[0].removed_at) throw Object.assign(new Error("Esta conta foi removida da corporação."), { status: 403 });
  // ID na Blacklist: nenhuma sessão vale, nem a que já estava aberta.
  // ID ou conta do Discord na Blacklist: nenhuma sessão vale, nem a que já estava aberta.
  const keys = [];
  if (members[0].login_id) keys.push("player_id.eq." + encodeURIComponent(members[0].login_id));
  if (members[0].discord_id) keys.push("discord_id.eq." + encodeURIComponent(members[0].discord_id));
  if (keys.length) {
    const blocked = await supabase(env, "/rest/v1/rota_blacklist?select=id&is_active=eq.true&or=(" + keys.join(",") + ")&limit=1", { method: "GET" }).catch(() => []);
    if (Array.isArray(blocked) && blocked.length) throw Object.assign(new Error("Você está na Blacklist da ROTA: o acesso ao portal está bloqueado."), { status: 403 });
  }
  return members[0];
}

// Aceita a sessão de administrador ou a de um integrante (policial com ficha do efetivo) habilitado e não suspenso.
// O policial volta com patente (nível), tags e a soma das permissões das tags e dos poderes avulsos.
export async function requireStaff(request, env) {
  if (await verifyAdmin(request, env)) return { id: null, role: "admin", name: "Administração", rank: "", level: ADMIN_LEVEL, permissions: ALL_PERMISSIONS.slice(), tags: [], direct: [] };
  const member = await requireAccount(request, env);
  // Visitante (ou conta policial ainda sem ficha do efetivo) não entra na área policial.
  if (!isMemberRole(member.role) || !member.roster_id) throw Object.assign(new Error("Conta de visitante: a área policial é só para integrantes da ROTA. Peça ingresso na recepção."), { status: 403, visitor: true });
  if (member.must_set_password !== false) throw Object.assign(new Error("Crie a sua senha antes de usar a área policial."), { status: 403 });
  await touchPresence(env, member);
  const [tags, direct, rank] = await Promise.all([officerTags(env, member.user_id), directPermissions(env, member.user_id), rosterRank(env, member.roster_id)]);
  const permissions = [...new Set(tags.flatMap((tag) => tag.permissions).concat(direct))];
  return { id: member.user_id, role: member.role, name: member.display_name || "", mustSetPassword: member.must_set_password !== false, loginId: member.login_id || "", discordUsername: member.discord_id ? member.discord_username || "Discord" : "", rosterId: member.roster_id, rank, level: rankLevel(rank), permissions, tags, direct };
}

// Presença do policial (lista "No balcão" da recepção): grava no máximo a cada 30 s.
async function touchPresence(env, member) {
  const last = member.last_seen_at ? new Date(member.last_seen_at).getTime() : 0;
  if (Date.now() - last < 30000) return;
  await supabase(env, "/rest/v1/police_users?user_id=eq." + encodeURIComponent(member.user_id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_seen_at: new Date().toISOString() }) }).catch(() => {});
}

export function suspensionMessage(row) {
  const until = new Date(row.suspended_until).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
  return "Sua conta está suspensa até " + until + (row.suspension_reason ? ". Motivo: " + row.suspension_reason : ".");
}
export function assertNotSuspended(row) {
  if (row && row.suspended_until && new Date(row.suspended_until) > new Date()) throw Object.assign(new Error(suspensionMessage(row)), { status: 403 });
}

// Patente da ficha do efetivo ligada à conta. Sem ficha, a conta conta como Recruta.
export async function rosterRank(env, rosterId) {
  if (!rosterId) return "";
  const rows = await supabase(env, "/rest/v1/rota_roster?select=rank&id=eq." + encodeURIComponent(rosterId) + "&limit=1", { method: "GET" }).catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0].rank : "";
}

export async function directPermissions(env, userId) {
  try {
    const rows = await supabase(env, "/rest/v1/rota_user_permissions?select=permission&user_id=eq." + encodeURIComponent(userId), { method: "GET" });
    return validPermissions((Array.isArray(rows) ? rows : []).map((row) => row.permission));
  } catch (_) { return []; }
}

// Tags de um integrante. Sem a tabela de tags (tags.sql ainda não executado) o policial fica sem permissões extras.
export async function officerTags(env, userId) {
  try {
    const links = await supabase(env, "/rest/v1/rota_user_tags?select=tag_id&user_id=eq." + encodeURIComponent(userId), { method: "GET" });
    const ids = (Array.isArray(links) ? links : []).map((row) => row.tag_id);
    if (!ids.length) return [];
    const rows = await supabase(env, "/rest/v1/rota_tags?select=id,name,permissions&id=in.(" + ids.map(encodeURIComponent).join(",") + ")", { method: "GET" });
    return (Array.isArray(rows) ? rows : []).map((row) => ({ id: row.id, name: row.name, permissions: validPermissions(row.permissions) }));
  } catch (_) { return []; }
}

export async function requirePermission(request, env, permission, message) {
  const actor = await requireStaff(request, env);
  if (actor.role === "admin" || actor.permissions.includes(permission)) return actor;
  throw Object.assign(new Error(message || "Sua conta não tem permissão para esta ação. Peça a tag correspondente ao comando."), { status: 403 });
}

// Patente mínima de cada área (rota_area_rules). Sem a tabela, tudo fica liberado como antes.
export async function areaRules(env) {
  const rows = await supabase(env, "/rest/v1/rota_area_rules?select=area,min_rank", { method: "GET" }).catch(() => []);
  const rules = {};
  for (const row of Array.isArray(rows) ? rows : []) rules[row.area] = row.min_rank;
  return rules;
}
export function allowedAreas(actor, rules) {
  return Object.keys(AREAS).filter((area) => actor.role === "admin" || actor.level >= rankLevel(rules[area]));
}
export async function checkArea(env, actor, area) {
  if (actor.role === "admin") return actor;
  const rules = await areaRules(env);
  if (actor.level >= rankLevel(rules[area])) return actor;
  throw Object.assign(new Error("Esta área está liberada a partir de " + (rules[area] || "Recruta") + "."), { status: 403 });
}
// Apagar o registro de outra pessoa exige o poder de moderar; o próprio autor pode apagar o seu.
export function assertCanRemove(actor, createdBy) {
  if (actor.role === "admin" || (createdBy && createdBy === actor.id) || actor.permissions.includes("registros.moderar")) return;
  throw Object.assign(new Error("Só quem registrou ou quem tem o poder de moderar registros pode apagar este item."), { status: 403 });
}

// Hierarquia: só se age sobre quem tem patente menor que a sua.
export function outranks(actor, targetLevel) {
  return actor.role === "admin" || actor.level > targetLevel;
}
