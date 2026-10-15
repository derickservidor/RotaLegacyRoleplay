const MAX_BODY_BYTES = 12000;
const FIELD_LIMITS = { person: 80, playerId: 24, discord: 100, officer: 80, place: 100, reason: 250, sentence: 60, detail: 1500 };
const encoder = new TextEncoder();

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function clean(value, limit) {
  return Array.from(String(value || "")).filter((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 || code === 9;
  }).join("").trim().slice(0, limit);
}

function getOriginError(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  try {
    if (new URL(origin).host.toLowerCase() !== new URL(request.url).host.toLowerCase()) return "Origem não autorizada.";
  } catch (_) { return "Origem inválida."; }
  return null;
}

export async function handleArrestNotify(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const originError = getOriginError(request);
  if (originError) return json(403, { error: originError });
  const bodyText = await request.text();
  if (encoder.encode(bodyText).byteLength > MAX_BODY_BYTES) return json(413, { error: "Registro muito grande." });

  const webhook = String(env.DISCORD_WEBHOOK_URL || "");
  if (!webhook) return json(503, { error: "Integração do Discord ainda não configurada na hospedagem." });
  let webhookUrl;
  try { webhookUrl = new URL(webhook); } catch (_) { return json(500, { error: "URL do webhook inválida." }); }
  if (webhookUrl.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(webhookUrl.hostname)) {
    return json(500, { error: "Configure uma URL segura de webhook do Discord." });
  }

  let input;
  try { input = JSON.parse(bodyText || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
  const record = {};
  for (const [key, limit] of Object.entries(FIELD_LIMITS)) record[key] = clean(input[key], limit);
  for (const key of ["person", "playerId", "officer", "place", "reason", "sentence", "detail"]) {
    if (!record[key]) return json(400, { error: "Preencha todos os campos obrigatórios do registro." });
  }

  const fields = [
    { name: "Pessoa presa", value: record.person + " · ID in-game " + record.playerId, inline: true },
    { name: "Discord do personagem", value: record.discord || "Não informado", inline: true },
    { name: "Oficial responsável", value: record.officer, inline: true },
    { name: "Local da cena", value: record.place, inline: true },
    { name: "Enquadramento RP", value: record.reason, inline: false },
    { name: "Tempo de prisão", value: record.sentence, inline: true },
    { name: "Observações", value: record.detail, inline: false },
    { name: "Registro", value: clean(input.id, 30) + " · " + clean(input.dateTime || input.date, 40), inline: false }
  ].map((field) => ({ ...field, value: field.value.slice(0, 1024) }));

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "ROTA · Registros RP",
        allowed_mentions: { parse: [] },
        embeds: [{ title: "Registro de prisão RP", color: 1717042, fields, footer: { text: "MTA Legacy Roleplay · registro fictício" }, timestamp: new Date().toISOString() }]
      })
    });
    if (!response.ok) return json(502, { error: "O Discord recusou o registro (HTTP " + response.status + ")." });
    return json(200, { ok: true });
  } catch (_) {
    return json(502, { error: "Não foi possível alcançar o Discord." });
  }
}
