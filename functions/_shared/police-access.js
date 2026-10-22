const MAX_BODY_BYTES = 16000;
const SESSION_SECONDS = 8 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function clean(value, limit) {
  return Array.from(String(value || "")).filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 || code === 9;
  }).join("").trim().slice(0, limit);
}

function normalizeName(value) {
  return clean(value, 80).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function syntheticEmail(normalized) {
  return "rota." + normalized + "@members.invalid";
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function config(env) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const serviceKey = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const publicKey = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  if (!/^https:\/\//i.test(url) || !serviceKey || !publicKey) {
    throw new Error("O administrador precisa configurar as variáveis Supabase na hospedagem.");
  }
  return { url, serviceKey, publicKey };
}

function getOriginError(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  try {
    const requestHost = new URL(request.url).host.toLowerCase();
    if (new URL(origin).host.toLowerCase() !== requestHost) return "Origem não autorizada.";
  } catch (_) {
    return "Origem inválida.";
  }
  return null;
}

async function callSupabase(env, path, options, usePublicKey) {
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

async function db(env, path, method, body, prefer) {
  const headers = {};
  if (prefer) headers.Prefer = prefer;
  return callSupabase(env, "/rest/v1/" + path, {
    method: method || "GET",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function signAdmin(env, payload) {
  const secret = String(env.ROTA_SESSION_SECRET || "");
  if (secret.length < 32) throw new Error("Configure ROTA_SESSION_SECRET com pelo menos 32 caracteres.");
  const data = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
  return data + "." + encodeBase64Url(signature);
}

async function verifyAdmin(request, env) {
  const secret = String(env.ROTA_SESSION_SECRET || "");
  if (secret.length < 32) return false;
  const token = String(request.headers.get("x-rota-admin-session") || "");
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(parts[0])));
    const actual = decodeBase64Url(parts[1]);
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
    if (difference !== 0) return false;
    const payload = JSON.parse(decoder.decode(decodeBase64Url(parts[0])));
    return payload.role === "admin" && payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

async function requireAdmin(request, env) {
  if (!(await verifyAdmin(request, env))) {
    const error = new Error("Sessão administrativa inválida ou expirada.");
    error.status = 401;
    throw error;
  }
}

function fail(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function getTicketTable(kind) {
  if (kind === "ouvidoria") return "ouvidoria_tickets";
  if (kind === "bo") return "bo_tickets";
  throw fail("Tipo de ticket inválido.", 400);
}

async function createAccessRequest(env, input, requestType) {
  const name = clean(input.name, 80);
  const normalized = normalizeName(name);
  if (name.length < 2 || normalized.length < 2) throw fail("Informe seu nome para continuar.", 400);
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

async function officerLogin(env, input) {
  const normalized = normalizeName(input.name);
  const token = clean(input.token, 100);
  if (normalized.length < 2 || token.length < 12) throw fail("Informe seu nome e o token recebido da administração.", 400);
  let session;
  try {
    session = await callSupabase(env, "/auth/v1/token?grant_type=password", {
      method: "POST", body: JSON.stringify({ email: syntheticEmail(normalized), password: token })
    }, true);
  } catch (error) {
    if (error.status === 400 || error.status === 401) throw fail("Nome ou token incorreto. Se esqueceu o token, solicite uma troca.", 401);
    throw error;
  }
  const members = await db(env, "police_users?select=user_id,display_name,normalized_name,role,enabled&user_id=eq." + encodeURIComponent(session.user.id) + "&enabled=eq.true", "GET");
  if (!Array.isArray(members) || !members.length) throw fail("Esta conta não está autorizada. Peça aprovação à administração.", 403);
  await db(env, "login_events", "POST", { user_id: session.user.id, display_name: members[0].display_name, role: members[0].role || "policial", logged_at: new Date().toISOString() }, "return=minimal");
  session.user.user_metadata = session.user.user_metadata || {};
  session.user.user_metadata.full_name = members[0].display_name;
  session.user.user_metadata.role = members[0].role || "policial";
  return { session };
}

async function adminLogin(env, input) {
  config(env);
  const expectedUser = String(env.ROTA_ADMIN_USERNAME || "");
  const expectedPassword = String(env.ROTA_ADMIN_PASSWORD || "");
  if (expectedPassword.length < 12) throw fail("Defina uma senha administrativa forte na variável ROTA_ADMIN_PASSWORD.", 503);
  const submittedUser = clean(input.username, 60);
  const submittedPassword = encoder.encode(String(input.password || ""));
  const expectedBuffer = encoder.encode(expectedPassword);
  const userOk = submittedUser.toLowerCase() === expectedUser.toLowerCase();
  let difference = submittedPassword.length ^ expectedBuffer.length;
  const length = Math.max(submittedPassword.length, expectedBuffer.length);
  for (let i = 0; i < length; i++) difference |= (submittedPassword[i] || 0) ^ (expectedBuffer[i] || 0);
  if (!userOk || difference !== 0) throw fail("Usuário ou senha administrativa incorretos.", 401);
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

async function dashboard(env) {
  const issues = [];
  const [requests, officers, logins, boTickets, ouvidoriaTickets, applications, arrests, blacklist, roster] = await Promise.all([
    dashboardRows(env, "solicitações de acesso", "access_requests?select=id,display_name,normalized_name,request_type,status,created_at&order=created_at.desc&limit=150", issues),
    dashboardRows(env, "contas policiais", "police_users?select=user_id,display_name,normalized_name,role,enabled,created_at&order=display_name.asc&limit=300", issues),
    dashboardRows(env, "histórico de acesso", "login_events?select=id,user_id,display_name,role,logged_at&order=logged_at.desc&limit=40", issues),
    dashboardRows(env, "B.O.", "bo_tickets?select=id,public_id,player,legacy_name,category,status,created_at&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "Ouvidoria", "ouvidoria_tickets?select=id,public_id,player,legacy_name,category,status,created_at&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "candidaturas", "edital_applications?select=id,edital_title,full_name,candidate_name,status,created_at&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "registros de prisão", "arrest_records?select=id,character_name,player_id,officer,created_at&is_active=eq.true&order=created_at.desc&limit=30", issues),
    dashboardRows(env, "blacklist", "rota_blacklist?select=id,character_name,player_id,created_at&is_active=eq.true&order=created_at.desc&limit=100", issues),
    dashboardRows(env, "efetivo ROTA", "rota_roster?select=id,qra,full_name,rank,passport,admitted_on,birth_date,status,photo_path,photo_url,created_at,updated_at&order=qra.asc&limit=500", issues),
  ]);

  return { requests, officers, logins, boTickets, ouvidoriaTickets, applications, arrests, blacklist, roster, dataIssues: issues };
}

async function issueForOfficer(env, userId, reactivate) {
  const rows = await db(env, "police_users?select=user_id,display_name,normalized_name,role,enabled&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
  if (!Array.isArray(rows) || !rows.length) throw fail("Integrante não encontrado.", 404);
  if (!rows[0].enabled && !reactivate) throw fail("Esta conta está desativada. Reative antes de trocar o token.", 409);
  const token = randomToken();
  await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(userId), { method: "PUT", body: JSON.stringify({ password: token }) });
  if (!rows[0].enabled) await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { enabled: true }, "return=minimal");
  await db(env, "access_requests?normalized_name=eq." + encodeURIComponent(rows[0].normalized_name) + "&request_type=eq.troca_token&status=eq.Pendente", "PATCH", { status: "Aprovado", decided_at: new Date().toISOString() }, "return=minimal");
  return { ok: true, displayName: rows[0].display_name, token };
}

async function handleAdmin(request, env, input) {
  await requireAdmin(request, env);
  if (input.action === "admin-session") return { valid: true };
  if (input.action === "admin-dashboard") return dashboard(env);
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
    if (!status || !publicId) throw fail("Decisão inválida.", 400);
    const rows = await db(env, table + "?public_id=eq." + encodeURIComponent(publicId) + "&status=eq.Pendente", "PATCH", { status, decision_at: new Date().toISOString() }, "return=representation");
    if (!Array.isArray(rows) || !rows.length) throw fail("Este ticket já foi decidido ou não está disponível.", 409);
    return { row: rows[0] };
  }
  if (input.action === "request-decide") {
    const id = clean(input.id, 60);
    const decision = input.status === "Aprovado" || input.status === "Recusado" ? input.status : "";
    if (!id || !decision) throw fail("Solicitação ou decisão inválida.", 400);
    const requests = await db(env, "access_requests?select=id,display_name,normalized_name,request_type,status&id=eq." + encodeURIComponent(id) + "&limit=1", "GET");
    if (!requests.length || requests[0].status !== "Pendente") throw fail("Solicitação não encontrada ou já analisada.", 409);
    const requestRow = requests[0];
    if (requestRow.request_type === "acesso" && decision === "Aprovado") {
      const existing = await db(env, "police_users?select=user_id&normalized_name=eq." + encodeURIComponent(requestRow.normalized_name) + "&limit=1", "GET");
      if (existing.length) throw fail("Já existe uma conta policial com este nome. Use a opção de troca de token.", 409);
      const token = randomToken();
      let created;
      try {
        created = await callSupabase(env, "/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email: syntheticEmail(requestRow.normalized_name), password: token, email_confirm: true, user_metadata: { full_name: requestRow.display_name, name: requestRow.display_name, role: "policial" }, app_metadata: { role: "policial" } }) });
        await db(env, "police_users", "POST", { user_id: created.id, display_name: requestRow.display_name, normalized_name: requestRow.normalized_name, login_email: syntheticEmail(requestRow.normalized_name), role: "policial", enabled: true }, "return=minimal");
        await db(env, "access_requests?id=eq." + encodeURIComponent(id), "PATCH", { status: "Aprovado", decided_at: new Date().toISOString() }, "return=minimal");
      } catch (error) {
        if (created && created.id) {
          await db(env, "police_users?user_id=eq." + encodeURIComponent(created.id), "DELETE", undefined, "return=minimal").catch(() => {});
          await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(created.id), { method: "DELETE" }).catch(() => {});
        }
        throw error;
      }
      return { ok: true, displayName: requestRow.display_name, token };
    }
    if (requestRow.request_type === "troca_token" && decision === "Aprovado") {
      const account = await db(env, "police_users?select=user_id,enabled&normalized_name=eq." + encodeURIComponent(requestRow.normalized_name) + "&limit=1", "GET");
      if (!account.length) throw fail("Não há conta policial para este pedido de troca.", 404);
      return issueForOfficer(env, account[0].user_id, true);
    }
    await db(env, "access_requests?id=eq." + encodeURIComponent(id), "PATCH", { status: decision, decided_at: new Date().toISOString() }, "return=minimal");
    return { ok: true };
  }
  if (input.action === "token-rotate") return issueForOfficer(env, clean(input.userId, 80));
  if (input.action === "officer-toggle") {
    const userId = clean(input.userId, 80);
    if (!userId) throw fail("Conta inválida.", 400);
    const rows = await db(env, "police_users?select=user_id,enabled&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
    if (!rows.length) throw fail("Conta não encontrada.", 404);
    const updated = await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { enabled: !rows[0].enabled }, "return=representation");
    return { officer: updated[0] };
  }
  throw fail("Ação desconhecida.", 400);
}

export async function handlePoliceAccess(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const originError = getOriginError(request);
  if (originError) return json(403, { error: originError });
  const bodyText = await request.text();
  if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
  let input;
  try { input = JSON.parse(bodyText || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
  try {
    let result;
    if (input.action === "request-access") result = await createAccessRequest(env, input, "acesso");
    else if (input.action === "request-reset") result = await createAccessRequest(env, input, "troca_token");
    else if (input.action === "officer-login") result = await officerLogin(env, input);
    else if (input.action === "admin-login") result = await adminLogin(env, input);
    else result = await handleAdmin(request, env, input);
    return json(200, result || { ok: true });
  } catch (error) {
    const status = error.status || (/variáveis Supabase|ROTA_SESSION_SECRET/.test(error.message || "") ? 503 : 500);
    return json(status, { error: error.message || "Erro inesperado." });
  }
}
