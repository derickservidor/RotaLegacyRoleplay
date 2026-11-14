// Foto do personagem (avatar): a própria conta envia/troca; na recepção vai junto do pedido (pelo bilhete);
// quem tem o poder Acessos remove a foto de quem está abaixo. Sem foto, o site mostra a logo da ROTA.
import { clean, fail, json, originError, publicMessage, technical } from "./http.js";
import { outranks, requireAccount, requireStaff, rosterRank } from "./auth.js";
import { rankLevel } from "./permissions.js";
import { db } from "./police-access.js";
import { audit } from "./members.js";
import { requestByTicket } from "./reception.js";

const BUCKET = "rota-avatars";
const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function storage(env) {
  const base = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const secret = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!/^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)[:/])/i.test(base) || !secret) throw fail(503, "O administrador precisa configurar as variáveis Supabase na hospedagem.");
  const headers = { apikey: secret };
  if (!/^sb_(?:publishable|secret)_/i.test(secret)) headers.Authorization = "Bearer " + secret;
  return { base, headers };
}
function publicUrl(env, path) { return storage(env).base + "/storage/v1/object/public/" + BUCKET + "/" + path; }

// Mesma validação das fotos do efetivo: tipo, tamanho e assinatura real do arquivo.
async function storeImage(env, file) {
  if (!file || typeof file.arrayBuffer !== "function") throw fail(400, "Escolha a foto do personagem.");
  if (file.size < 1 || file.size > MAX_BYTES) throw fail(413, "A foto deve ter no máximo 3 MB.");
  const mime = String(file.type || "").toLowerCase(), ext = TYPES[mime];
  if (!ext) throw fail(400, "Use uma imagem JPG, PNG ou WebP.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const valid = (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (mime === "image/png" && bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    || (mime === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP");
  if (!valid) throw fail(400, "O arquivo não parece ser uma imagem válida.");
  const { base, headers } = storage(env), path = crypto.randomUUID() + "." + ext;
  const response = await fetch(base + "/storage/v1/object/" + BUCKET + "/" + path, { method: "POST", headers: { ...headers, "Content-Type": mime, "cache-control": "public, max-age=31536000, immutable", "x-upsert": "false" }, body: bytes });
  if (!response.ok) { const problem = await response.json().catch(() => ({})); throw technical(response.status, "Não foi possível salvar a foto.", "storage: " + (problem.message || problem.error || "")); }
  return { photo_path: path, photo_url: publicUrl(env, path) };
}
export async function deleteImage(env, path) {
  if (!path || !/^[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(path)) return;
  try { const { base, headers } = storage(env); await fetch(base + "/storage/v1/object/" + BUCKET, { method: "DELETE", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [path] }) }); } catch (_) {}
}

export async function handleAvatar(request, env) {
  const rejected = originError(request);
  if (rejected) return json(403, { error: rejected });
  try {
    if (request.method === "POST") {
      if (Number(request.headers.get("content-length") || 0) > MAX_BYTES + 65536) return json(413, { error: "A foto deve ter no máximo 3 MB." });
      const form = await request.formData(), ticket = clean(form.get("ticket"), 80);
      if (ticket) {
        // Foto enviada junto do pedido na recepção (ainda não há conta).
        const req = await requestByTicket(env, ticket);
        if (req.status !== "Pendente" && req.status !== "Em atendimento") throw fail(409, "Este pedido já foi resolvido.");
        const saved = await storeImage(env, form.get("photo"));
        await db(env, "access_requests?id=eq." + encodeURIComponent(req.id), "PATCH", saved, "return=minimal");
        await deleteImage(env, req.photo_path);
        return json(201, { photoUrl: saved.photo_url });
      }
      const member = await requireAccount(request, env);
      const current = await db(env, "police_users?select=photo_path&user_id=eq." + encodeURIComponent(member.user_id) + "&limit=1", "GET");
      const saved = await storeImage(env, form.get("photo"));
      await db(env, "police_users?user_id=eq." + encodeURIComponent(member.user_id), "PATCH", saved, "return=minimal");
      await deleteImage(env, current[0] && current[0].photo_path);
      return json(201, { photoUrl: saved.photo_url });
    }
    if (request.method === "DELETE") {
      const actor = await requireStaff(request, env);
      if (actor.role !== "admin" && !actor.permissions.includes("acessos.gerenciar")) throw fail(403, "Remover a foto de outra pessoa exige o poder Acessos.");
      const input = await request.json().catch(() => ({}));
      const userId = clean(input.userId, 36);
      if (!/^[0-9a-f-]{36}$/i.test(userId)) throw fail(400, "Conta inválida.");
      const rows = await db(env, "police_users?select=user_id,display_name,login_id,roster_id,photo_path&user_id=eq." + encodeURIComponent(userId) + "&limit=1", "GET");
      if (!rows.length) throw fail(404, "Conta não encontrada.");
      if (!outranks(actor, rankLevel(await rosterRank(env, rows[0].roster_id)))) throw fail(403, "Você só pode agir sobre integrantes de patente menor que a sua.");
      await db(env, "police_users?user_id=eq." + encodeURIComponent(userId), "PATCH", { photo_path: "", photo_url: "" }, "return=minimal");
      await deleteImage(env, rows[0].photo_path);
      await audit(env, { action: "remover-foto", result: "concluida", target_user: userId, target_login_id: rows[0].login_id || "", target_name: rows[0].display_name || "", reason: clean(input.reason, 300), actor_login_id: actor.loginId || (actor.role === "admin" ? "adm" : ""), actor_name: actor.role === "admin" ? "Administração" : actor.name || "" });
      return json(200, { ok: true });
    }
    return json(405, { error: "Método não permitido." });
  } catch (error) {
    return json(error.status || 500, { error: publicMessage(error) });
  }
}
