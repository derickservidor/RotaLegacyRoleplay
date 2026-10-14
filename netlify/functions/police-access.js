const crypto = require("node:crypto");

const MAX_BODY_BYTES = 16000;
const SESSION_SECONDS = 8 * 60 * 60;

function json(statusCode, payload) {
  return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(payload) };
}
function clean(value, limit) {
  return Array.from(String(value || "")).filter(function (character) {
    const code = character.charCodeAt(0);
    return code >= 32 || code === 9;
  }).join("").trim().slice(0, limit);
}
function normalizeName(value) {
  return clean(value, 80).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function syntheticEmail(normalized) { return "rota." + normalized + "@members.invalid"; }
function randomToken() { return crypto.randomBytes(24).toString("base64url"); }
function config() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const serviceKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const publicKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
  if (!/^https:\/\//i.test(url) || !serviceKey || !publicKey) throw new Error("O administrador precisa configurar as variáveis Supabase no Netlify.");
  return { url, serviceKey, publicKey };
}
function getOriginError(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  const host = headers["x-forwarded-host"] || headers.host;
  if (!origin || !host || origin === "null") return null;
  try {
    if (new URL(origin).host.toLowerCase() !== String(host).split(",")[0].trim().toLowerCase()) return "Origem não autorizada.";
  } catch (_) { return "Origem inválida."; }
  return null;
}
async function callSupabase(path, options, usePublicKey) {
  const cfg = config();
  const key = usePublicKey ? cfg.publicKey : cfg.serviceKey;
  const init = options || {};
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (!/^sb_(?:publishable|secret)_/i.test(key)) headers.Authorization = "Bearer " + key;
  init.headers = Object.assign(headers, init.headers || {});
  const response = await fetch(cfg.url + path, init);
  const body = await response.json().catch(function () { return {}; });
  if (!response.ok) {
    const error = new Error(body.msg || body.message || body.error_description || body.error || "Falha ao acessar o banco de dados.");
    error.status = response.status;
    throw error;
  }
  return body;
}
async function db(path, method, body, prefer) {
  const headers = {};
  if (prefer) headers.Prefer = prefer;
  return callSupabase("/rest/v1/" + path, { method: method || "GET", headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
function signAdmin(payload) {
  const secret = String(process.env.ROTA_SESSION_SECRET || "");
  if (secret.length < 32) throw new Error("Configure ROTA_SESSION_SECRET no Netlify com pelo menos 32 caracteres aleatórios.");
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return data + "." + signature;
}
function verifyAdmin(event) {
  const secret = String(process.env.ROTA_SESSION_SECRET || "");
  if (secret.length < 32) return false;
  const headers = event.headers || {};
  const token = String(headers["x-rota-admin-session"] || headers["X-Rota-Admin-Session"] || "");
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], "base64url"); } catch (_) { return false; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload.role === "admin" && payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) { return false; }
}
function requireAdmin(event) { if (!verifyAdmin(event)) throw Object.assign(new Error("Sessão administrativa inválida ou expirada."), { status: 401 }); }
function getTicketTable(kind) {
  if (kind === "ouvidoria") return "ouvidoria_tickets";
  if (kind === "bo") return "bo_tickets";
  throw Object.assign(new Error("Tipo de ticket inválido."), { status: 400 });
}
async function createAccessRequest(input, requestType) {
  const name = clean(input.name, 80);
  const normalized = normalizeName(name);
  if (name.length < 2 || normalized.length < 2) throw Object.assign(new Error("Informe seu nome para continuar."), { status: 400 });
  const row = { display_name: name, normalized_name: normalized, request_type: requestType, status: "Pendente" };
  try { await db("access_requests", "POST", row, "return=minimal"); }
  catch (error) {
    if (error.status === 409 || /duplicate|unique/i.test(error.message)) return { ok: true, message: requestType === "acesso" ? "Se o nome foi enviado, a solicitação está aguardando análise." : "Se houver uma conta com este nome, a solicitação está aguardando análise." };
    throw error;
  }
  return { ok: true, message: requestType === "acesso" ? "Pedido enviado. Aguarde a aprovação da administração da ROTA." : "Pedido enviado. Se a conta existir, a administração poderá gerar um novo token." };
}
async function officerLogin(input) {
  const normalized = normalizeName(input.name);
  const token = clean(input.token, 100);
  if (normalized.length < 2 || token.length < 12) throw Object.assign(new Error("Informe seu nome e o token recebido da administração."), { status: 400 });
  let session;
  try {
    session = await callSupabase("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email: syntheticEmail(normalized), password: token }) }, true);
  } catch (error) {
    if (error.status === 400 || error.status === 401) throw Object.assign(new Error("Nome ou token incorreto. Se esqueceu o token, solicite uma troca."), { status: 401 });
    throw error;
  }
  const members = await db("police_users?select=user_id,display_name,normalized_name,role,enabled&user_id=eq." + encodeURIComponent(session.user.id) + "&enabled=eq.true", "GET");
  if (!Array.isArray(members) || !members.length) throw Object.assign(new Error("Esta conta não está autorizada. Peça aprovação à administração."), { status: 403 });
  await db("login_events", "POST", { user_id: session.user.id, display_name: members[0].display_name, role: members[0].role || "policial", logged_at: new Date().toISOString() }, "return=minimal");
  session.user.user_metadata = session.user.user_metadata || {};
  session.user.user_metadata.full_name = members[0].display_name;
  session.user.user_metadata.role = members[0].role || "policial";
  return { session: session };
}
async function adminLogin(input) {
  // Fail before issuing an admin session if the backing project is incomplete.
  config();
  const expectedUser = String(process.env.ROTA_ADMIN_USERNAME || "derickadm");
  const expectedPassword = String(process.env.ROTA_ADMIN_PASSWORD || "");
  if (expectedPassword.length < 12) throw Object.assign(new Error("Defina uma senha administrativa forte na variável ROTA_ADMIN_PASSWORD do Netlify."), { status: 503 });
  const submittedUser = clean(input.username, 60);
  const submittedPassword = Buffer.from(String(input.password || ""), "utf8");
  const expectedBuffer = Buffer.from(expectedPassword, "utf8");
  const userOk = submittedUser.toLowerCase() === expectedUser.toLowerCase();
  const passOk = submittedPassword.length === expectedBuffer.length && crypto.timingSafeEqual(submittedPassword, expectedBuffer);
  if (!userOk || !passOk) throw Object.assign(new Error("Usuário ou senha administrativa incorretos."), { status: 401 });
  return { adminToken: signAdmin({ role: "admin", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }) };
}
async function dashboard() {
  const requests = await db("access_requests?select=id,display_name,normalized_name,request_type,status,created_at&order=created_at.desc&limit=150", "GET");
  const officers = await db("police_users?select=user_id,display_name,normalized_name,role,enabled,created_at&order=display_name.asc&limit=300", "GET");
  const logins = await db("login_events?select=id,user_id,display_name,role,logged_at&order=logged_at.desc&limit=40", "GET");
  return { requests: requests || [], officers: officers || [], logins: logins || [] };
}
async function issueForOfficer(userId) {
  const rows = await db("police_users?select=user_id,display_name,normalized_name,role,enabled&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
  if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error("Integrante não encontrado."), { status: 404 });
  if (!rows[0].enabled) throw Object.assign(new Error("Esta conta está desativada. Reative antes de trocar o token."), { status: 409 });
  const token = randomToken();
  await callSupabase("/auth/v1/admin/users/" + encodeURIComponent(userId), { method: "PUT", body: JSON.stringify({ password: token }) });
  await db("access_requests?normalized_name=eq." + encodeURIComponent(rows[0].normalized_name) + "&request_type=eq.troca_token&status=eq.Pendente", "PATCH", { status: "Aprovado", decided_at: new Date().toISOString() }, "return=minimal");
  return { ok: true, displayName: rows[0].display_name, token: token };
}
async function handleAdmin(event, input) {
  requireAdmin(event);
  if (input.action === "admin-session") return { valid: true };
  if (input.action === "admin-dashboard") return dashboard();
  if (input.action === "tickets-list") {
    const table = getTicketTable(input.kind);
    const rows = await db(table + "?select=id,public_id,discord,player,legacy_name,reason,category,detail,status,created_at,decision_at&order=created_at.desc&limit=300", "GET");
    return { rows: rows || [] };
  }
  if (input.action === "ticket-decide") {
    const table = getTicketTable(input.kind);
    const status = input.status === "Aceito" || input.status === "Recusado" ? input.status : "";
    const publicId = clean(input.publicId, 32);
    if (!status || !publicId) throw Object.assign(new Error("Decisão inválida."), { status: 400 });
    const rows = await db(table + "?public_id=eq." + encodeURIComponent(publicId) + "&status=eq.Pendente", "PATCH", { status: status, decision_at: new Date().toISOString() }, "return=representation");
    if (!Array.isArray(rows) || !rows.length) throw Object.assign(new Error("Este ticket já foi decidido ou não está disponível."), { status: 409 });
    return { row: rows[0] };
  }
  if (input.action === "request-decide") {
    const id = clean(input.id, 60);
    const decision = input.status === "Aprovado" || input.status === "Recusado" ? input.status : "";
    if (!id || !decision) throw Object.assign(new Error("Solicitação ou decisão inválida."), { status: 400 });
    const requests = await db("access_requests?select=id,display_name,normalized_name,request_type,status&id=eq." + encodeURIComponent(id) + "&limit=1", "GET");
    if (!requests.length || requests[0].status !== "Pendente") throw Object.assign(new Error("Solicitação não encontrada ou já analisada."), { status: 409 });
    const request = requests[0];
    if (request.request_type === "acesso" && decision === "Aprovado") {
      const existing = await db("police_users?select=user_id&normalized_name=eq." + encodeURIComponent(request.normalized_name) + "&limit=1", "GET");
      if (existing.length) throw Object.assign(new Error("Já existe uma conta policial com este nome. Use a opção de troca de token."), { status: 409 });
      const token = randomToken();
      let created;
      try {
        created = await callSupabase("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email: syntheticEmail(request.normalized_name), password: token, email_confirm: true, user_metadata: { full_name: request.display_name, name: request.display_name, role: "policial" }, app_metadata: { role: "policial" } }) });
        await db("police_users", "POST", { user_id: created.id, display_name: request.display_name, normalized_name: request.normalized_name, login_email: syntheticEmail(request.normalized_name), role: "policial", enabled: true }, "return=minimal");
        await db("access_requests?id=eq." + encodeURIComponent(id), "PATCH", { status: "Aprovado", decided_at: new Date().toISOString() }, "return=minimal");
      } catch (error) {
        if (created && created.id) await callSupabase("/auth/v1/admin/users/" + encodeURIComponent(created.id), { method: "DELETE" }).catch(function () {});
        throw error;
      }
      return { ok: true, displayName: request.display_name, token: token };
    }
    if (request.request_type === "troca_token" && decision === "Aprovado") {
      const account = await db("police_users?select=user_id,enabled&normalized_name=eq." + encodeURIComponent(request.normalized_name) + "&limit=1", "GET");
      if (!account.length || !account[0].enabled) throw Object.assign(new Error("Não há conta policial ativa para este pedido de troca."), { status: 404 });
      const result = await issueForOfficer(account[0].user_id);
      return result;
    }
    await db("access_requests?id=eq." + encodeURIComponent(id), "PATCH", { status: decision, decided_at: new Date().toISOString() }, "return=minimal");
    return { ok: true };
  }
  if (input.action === "token-rotate") return issueForOfficer(clean(input.userId, 80));
  if (input.action === "officer-toggle") {
    const userId = clean(input.userId, 80);
    if (!userId) throw Object.assign(new Error("Conta inválida."), { status: 400 });
    const rows = await db("police_users?select=user_id,enabled&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
    if (!rows.length) throw Object.assign(new Error("Conta não encontrada."), { status: 404 });
    const updated = await db("police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { enabled: !rows[0].enabled }, "return=representation");
    return { officer: updated[0] };
  }
  throw Object.assign(new Error("Ação desconhecida."), { status: 400 });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método não permitido." });
  if (event.body && Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
  const originError = getOriginError(event);
  if (originError) return json(403, { error: originError });
  let input;
  try { input = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
  try {
    let result;
    if (input.action === "request-access") result = await createAccessRequest(input, "acesso");
    else if (input.action === "request-reset") result = await createAccessRequest(input, "troca_token");
    else if (input.action === "officer-login") result = await officerLogin(input);
    else if (input.action === "admin-login") result = await adminLogin(input);
    else result = await handleAdmin(event, input);
    return json(200, result || { ok: true });
  } catch (error) {
    const status = error.status || (error.message && /variáveis Supabase|ROTA_SESSION_SECRET/.test(error.message) ? 503 : 500);
    return json(status, { error: error.message || "Erro inesperado." });
  }
};
