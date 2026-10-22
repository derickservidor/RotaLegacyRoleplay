const MAX_BODY_BYTES = 24000;
const encoder = new TextEncoder();

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
}
function fail(status, message) { const error = new Error(message); error.status = status; return error; }
function clean(value, limit) {
  return Array.from(String(value || "")).filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 || code === 9;
  }).join("").trim().slice(0, limit);
}
function normalizePlayerId(value) {
  return clean(value, 40).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}
async function hashPlayerId(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function config(env) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!/^https:\/\//i.test(url) || !key) throw fail(503, "O servidor ainda não está conectado ao Supabase. Avise a equipe da ROTA.");
  return { url, key };
}
function originError(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  try {
    if (new URL(origin).host.toLowerCase() !== new URL(request.url).host.toLowerCase()) return "Origem não autorizada.";
  } catch (_) { return "Origem inválida."; }
  return null;
}
async function callSupabase(env, path, payload) {
  const cfg = config(env);
  const headers = { apikey: cfg.key, "Content-Type": "application/json" };
  if (!/^sb_secret_/i.test(cfg.key)) headers.Authorization = "Bearer " + cfg.key;
  const response = await fetch(cfg.url + "/rest/v1/" + path, {
    method: "POST", headers, body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.message || body.msg || body.error_description || body.error || "Falha ao salvar a inscrição.";
    throw fail(response.status >= 500 ? 503 : response.status, message);
  }
  return body;
}
function remainingMessage(result) {
  const when = result && result.availableAt ? new Date(result.availableAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }) : "depois de 48 horas";
  return "Este ID já enviou uma inscrição. Uma nova ficará disponível em " + when + ".";
}
function validateApplication(input) {
  const editalId = clean(input.editalId, 100);
  const editalTitle = clean(input.editalTitle, 160);
  const fullName = clean(input.fullName, 100);
  const serverRg = clean(input.serverRg, 60);
  const candidateName = clean(input.characterName, 100);
  const playerId = clean(input.characterId, 40);
  const normalizedId = normalizePlayerId(playerId);
  const realAge = Number(input.realAge);
  const rpExperience = clean(input.rpExperience, 500);
  const policeExperience = clean(input.policeExperience, 1200);
  const roleplayDefinition = clean(input.roleplayDefinition, 1500);
  const metagamingDefinition = clean(input.metagamingDefinition, 1500);
  const powergamingDefinition = clean(input.powergamingDefinition, 1500);
  const whyPmce = clean(input.whyPmce, 1500);
  const characterStory = clean(input.characterStory, 4000);

  if (!editalId || !editalTitle || fullName.length < 2 || serverRg.length < 1 || candidateName.length < 2 || !normalizedId ||
      !Number.isInteger(realAge) || realAge < 1 || realAge > 120 || rpExperience.length < 2 || policeExperience.length < 2 ||
      roleplayDefinition.length < 5 || metagamingDefinition.length < 5 || powergamingDefinition.length < 5 || whyPmce.length < 5 || characterStory.length < 10) {
    throw fail(400, "Preencha todos os campos obrigatórios da ficha de recrutamento.");
  }
  if (!/^[a-z0-9-]+$/i.test(editalId) || normalizedId.length > 40) throw fail(400, "O ID/passaporte MTA ou o edital é inválido.");
  return {
    editalId, editalTitle, fullName, serverRg, candidateName, playerId, normalizedId, realAge,
    rpExperience, policeExperience, roleplayDefinition, metagamingDefinition, powergamingDefinition, whyPmce, characterStory
  };
}
export async function handleEditalApplication(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const blockedOrigin = originError(request);
  if (blockedOrigin) return json(403, { error: blockedOrigin });
  const bodyText = await request.text();
  if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) return json(413, { error: "Solicitação muito grande." });
  let input;
  try { input = JSON.parse(bodyText || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
  try {
    const playerId = clean(input.characterId || input.playerId || input.id, 40);
    const normalizedId = normalizePlayerId(playerId);
    if (!normalizedId) throw fail(400, "Informe o ID do personagem para conferir o prazo de nova inscrição.");
    const candidateHash = await hashPlayerId(normalizedId);
    if (input.action === "check") {
      const status = await callSupabase(env, "rpc/check_public_edital_application_cooldown", { p_candidate_hash: candidateHash });
      return json(200, status || { canApply: true, availableAt: null, remainingSeconds: 0 });
    }
    if (input.action !== "submit") throw fail(400, "Ação inválida.");
    const application = validateApplication(input);
    const result = await callSupabase(env, "rpc/submit_public_edital_application", {
      p_edital_id: application.editalId,
      p_edital_title: application.editalTitle,
      p_full_name: application.fullName,
      p_server_rg: application.serverRg,
      p_candidate_name: application.candidateName,
      p_player_id: application.playerId,
      p_real_age: application.realAge,
      p_rp_experience: application.rpExperience,
      p_police_experience: application.policeExperience,
      p_roleplay_definition: application.roleplayDefinition,
      p_metagaming_definition: application.metagamingDefinition,
      p_powergaming_definition: application.powergamingDefinition,
      p_why_pmce: application.whyPmce,
      p_character_story: application.characterStory,
      p_candidate_hash: candidateHash
    });
    if (result && result.allowed === false) return json(429, { error: remainingMessage(result), availableAt: result.availableAt, remainingSeconds: result.remainingSeconds || 0 });
    return json(201, { ok: true, id: result.id, createdAt: result.createdAt, availableAt: result.availableAt });
  } catch (error) {
    return json(error.status || 500, { error: error.message || "Erro inesperado." });
  }
}
