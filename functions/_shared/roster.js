import { requireAdmin, supabase } from "./blacklist.js";

const PHOTO_BUCKET = "rota-roster-photos";
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const encoder = new TextEncoder();

function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
function fail(message, status) { return Object.assign(new Error(message), { status }); }
function clean(value, limit) {
  return Array.from(String(value || "")).filter((character) => { const code = character.charCodeAt(0); return code >= 32 || code === 9; }).join("").trim().slice(0, limit);
}
function originError(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  try { if (new URL(origin).host.toLowerCase() !== new URL(request.url).host.toLowerCase()) return "Origem não autorizada."; }
  catch (_) { return "Origem inválida."; }
  return null;
}
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function toRow(row) {
  return { id: row.id, qra: row.qra, fullName: row.full_name, rank: row.rank, passport: row.passport, admittedOn: row.admitted_on, birthDate: row.birth_date, status: row.status, photoPath: row.photo_path, photoUrl: row.photo_url, createdAt: row.created_at, updatedAt: row.updated_at };
}
function photoUrl(env, path) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  if (!/^https:\/\//i.test(url)) throw fail("O administrador precisa configurar as variáveis Supabase na hospedagem.", 503);
  return url + "/storage/v1/object/public/" + PHOTO_BUCKET + "/" + path;
}
function validPhotoPath(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/i.test(value);
}

export async function handleRoster(request, env) {
  if (!["GET", "POST"].includes(request.method)) return json(405, { error: "Método não permitido." });
  if (request.method !== "GET") {
    const rejected = originError(request);
    if (rejected) return json(403, { error: rejected });
  }
  try {
    if (request.method === "GET") {
      const rows = await supabase(env, "/rest/v1/rota_roster?select=id,qra,full_name,rank,passport,admitted_on,birth_date,status,photo_path,photo_url,created_at,updated_at&order=qra.asc&limit=500", { method: "GET" }, true);
      return json(200, { rows: (Array.isArray(rows) ? rows : []).map(toRow) });
    }
    await requireAdmin(request, env);
    const text = await request.text();
    if (encoder.encode(text).byteLength > 12000) return json(413, { error: "Solicitação muito grande." });
    let input;
    try { input = JSON.parse(text || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
    const qra = clean(input.qra, 40), fullName = clean(input.fullName, 100), rank = clean(input.rank, 60), passport = clean(input.passport, 40), admittedOn = clean(input.admittedOn, 10), birthDate = clean(input.birthDate, 10), status = input.status === "Inativo" ? "Inativo" : input.status === "Ativo" ? "Ativo" : "", id = clean(input.id, 36);
    if (qra.length < 2 || fullName.length < 3 || rank.length < 2 || !passport || !validDate(admittedOn) || !validDate(birthDate) || !status) return json(400, { error: "Preencha QRA, nome, patente, passaporte, datas e situação." });
    if (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return json(400, { error: "Identificador de efetivo inválido." });
    const photoPath = clean(input.photoPath, 64);
    let existing = null;
    if (id) {
      const prior = await supabase(env, "/rest/v1/rota_roster?select=id,photo_path&id=eq." + encodeURIComponent(id) + "&limit=1", { method: "GET" });
      if (!Array.isArray(prior) || !prior.length) return json(404, { error: "Integrante não encontrado." });
      existing = prior[0];
    }
    const chosenPhoto = photoPath || (existing && existing.photo_path) || "";
    if (!validPhotoPath(chosenPhoto)) return json(400, { error: "Envie uma foto válida do policial." });
    const payload = { qra, full_name: fullName, rank, passport, admitted_on: admittedOn, birth_date: birthDate, status, photo_path: chosenPhoto, photo_url: photoUrl(env, chosenPhoto), updated_at: new Date().toISOString() };
    const endpoint = id ? "/rest/v1/rota_roster?id=eq." + encodeURIComponent(id) : "/rest/v1/rota_roster";
    const rows = await supabase(env, endpoint, { method: id ? "PATCH" : "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(payload) });
    if (!Array.isArray(rows) || !rows.length) throw fail("O efetivo não foi salvo.", 500);
    return json(id ? 200 : 201, { row: toRow(rows[0]) });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : (/variáveis Supabase/.test(error.message || "") ? 503 : 500);
    return json(status, { error: error.message || "Erro inesperado." });
  }
}

export async function handleRosterPhoto(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const rejected = originError(request);
  if (rejected) return json(403, { error: rejected });
  try {
    await requireAdmin(request, env);
    const declaredSize = Number(request.headers.get("content-length") || 0);
    if (declaredSize > MAX_PHOTO_BYTES + 65536) return json(413, { error: "A foto deve ter no máximo 3 MB." });
    const form = await request.formData(), file = form.get("photo");
    if (!file || typeof file.arrayBuffer !== "function") return json(400, { error: "Escolha a foto do policial." });
    if (file.size < 1 || file.size > MAX_PHOTO_BYTES) return json(413, { error: "A foto deve ter no máximo 3 MB." });
    const mime = String(file.type || "").toLowerCase(), extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }, ext = extensions[mime];
    if (!ext) return json(400, { error: "Use uma imagem JPG, PNG ou WebP." });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const valid = (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) || (mime === "image/png" && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) || (mime === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP");
    if (!valid) return json(400, { error: "O arquivo não parece ser uma imagem válida." });
    const base = String(env.SUPABASE_URL || "").trim().replace(/\/$/, ""), path = crypto.randomUUID() + "." + ext;
    if (!/^https:\/\//i.test(base)) throw fail("O administrador precisa configurar as variáveis Supabase na hospedagem.", 503);
    const secret = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!secret) throw fail("Configure a chave secreta do Supabase nas Functions.", 503);
    const headers = { apikey: secret, "Content-Type": mime, "cache-control": "public, max-age=31536000, immutable", "x-upsert": "false" };
    if (!/^sb_(?:publishable|secret)_/i.test(secret)) headers.Authorization = "Bearer " + secret;
    const response = await fetch(base + "/storage/v1/object/" + PHOTO_BUCKET + "/" + path, { method: "POST", headers, body: bytes });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw fail(problem.message || problem.error || "Não foi possível salvar a foto no Supabase Storage.", response.status);
    }
    return json(201, { photoPath: path, photoUrl: photoUrl(env, path) });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : (/variáveis Supabase/.test(error.message || "") ? 503 : 500);
    return json(status, { error: error.message || "Não foi possível enviar a foto." });
  }
}
