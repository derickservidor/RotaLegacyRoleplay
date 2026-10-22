const crypto = require("node:crypto");
const MAX_BODY_BYTES = 12000;
const FIELD_LIMITS = { person: 80, playerId: 24, officer: 80, hasC4: 8, hasDirtyMoney: 8, hasDrugs: 8, reason: 250, sentence: 60, detail: 1500 };
const GTA_WEAPONS = new Set(["Soco inglês","Taco de beisebol","Taco de golfe","Cassetete","Faca","Pá","Taco de sinuca","Katana","Motosserra","Pistola 9mm","Pistola 9mm com silenciador","Desert Eagle","Espingarda","Espingarda serrada","Espingarda de combate","Micro SMG","Tec-9","MP5","AK-47","M4","Rifle","Rifle de precisão","Lança-foguetes","Lança-foguetes teleguiado","Lança-chamas","Minigun","Granada","Gás lacrimogêneo","Coquetel molotov","Carga explosiva (Satchel)"]);

function json(statusCode, payload) { return { statusCode, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }, body: JSON.stringify(payload) }; }
function clean(value, limit) { return Array.from(String(value || "")).filter(function (character) { const code = character.charCodeAt(0); return code >= 32 || code === 9; }).join("").trim().slice(0, limit); }
function header(event, name) { const headers = event.headers || {}; const key = Object.keys(headers).find(function (item) { return item.toLowerCase() === name.toLowerCase(); }); return key ? String(headers[key] || "") : ""; }
function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || "").trim().replace(/\/$/, ""), serviceKey = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(), publicKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();
  if (!/^https:\/\//i.test(url) || !serviceKey || !publicKey) throw Object.assign(new Error("O administrador precisa configurar as variáveis Supabase no Netlify."), { status: 503 });
  return { url, serviceKey, publicKey };
}
function adminSessionValid(event) {
  const secret = String(process.env.ROTA_SESSION_SECRET || ""), parts = header(event, "x-rota-admin-session").split(".");
  if (secret.length < 32 || parts.length !== 2) return false;
  try {
    const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest(), actual = Buffer.from(parts[1], "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    return payload.role === "admin" && payload.exp > Math.floor(Date.now() / 1000);
  } catch (_) { return false; }
}
async function requireStaff(event) {
  if (adminSessionValid(event)) return;
  const match = header(event, "authorization").match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error("Entre com uma conta policial autorizada para enviar o registro."), { status: 401 });
  const { url, serviceKey, publicKey } = supabaseConfig();
  const userResponse = await fetch(url + "/auth/v1/user", { headers: { apikey: publicKey, Authorization: "Bearer " + match[1] } });
  const user = await userResponse.json().catch(function () { return {}; });
  if (!userResponse.ok || !user.id) throw Object.assign(new Error("Sessão policial inválida ou expirada."), { status: 401 });
  const dbHeaders = { apikey: serviceKey };
  if (!/^sb_(?:publishable|secret)_/i.test(serviceKey)) dbHeaders.Authorization = "Bearer " + serviceKey;
  const memberResponse = await fetch(url + "/rest/v1/police_users?select=user_id&user_id=eq." + encodeURIComponent(user.id) + "&enabled=eq.true&limit=1", { headers: dbHeaders });
  const members = await memberResponse.json().catch(function () { return []; });
  if (!memberResponse.ok || !Array.isArray(members) || !members.length) throw Object.assign(new Error("Esta conta não está autorizada para enviar registros."), { status: 403 });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método não permitido." });
  if (event.body && Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) return json(413, { error: "Registro muito grande." });
  const origin = header(event, "origin"), host = header(event, "x-forwarded-host") || header(event, "host");
  if (origin && host) {
    try { if (new URL(origin).host.toLowerCase() !== host.split(",")[0].trim().toLowerCase()) return json(403, { error: "Origem não autorizada." }); }
    catch (_) { return json(403, { error: "Origem inválida." }); }
  }
  try { await requireStaff(event); }
  catch (error) { return json(Number.isInteger(error.status) ? error.status : 401, { error: error.message || "Acesso policial autorizado necessário." }); }

  let input;
  try { input = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Dados inválidos." }); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Dados inválidos." });
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return json(503, { error: "Integração do Discord ainda não configurada no Netlify." });
  let webhookUrl;
  try { webhookUrl = new URL(webhook); } catch (_) { return json(500, { error: "URL do webhook inválida." }); }
  if (webhookUrl.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(webhookUrl.hostname)) return json(500, { error: "Configure uma URL segura de webhook do Discord." });

  const record = {};
  for (const [key, limit] of Object.entries(FIELD_LIMITS)) record[key] = clean(input[key], limit);
  const weapons = Array.isArray(input.weapons) ? [...new Set(input.weapons.map(function (weapon) { return clean(weapon, 80); }))] : [];
  if (weapons.some(function (weapon) { return !GTA_WEAPONS.has(weapon); })) return json(400, { error: "A lista contém uma arma inválida." });
  for (const key of ["person", "playerId", "officer", "reason", "sentence", "detail"]) if (!record[key]) return json(400, { error: "Preencha todos os campos obrigatórios do registro." });
  for (const key of ["hasC4", "hasDirtyMoney", "hasDrugs"]) if (record[key] !== "Sim" && record[key] !== "Não") return json(400, { error: "Selecione Sim ou Não nos campos de itens apreendidos." });
  const dirtyMoneyAmount = Number(input.dirtyMoneyAmount), drugAmount = Number(input.drugAmount);
  if (!Number.isSafeInteger(dirtyMoneyAmount) || dirtyMoneyAmount < 0 || dirtyMoneyAmount > 999999999 || !Number.isSafeInteger(drugAmount) || drugAmount < 0 || drugAmount > 99999999) return json(400, { error: "Informe quantidades inteiras válidas para dinheiro sujo e drogas." });
  if ((record.hasDirtyMoney === "Sim" && dirtyMoneyAmount < 1) || (record.hasDrugs === "Sim" && drugAmount < 1)) return json(400, { error: "Informe a quantidade do item encontrado." });
  if ((record.hasDirtyMoney === "Não" && dirtyMoneyAmount !== 0) || (record.hasDrugs === "Não" && drugAmount !== 0)) return json(400, { error: "A quantidade deve ser zero quando o item não foi encontrado." });

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
  ].map(function (field) { field.value = field.value.slice(0, 1024); return field; });
  try {
    const response = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ROTA · Registros RP", allowed_mentions: { parse: [] }, embeds: [{ title: "Registro de prisão RP", color: 1717042, fields: fields, footer: { text: "MTA Legacy Roleplay · registro fictício" }, timestamp: new Date().toISOString() }] }) });
    if (!response.ok) return json(502, { error: "O Discord recusou o registro (HTTP " + response.status + ")." });
    return json(200, { ok: true });
  } catch (_) { return json(502, { error: "Não foi possível alcançar o Discord." }); }
};
