// Bot do Discord por HTTP (interações): /apreensao registra uma apreensão no site; /relatorio resume o mês.
// Toda requisição precisa da assinatura Ed25519 do Discord (DISCORD_PUBLIC_KEY).
import { clean } from "./http.js";
import { assertNotSuspended, checkArea, directPermissions, officerTags, rosterRank } from "./auth.js";
import { rankLevel } from "./permissions.js";
import { db } from "./police-access.js";
import { GTA_WEAPONS } from "./weapons.js";
import { discordApi } from "./discord.js";

const encoder = new TextEncoder();
const EPHEMERAL = 64;
const COLOR = 0xF2C230;

function hexBytes(hex) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16); return out; }
async function verifySignature(env, request, body) {
  const signature = request.headers.get("x-signature-ed25519") || "", timestamp = request.headers.get("x-signature-timestamp") || "";
  const key = String(env.DISCORD_PUBLIC_KEY || "");
  if (!/^[0-9a-f]{128}$/i.test(signature) || !timestamp || !/^[0-9a-f]{64}$/i.test(key)) return false;
  try {
    const publicKey = await crypto.subtle.importKey("raw", hexBytes(key), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", publicKey, hexBytes(signature), encoder.encode(timestamp + body));
  } catch (_) { return false; }
}
const reply = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const message = (content, extra) => reply({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, ...(extra || {}) } });

// Quem mandou o comando, como integrante do site (mesmas regras de requireStaff).
async function actorFromDiscord(env, discordId) {
  const rows = await db(env, "police_users?select=user_id,display_name,role,enabled,roster_id,removed_at,suspended_until,suspension_reason,login_id&discord_id=eq." + encodeURIComponent(discordId) + "&limit=1", "GET");
  const member = rows[0];
  if (!member || !member.enabled || member.removed_at) return { error: "Sua conta do Discord não está ligada a uma conta ativa do portal. Entre no site pelo botão \"Entrar com Discord\"." };
  try { assertNotSuspended(member); } catch (error) { return { error: error.message }; }
  if (member.role !== "policial" || !member.roster_id) return { error: "Só integrantes da ROTA usam este comando." };
  if (member.login_id) {
    const blocked = await db(env, "rota_blacklist?select=id&is_active=eq.true&or=(player_id.eq." + encodeURIComponent(member.login_id) + ",discord_id.eq." + encodeURIComponent(discordId) + ")&limit=1", "GET").catch(() => []);
    if (blocked.length) return { error: "Você está na Blacklist da ROTA." };
  }
  const [tags, direct, rank] = await Promise.all([officerTags(env, member.user_id), directPermissions(env, member.user_id), rosterRank(env, member.roster_id)]);
  return { actor: { id: member.user_id, role: "policial", name: member.display_name || "", loginId: member.login_id || "", rank, level: rankLevel(rank), permissions: [...new Set(tags.flatMap((t) => t.permissions).concat(direct))] } };
}
async function allowed(env, actor, area) { try { await checkArea(env, actor, area); return null; } catch (error) { return error.message; } }

