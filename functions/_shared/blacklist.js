const MAX_BODY_BYTES = 5000;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const PHOTO_BUCKET = "rota-blacklist-photos";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function clean(value, limit) {
  return Array.from(String(value || "")).filter((character) => { const code = character.charCodeAt(0); return code >= 32 || code === 9; }).join("").trim().slice(0, limit);
}
function configuration(env, requireServiceKey) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const serviceKey = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  const publicKey = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  if (!/^https:\/\//i.test(url) || (requireServiceKey !== false && !serviceKey) || !publicKey) throw Object.assign(new Error("O administrador precisa configurar as variáveis Supabase na hospedagem."), { status: 503 });
  return { url, serviceKey, publicKey };
}
function originError(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  try { if (new URL(origin).host.toLowerCase() !== new URL(request.url).host.toLowerCase()) return "Origem não autorizada."; }
  catch (_) { return "Origem inválida."; }
  return null;
}
function decodeBase64Url(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
async function verifyAdmin(request, env) {
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
export async function supabase(env, endpoint, options, usePublic) {
  const cfg = configuration(env, !usePublic), key = usePublic ? cfg.publicKey : cfg.serviceKey, init = options || {};
  const headers = { apikey: key, "Content-Type": "application/json", ...(init.headers || {}) };
  if (!headers.Authorization && !/^sb_(?:publishable|secret)_/i.test(key)) headers.Authorization = "Bearer " + key;
  init.headers = headers;
  const response = await fetch(cfg.url + endpoint, init), body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || body.msg || body.error_description || body.error || "Falha ao acessar o Supabase."), { status: response.status });
  return body;
}
export async function requireAdmin(request, env) {
  if (await verifyAdmin(request, env)) return { id: null, role: "admin" };
  throw Object.assign(new Error("Somente o administrador pode fazer esta alteração."), { status: 401 });
}
export async function requireStaff(request, env) {
  if (await verifyAdmin(request, env)) return { id: null, role: "admin" };
  const authorization = String(request.headers.get("authorization") || ""), match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error("Entre com uma conta policial autorizada para acessar este recurso."), { status: 401 });
  const cfg = configuration(env), token = match[1];
  const userResponse = await fetch(cfg.url + "/auth/v1/user", { headers: { apikey: cfg.publicKey, Authorization: "Bearer " + token } });
  const user = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok || !user.id) throw Object.assign(new Error("Sessão policial inválida ou expirada."), { status: 401 });
  const members = await supabase(env, "/rest/v1/police_users?select=user_id,role,enabled&user_id=eq." + encodeURIComponent(user.id) + "&enabled=eq.true&limit=1", { method: "GET" });
  if (!Array.isArray(members) || !members.length) throw Object.assign(new Error("Esta conta não está autorizada para acessar este recurso."), { status: 403 });
  return { id: user.id, role: members[0].role || "policial" };
}
function publicRow(row) {
  return { id: row.id, characterName: row.character_name, playerId: row.player_id, photoUrl: row.photo_url || "", createdAt: row.created_at };
}
function storageHeaders(cfg, contentType) {
  const headers = { apikey: cfg.serviceKey, "Content-Type": contentType || "application/json" };
  if (!/^sb_(?:publishable|secret)_/i.test(cfg.serviceKey)) headers.Authorization = "Bearer " + cfg.serviceKey;
  return headers;
}
async function deleteStoredPhoto(env, path) {
  if (!path) return;
  try {
    const cfg = configuration(env);
    await fetch(cfg.url + "/storage/v1/object/" + PHOTO_BUCKET, {
      method: "DELETE",
      headers: storageHeaders(cfg),
      body: JSON.stringify({ prefixes: [path] })
    });
  } catch (_) { /* A retirada da lista não deve falhar se a limpeza do arquivo estiver indisponível. */ }
}
function validPhotoPath(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i.test(value);
}
export async function handleBlacklist(request, env) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) return json(405, { error: "Método não permitido." });
  if (request.method !== "GET") { const rejected = originError(request); if (rejected) return json(403, { error: rejected }); }
  try {
    if (request.method === "GET") {
      const rows = await supabase(env, "/rest/v1/rota_blacklist?select=id,character_name,player_id,photo_url,created_at,is_active&is_active=eq.true&order=created_at.desc&limit=500", { method: "GET" }, true);
      return json(200, { rows: (Array.isArray(rows) ? rows : []).map(publicRow) });
    }
    const staff = await requireAdmin(request, env), bodyText = await request.text();
    if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
    let input; try { input = JSON.parse(bodyText || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
    if (request.method === "POST") {
      const characterName = clean(input.characterName, 80), playerId = clean(input.playerId, 24), photoPath = clean(input.photoPath, 64);
      if (characterName.length < 2 || !playerId || !validPhotoPath(photoPath)) return json(400, { error: "Preencha o nome, o passaporte Legacy e envie uma foto válida." });
      const cfg = configuration(env), photoUrl = cfg.url + "/storage/v1/object/public/" + PHOTO_BUCKET + "/" + photoPath;
      const rows = await supabase(env, "/rest/v1/rota_blacklist", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ character_name: characterName, player_id: playerId, photo_path: photoPath, photo_url: photoUrl, reason: "Inclusão administrativa na blacklist RP.", created_by: staff.id }) });
      return json(201, { row: Array.isArray(rows) && rows.length ? publicRow(rows[0]) : null });
    }
    const id = clean(input.id, 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return json(400, { error: "Registro inválido." });
    const existing = await supabase(env, "/rest/v1/rota_blacklist?select=photo_path&id=eq." + encodeURIComponent(id) + "&is_active=eq.true&limit=1", { method: "GET" });
    const rows = await supabase(env, "/rest/v1/rota_blacklist?id=eq." + encodeURIComponent(id) + "&is_active=eq.true", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ is_active: false, removed_at: new Date().toISOString(), removed_by: staff.id }) });
    if (!Array.isArray(rows) || !rows.length) return json(404, { error: "Registro não encontrado ou já removido." });
    await deleteStoredPhoto(env, existing && existing[0] && existing[0].photo_path);
    return json(200, { ok: true });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : (/variáveis Supabase/.test(error.message || "") ? 503 : 500);
    return json(status, { error: error.message || "Erro inesperado." });
  }
}
export async function handleBlacklistPhoto(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const rejected = originError(request); if (rejected) return json(403, { error: rejected });
  try {
    await requireAdmin(request, env);
    const declaredSize = Number(request.headers.get("content-length") || 0);
    if (declaredSize > MAX_PHOTO_BYTES + 65536) return json(413, { error: "A foto é grande demais. Envie uma imagem de até 3 MB." });
    const form = await request.formData(), file = form.get("photo");
    if (!file || typeof file.arrayBuffer !== "function") return json(400, { error: "Escolha a foto do personagem." });
    if (file.size < 1 || file.size > MAX_PHOTO_BYTES) return json(413, { error: "A foto deve ter no máximo 3 MB." });
    const mime = String(file.type || "").toLowerCase();
    const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
    const ext = extensions[mime];
    if (!ext) return json(400, { error: "Use uma imagem JPG, PNG ou WebP." });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isJpeg = mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = mime === "image/png" && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isWebp = mime === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!isJpeg && !isPng && !isWebp) return json(400, { error: "O arquivo não parece ser uma imagem válida." });
    const cfg = configuration(env), photoPath = crypto.randomUUID() + "." + ext;
    const response = await fetch(cfg.url + "/storage/v1/object/" + PHOTO_BUCKET + "/" + photoPath, {
      method: "POST",
      headers: { ...storageHeaders(cfg, mime), "cache-control": "public, max-age=31536000, immutable", "x-upsert": "false" },
      body: bytes
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw Object.assign(new Error(problem.message || problem.error || "Não foi possível salvar a foto no Supabase Storage."), { status: response.status });
    }
    return json(201, { photoPath, photoUrl: cfg.url + "/storage/v1/object/public/" + PHOTO_BUCKET + "/" + photoPath });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : (/variáveis Supabase/.test(error.message || "") ? 503 : 500);
    return json(status, { error: error.message || "Não foi possível enviar a foto." });
  }
}
