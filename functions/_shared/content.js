import { clean, json, originError, publicMessage } from "./http.js";
import { requirePermission } from "./auth.js";
import { supabase } from "./supabase.js";
const encoder = new TextEncoder();
const MAX_BODY_BYTES = 8000;
const TYPES = ["announcements", "editais"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validDateTime(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : "";
}
function toAnnouncement(row) {
  return { id: row.id, title: row.title, detail: row.detail, date: new Date(row.created_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }), createdAt: row.created_at };
}
function toEdital(row) {
  return { id: row.id, title: row.title, summary: row.summary, status: "Inscrições abertas", opensAt: row.opens_at, closesAt: row.closes_at, results: Array.isArray(row.results) ? row.results : [] };
}

// Busca um edital publicado; usado também para validar candidaturas no servidor.
export async function findEdital(env, id) {
  if (!/^[a-z0-9-]{1,100}$/i.test(String(id || ""))) return null;
  const rows = await supabase(env, "/rest/v1/rota_editais?select=id,title,summary,opens_at,closes_at,results&is_active=eq.true&id=eq." + encodeURIComponent(id) + "&limit=1", { method: "GET" });
  return Array.isArray(rows) && rows.length ? toEdital(rows[0]) : null;
}

// Comunicados e editais: leitura pública; publicar e remover exigem os poderes Comunicados ou Editais.
export async function handleContent(request, env) {
  if (!["GET", "POST", "DELETE"].includes(request.method)) return json(405, { error: "Método não permitido." });
  if (request.method !== "GET") {
    const rejected = originError(request);
    if (rejected) return json(403, { error: rejected });
  }
  try {
    if (request.method === "GET") {
      const type = new URL(request.url).searchParams.get("type");
      if (!TYPES.includes(type)) return json(400, { error: "Conteúdo inválido." });
      if (type === "announcements") {
        const rows = await supabase(env, "/rest/v1/rota_announcements?select=id,title,detail,created_at&is_active=eq.true&order=created_at.desc&limit=50", { method: "GET" });
        return json(200, { rows: (Array.isArray(rows) ? rows : []).map(toAnnouncement) });
      }
      const rows = await supabase(env, "/rest/v1/rota_editais?select=id,title,summary,opens_at,closes_at,results&is_active=eq.true&order=closes_at.desc&limit=50", { method: "GET" });
      return json(200, { rows: (Array.isArray(rows) ? rows : []).map(toEdital) });
    }

    const text = await request.text();
    if (encoder.encode(text).byteLength > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
    let input;
    try { input = JSON.parse(text || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
    if (!input || typeof input !== "object" || Array.isArray(input) || !TYPES.includes(input.type)) return json(400, { error: "Dados inválidos." });
    await requirePermission(request, env, input.type === "announcements" ? "comunicados.publicar" : "editais.gerenciar");
    const table = input.type === "announcements" ? "rota_announcements" : "rota_editais";

    if (request.method === "POST") {
      if (input.type === "announcements") {
        const record = { title: clean(input.title, 120, true), detail: clean(input.detail, 2000, true) };
        if (record.title.length < 3 || record.detail.length < 3) return json(400, { error: "Informe o título e a mensagem do comunicado." });
        const rows = await supabase(env, "/rest/v1/rota_announcements?select=id,title,detail,created_at", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(record) });
        return json(201, { row: toAnnouncement(rows[0]) });
      }
      const record = { title: clean(input.title, 160, true), summary: clean(input.summary, 1000, true), opens_at: validDateTime(input.opensAt), closes_at: validDateTime(input.closesAt) };
      if (record.title.length < 3 || !record.opens_at || !record.closes_at) return json(400, { error: "Informe o título, a abertura e o encerramento do edital." });
      if (new Date(record.closes_at) <= new Date(record.opens_at)) return json(400, { error: "O encerramento precisa ser depois da abertura." });
      const rows = await supabase(env, "/rest/v1/rota_editais?select=id,title,summary,opens_at,closes_at,results", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(record) });
      return json(201, { row: toEdital(rows[0]) });
    }

    const id = clean(input.id, 100, true);
    if (input.type === "announcements" ? !UUID.test(id) : !/^[a-z0-9-]{1,100}$/i.test(id)) return json(400, { error: "Registro inválido." });
    const rows = await supabase(env, "/rest/v1/" + table + "?id=eq." + encodeURIComponent(id) + "&is_active=eq.true&select=id", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ is_active: false, removed_at: new Date().toISOString() }) });
    if (!Array.isArray(rows) || !rows.length) return json(404, { error: "Registro não encontrado ou já removido." });
    return json(200, { ok: true });
  } catch (error) {
    return json(error.status || 500, { error: publicMessage(error) });
  }
}