// ---------- /apreensao ----------
function apreensaoModal() {
  const input = (id, label, style, required, placeholder, max) => ({ type: 1, components: [{ type: 4, custom_id: id, label, style, required, placeholder, max_length: max }] });
  return reply({ type: 9, data: { custom_id: "apreensao", title: "Registrar apreensão", components: [
    input("suspeito", "Suspeito: Nome Sobrenome [ID]", 1, true, "João Silva [12345]", 80),
    input("armas", "Armas e C4 (separe por vírgula)", 2, false, "Pistola 9mm, AK-47, C4", 400),
    input("drogas", "Drogas: quantidade (0 se nada)", 1, true, "0", 8),
    input("dinheiro", "Dinheiro sujo em R$ (0 se nada)", 1, true, "0", 12),
    input("motivo", "Motivo — pena", 2, true, "Tráfico e porte ilegal — 40 meses", 300)
  ] } });
}
function fields(components) {
  const out = {};
  for (const row of components || []) for (const c of row.components || []) out[c.custom_id] = String(c.value || "");
  return out;
}
const plain = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const WEAPON_INDEX = new Map([...GTA_WEAPONS].map((w) => [plain(w), w]));
async function saveApreensao(env, actor, values) {
  const suspect = String(values.suspeito || "").match(/^(.*?)\s*\[\s*(\d{1,10})\s*\]\s*$/);
  if (!suspect || clean(suspect[1], 80).length < 2) return { error: "Escreva o suspeito como Nome Sobrenome [ID], por exemplo: João Silva [12345]." };
  const drugs = Number(String(values.drogas).replace(/\D/g, "") || 0), money = Number(String(values.dinheiro).replace(/\D/g, "") || 0);
  if (!Number.isFinite(drugs) || drugs > 99999999 || !Number.isFinite(money) || money > 999999999) return { error: "Quantidade de drogas ou valor de dinheiro inválido." };
  const weapons = [], others = [];
  let c4 = false;
  for (const raw of String(values.armas || "").split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    if (/^c-?4$/i.test(raw)) { c4 = true; continue; }
    const hit = WEAPON_INDEX.get(plain(raw));
    if (hit) weapons.push(hit); else others.push(clean(raw, 60));
  }
  const reasonText = clean(values.motivo, 300, true), split = reasonText.split(/\s+[—–-]\s+/);
  const reason = clean(split.length > 1 ? split.slice(0, -1).join(" — ") : reasonText, 250), sentence = clean(split.length > 1 ? split[split.length - 1] : "A definir", 60);
  if (reason.length < 3) return { error: "Escreva o motivo da apreensão." };
  const officer = clean(actor.name + (actor.loginId ? " [" + actor.loginId + "]" : ""), 80);
  const detail = clean("Registrado pelo Discord por [" + actor.rank + "] " + officer + "." + (others.length ? " Outros itens: " + others.join(", ") + "." : ""), 1500);
  const row = { character_name: clean(suspect[1], 80), player_id: suspect[2], officer, weapon: weapons.length ? weapons.join(", ").slice(0, 100) : "Não informada", weapons, has_c4: c4 ? "Sim" : "Não", has_dirty_money: money > 0 ? "Sim" : "Não", dirty_money_amount: money, has_drugs: drugs > 0 ? "Sim" : "Não", drug_amount: drugs, reason, sentence, detail, created_by: actor.id };
  const saved = await db(env, "arrest_records", "POST", row, "return=representation");
  return { row: saved[0] };
}
const money = (n) => "R$ " + Number(n || 0).toLocaleString("pt-BR");

