import { clean, json, originError, publicMessage, technical } from "./http.js";
import { outranks, requirePermission, rosterRank } from "./auth.js";
import { rankLevel } from "./permissions.js";
import { configuration, supabase } from "./supabase.js";
import { audit, blacklistInsert, cleanLoginId, verifyActor } from "./members.js";
const MAX_BODY_BYTES = 5000;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const PHOTO_BUCKET = "rota-blacklist-photos";
const encoder = new TextEncoder();

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
    const staff = await requirePermission(request, env, "blacklist.gerenciar"), bodyText = await request.text();
    if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
    let input; try { input = JSON.parse(bodyText || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
    if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
    if (request.method === "POST") {
      // Inclusão: nome, ID, motivo detalhado, ciência das consequências, confirmação e ID + senha de quem inclui.
      const characterName = clean(input.characterName, 80), playerId = cleanLoginId(input.playerId), photoPath = clean(input.photoPath, 64), reason = clean(input.reason, 500, true);
      if (characterName.length < 2 || !playerId) return json(400, { error: "Preencha o nome do personagem e o ID no servidor (só números)." });
      if (photoPath && !validPhotoPath(photoPath)) return json(400, { error: "Envie uma foto válida ou deixe sem foto." });
      if (reason.length < 15) return json(400, { error: "Escreva o motivo detalhado da inclusão (pelo menos 15 caracteres)." });
      if (input.understood !== true || input.confirm !== true) return json(400, { error: "Confirme que entende as consequências e a inclusão definitiva." });
      // Se o ID pertence a uma conta ativa, só quem está acima dela pode bloqueá-la.
      if (staff.role !== "admin") {
        const owner = await supabase(env, "/rest/v1/police_users?select=roster_id&login_id=eq." + encodeURIComponent(playerId) + "&removed_at=is.null&limit=1", { method: "GET" }).catch(() => []);
        if (Array.isArray(owner) && owner.length && !outranks(staff, rankLevel(await rosterRank(env, owner[0].roster_id)))) return json(403, { error: "Este ID é de um integrante de patente igual ou maior que a sua." });
      }
      const who = await verifyActor(env, request, staff, input, "blacklist-incluir");
      const cfg = configuration(env), photoUrl = photoPath ? cfg.url + "/storage/v1/object/public/" + PHOTO_BUCKET + "/" + photoPath : "";
      const row = await blacklistInsert(env, { character_name: characterName, player_id: playerId, photo_path: photoPath, photo_url: photoUrl, reason, created_by: staff.id || null, created_by_name: who.name, created_by_login: who.loginId });
      await audit(env, { action: "blacklist-incluir", result: "concluida", target_login_id: playerId, target_name: characterName, reason, actor_login_id: who.loginId, actor_name: who.name });
      return json(201, { row: row ? publicRow(row) : null });
    }
    const id = clean(input.id, 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return json(400, { error: "Registro inválido." });
    // Retirada: justificativa, confirmação e ID + senha de quem retira.
    const justification = clean(input.reason, 500, true);
    if (justification.length < 10) return json(400, { error: "Escreva a justificativa da retirada (pelo menos 10 caracteres)." });
    if (input.confirm !== true) return json(400, { error: "Confirme a retirada da Blacklist." });
    const existing = await supabase(env, "/rest/v1/rota_blacklist?select=photo_path,player_id,character_name&id=eq." + encodeURIComponent(id) + "&is_active=eq.true&limit=1", { method: "GET" });
    if (!Array.isArray(existing) || !existing.length) return json(404, { error: "Registro não encontrado ou já removido." });
    const who = await verifyActor(env, request, staff, input, "blacklist-retirar");
    const rows = await supabase(env, "/rest/v1/rota_blacklist?id=eq." + encodeURIComponent(id) + "&is_active=eq.true", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ is_active: false, removed_at: new Date().toISOString(), removed_by: staff.id || null, removed_by_name: who.name, removal_reason: justification }) });
    if (Array.isArray(rows) && rows.length) await audit(env, { action: "blacklist-retirar", result: "concluida", target_login_id: existing[0].player_id, target_name: existing[0].character_name, reason: justification, actor_login_id: who.loginId, actor_name: who.name });
    if (!Array.isArray(rows) || !rows.length) return json(404, { error: "Registro não encontrado ou já removido." });
    await deleteStoredPhoto(env, existing && existing[0] && existing[0].photo_path);
    return json(200, { ok: true });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : (/variáveis Supabase/.test(error.message || "") ? 503 : 500);
    return json(status, { error: publicMessage(error) });
  }
}
export async function handleBlacklistPhoto(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const rejected = originError(request); if (rejected) return json(403, { error: rejected });
  try {
    await requirePermission(request, env, "blacklist.gerenciar");
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
      throw technical(response.status, "Não foi possível salvar a foto.", "storage: " + (problem.message || problem.error || ""));
    }
    return json(201, { photoPath, photoUrl: cfg.url + "/storage/v1/object/public/" + PHOTO_BUCKET + "/" + photoPath });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : (/variáveis Supabase/.test(error.message || "") ? 503 : 500);
    return json(status, { error: publicMessage(error) });
  }
}
