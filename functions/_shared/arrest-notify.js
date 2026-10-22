import { requireStaff } from "./blacklist.js";
const MAX_BODY_BYTES = 12000;
const FIELD_LIMITS = { person: 80, playerId: 24, officer: 80, hasC4: 8, hasDirtyMoney: 8, hasDrugs: 8, reason: 250, sentence: 60, detail: 1500 };
const encoder = new TextEncoder();
const GTA_WEAPONS = new Set(["Soco inglês","Taco de beisebol","Taco de golfe","Cassetete","Faca","Pá","Taco de sinuca","Katana","Motosserra","Pistola 9mm","Pistola 9mm com silenciador","Desert Eagle","Espingarda","Espingarda serrada","Espingarda de combate","Micro SMG","Tec-9","MP5","AK-47","M4","Rifle","Rifle de precisão","Lança-foguetes","Lança-foguetes teleguiado","Lança-chamas","Minigun","Granada","Gás lacrimogêneo","Coquetel molotov","Carga explosiva (Satchel)"]);

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
  try { await requireStaff(request, env); }
  catch (error) { return json(Number.isInteger(error.status) ? error.status : 401, { error: error.message || "Acesso policial autorizado necessário." }); }
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
  const weapons = Array.isArray(input.weapons) ? [...new Set(input.weapons.map((item) => clean(item, 80)))] : [];
  if (weapons.some((weapon) => !GTA_WEAPONS.has(weapon))) return json(400, { error: "A lista contém uma arma inválida." });
  for (const key of ["person", "playerId", "officer", "reason", "sentence", "detail"]) {
    if (!record[key]) return json(400, { error: "Preencha todos os campos obrigatórios do registro." });
  }

  for (const key of ["hasC4", "hasDirtyMoney", "hasDrugs"]) {
    if (record[key] !== "Sim" && record[key] !== "Não") return json(400, { error: "Selecione Sim ou Não nos campos de itens apreendidos." });
  }
  const dirtyMoneyAmount = Number(input.dirtyMoneyAmount);
  const drugAmount = Number(input.drugAmount);
  if (!Number.isSafeInteger(dirtyMoneyAmount) || dirtyMoneyAmount < 0 || dirtyMoneyAmount > 999999999 || !Number.isSafeInteger(drugAmount) || drugAmount < 0 || drugAmount > 99999999) {
    return json(400, { error: "Informe quantidades inteiras válidas para dinheiro sujo e drogas." });
  }
  if (record.hasDirtyMoney === "Sim" && dirtyMoneyAmount < 1) return json(400, { error: "Informe a quantidade de dinheiro sujo encontrada." });
  if (record.hasDrugs === "Sim" && drugAmount < 1) return json(400, { error: "Informe a quantidade de drogas encontrada." });
  if (record.hasDirtyMoney === "Não" && dirtyMoneyAmount !== 0) return json(400, { error: "A quantidade de dinheiro sujo deve ser zero quando a resposta for Não." });
  if (record.hasDrugs === "Não" && drugAmount !== 0) return json(400, { error: "A quantidade de drogas deve ser zero quando a resposta for Não." });

  const fields = [
    { name: "Pessoa presa", value: record.person + " · Passaporte Legacy " + record.playerId, inline: true },
    { name: "Oficial responsável", value: record.officer, inline: true },
    { name: "Armas Usadas", value: weapons.join(", ") || "Nenhuma", inline: true },
    { name: "Portava C4 / Satchel Charges?", value: record.hasC4, inline: true },
    { name: "Dinheiro sujo", value: record.hasDirtyMoney + " · $ " + dirtyMoneyAmount.toLocaleString("pt-BR"), inline: true },
    { name: "Drogas", value: record.hasDrugs + " · " + drugAmount.toLocaleString("pt-BR") + " unidade(s)", inline: true },
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