// ---------- /relatorio ----------
function monthRange(value) {
  const now = new Date(), m = String(value || "").match(/^(\d{4})-(\d{2})$/);
  const year = m ? Number(m[1]) : now.getUTCFullYear(), month = m ? Number(m[2]) - 1 : now.getUTCMonth();
  if (month < 0 || month > 11) return null;
  const start = new Date(Date.UTC(year, month, 1, 3)), end = new Date(Date.UTC(year, month + 1, 1, 3)); // meia-noite de Brasília
  return { key: year + "-" + String(month + 1).padStart(2, "0"), start, end, label: start.toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "America/Sao_Paulo" }) };
}
export async function buildReport(env, monthKey) {
  const range = monthRange(monthKey);
  if (!range) return null;
  const rows = await db(env, "arrest_records?select=officer,weapons,has_c4,dirty_money_amount,drug_amount,created_at&is_active=eq.true&created_at=gte." + encodeURIComponent(range.start.toISOString()) + "&created_at=lt." + encodeURIComponent(range.end.toISOString()) + "&limit=5000", "GET");
  const weapons = {}, officers = {};
  let moneyTotal = 0, drugsTotal = 0, c4 = 0;
  for (const r of rows || []) {
    moneyTotal += Number(r.dirty_money_amount || 0); drugsTotal += Number(r.drug_amount || 0); if (r.has_c4 === "Sim") c4++;
    for (const w of r.weapons || []) weapons[w] = (weapons[w] || 0) + 1;
    officers[r.officer] = (officers[r.officer] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    month: range.key,
    embed: {
      title: "Relatório de apreensões · " + range.label,
      color: COLOR,
      fields: [
        { name: "Apreensões", value: String((rows || []).length), inline: true },
        { name: "Dinheiro sujo", value: money(moneyTotal), inline: true },
        { name: "Drogas", value: drugsTotal.toLocaleString("pt-BR") + " un.", inline: true },
        { name: "C4", value: String(c4), inline: true },
        { name: "Armas mais apreendidas", value: top(weapons, 5).map(([w, n]) => w + " · " + n).join("\n") || "Nenhuma" },
        { name: "Policiais que mais apreenderam", value: top(officers, 5).map(([o, n], i) => (i + 1) + ". " + o + " · " + n).join("\n") || "Ninguém ainda" }
      ],
      footer: { text: "Portal ROTA · Legacy Roleplay (RP fictício)" }
    }
  };
}
export async function postReport(env, channelId, report) {
  return discordApi(env, "/channels/" + channelId + "/messages", { method: "POST", body: JSON.stringify({ embeds: [report.embed], allowed_mentions: { parse: [] } }) });
}

export async function handleInteractions(request, env) {
  if (request.method !== "POST") return new Response("Método não permitido.", { status: 405 });
  const body = await request.text();
  if (!(await verifySignature(env, request, body))) return new Response("Assinatura inválida.", { status: 401 });
  let interaction;
  try { interaction = JSON.parse(body); } catch (_) { return new Response("Dados inválidos.", { status: 400 }); }
  if (interaction.type === 1) return reply({ type: 1 });
  if (interaction.guild_id !== env.DISCORD_GUILD_ID) return message("Este bot só funciona no servidor da ROTA.");
  const discordId = interaction.member && interaction.member.user && interaction.member.user.id;
  try {
    const who = await actorFromDiscord(env, discordId);
    if (who.error) return message(who.error);
    const actor = who.actor;
    const name = interaction.data && (interaction.data.name || interaction.data.custom_id || "");

    if (interaction.type === 2 && name === "apreensao") {
      const denied = await allowed(env, actor, "prisoes.registrar");
      return denied ? message(denied) : apreensaoModal();
    }
    if (interaction.type === 5 && name === "apreensao") {
      const denied = await allowed(env, actor, "prisoes.registrar");
      if (denied) return message(denied);
      const saved = await saveApreensao(env, actor, fields(interaction.data.components));
      if (saved.error) return message(saved.error);
      const r = saved.row;
      return reply({ type: 4, data: { allowed_mentions: { parse: [] }, embeds: [{ title: "Apreensão registrada", color: COLOR, fields: [
        { name: "Suspeito", value: r.character_name + " [" + r.player_id + "]", inline: true },
        { name: "Responsável", value: "[" + actor.rank + "] " + r.officer, inline: true },
        { name: "Armas", value: (r.weapons || []).join(", ") || "Nenhuma", inline: false },
        { name: "Drogas", value: String(r.drug_amount), inline: true },
        { name: "Dinheiro sujo", value: money(r.dirty_money_amount), inline: true },
        { name: "C4", value: r.has_c4, inline: true },
        { name: "Motivo", value: r.reason + " — " + r.sentence, inline: false }
      ], footer: { text: "Também aparece no portal, em Prisões. Fotos: adicione pelo site." } }] } });
    }
    if (interaction.type === 2 && name === "relatorio") {
      const denied = await allowed(env, actor, "prisoes.ver");
      if (denied) return message(denied);
      const opt = (interaction.data.options || []).find((o) => o.name === "mes");
      const report = await buildReport(env, opt && opt.value);
      if (!report) return message("Use o mês no formato AAAA-MM, por exemplo 2026-11.");
      return reply({ type: 4, data: { flags: EPHEMERAL, embeds: [report.embed], components: [{ type: 1, components: [{ type: 2, style: 1, label: "Publicar no canal", custom_id: "relatorio-publicar:" + report.month }] }] } });
    }
    if (interaction.type === 3 && String(name).startsWith("relatorio-publicar:")) {
      const denied = await allowed(env, actor, "prisoes.ver");
      if (denied) return message(denied);
      const report = await buildReport(env, String(name).split(":")[1]);
      await discordApi(env, "/channels/" + interaction.channel_id + "/messages", { method: "POST", body: JSON.stringify({ content: "Publicado por [" + actor.rank + "] " + actor.name, embeds: [report.embed], allowed_mentions: { parse: [] } }) });
      return reply({ type: 7, data: { components: [], content: "Relatório publicado no canal." } });
    }
    return message("Comando desconhecido.");
  } catch (error) {
    return message("Não foi possível concluir: " + (error.status && error.status < 500 ? error.message : "erro interno, tente de novo."));
  }
}
