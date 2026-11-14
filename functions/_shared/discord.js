// Discord como fonte da identidade: o apelido "[SIGLA] Nome [ID]" dá nome e ID; os cargos mapeados dão patente e tags.
// A sincronização lê tudo de uma vez e grava em lotes (limite de chamadas por execução das Functions).
import { clean, fail } from "./http.js";
import { RANKS, rankLevel } from "./permissions.js";
import { callSupabase, db, logTag, normalizeName, randomToken, revokeSessions } from "./police-access.js";

const API = "https://discord.com/api/v10";
const WRITE_BUDGET = 30; // gravações por execução; o resto continua na próxima rodada

export function discordConfigured(env) {
  return /^[0-9]{5,25}$/.test(String(env.DISCORD_GUILD_ID || "")) && String(env.DISCORD_BOT_TOKEN || "").length > 20;
}

export async function discordApi(env, path, init) {
  const options = init || {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(API + path, { ...options, headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json", ...(options.headers || {}) } });
    if (response.status === 429) {
      const wait = await response.json().catch(() => ({}));
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.ceil((wait.retry_after || 1) * 1000))));
      continue;
    }
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error("O Discord recusou a operação (" + (body.message || response.status) + ")."), { status: response.status === 404 ? 404 : 502, discordCode: body.code });
    return body;
  }
  throw fail(502, "O Discord está limitando as chamadas. Tente de novo em alguns segundos.");
}

// "[CAP] Lock Silva [17319]" → { name: "Lock Silva", loginId: "17319", ok: true }
export function parseNick(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const withoutTag = (s) => s.replace(/^\[[^\]]{0,24}\]\s*/, "").trim();
  const match = text.match(/^(.*?)\s*\[\s*(\d{1,10})\s*\]\s*$/);
  if (match) return { name: clean(withoutTag(match[1]), 60), loginId: match[2], ok: !!withoutTag(match[1]) };
  return { name: clean(withoutTag(text), 60), loginId: "", ok: false };
}

export async function loadMapping(env) {
  const rows = await db(env, "rota_discord_roles?select=role_id,role_name,kind,value", "GET").catch(() => []);
  const byRole = {};
  for (const row of rows || []) byRole[row.role_id] = row;
  return { rows: rows || [], byRole, managedTags: new Set((rows || []).filter((r) => r.kind === "tag").map((r) => r.value)) };
}

// O que o servidor diz sobre o membro: patente (o cargo de patente mais alto), tags, nome e ID do apelido.
export function resolveMember(member, mapping) {
  const ranks = [], tags = [];
  let visitor = false;
  for (const roleId of member.roles || []) {
    const map = mapping.byRole[roleId];
    if (!map) continue;
    if (map.kind === "patente" && RANKS.includes(map.value)) ranks.push(map.value);
    else if (map.kind === "tag" && map.value) tags.push(map.value);
    else if (map.kind === "visitante") visitor = true;
  }
  ranks.sort((a, b) => rankLevel(b) - rankLevel(a));
  const user = member.user || {};
  // Nome e ID vêm SÓ do apelido neste servidor (nunca do nome global do Discord).
  const parsed = parseNick(member.nick || "");
  return {
    discordId: String(user.id || ""), username: clean(user.username, 40), bot: !!user.bot,
    rank: ranks[0] || "", tags: [...new Set(tags)], visitor,
    name: parsed.name, loginId: parsed.loginId, nickOk: !!(parsed.ok && parsed.name && parsed.loginId)
  };
}

export async function guildMember(env, discordId) {
  try { return await discordApi(env, "/guilds/" + env.DISCORD_GUILD_ID + "/members/" + encodeURIComponent(discordId)); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

async function allGuildMembers(env) {
  const members = [];
  let after = "0";
  for (let page = 0; page < 20; page++) {
    const batch = await discordApi(env, "/guilds/" + env.DISCORD_GUILD_ID + "/members?limit=1000&after=" + after);
    members.push(...batch);
    if (batch.length < 1000) return members;
    after = batch[batch.length - 1].user.id;
  }
  return members;
}

// Lê de uma vez o que a sincronização precisa saber do site.
async function loadSiteState(env) {
  const [accounts, blacklist, tags, userTags] = await Promise.all([
    db(env, "police_users?select=user_id,display_name,normalized_name,role,roster_id,login_id,enabled,removed_at,discord_id,discord_left_at&limit=5000", "GET"),
    db(env, "rota_blacklist?select=player_id,discord_id&is_active=eq.true&limit=5000", "GET").catch(() => []),
    db(env, "rota_tags?select=id,name", "GET").catch(() => []),
    db(env, "rota_user_tags?select=user_id,tag_id&limit=20000", "GET").catch(() => [])
  ]);
  const roster = await db(env, "rota_roster?select=id,qra,full_name,rank,passport,status&limit=5000", "GET").catch(() => []);
  return {
    accounts: accounts || [],
    byDiscord: Object.fromEntries((accounts || []).filter((a) => a.discord_id).map((a) => [a.discord_id, a])),
    rosterById: Object.fromEntries((roster || []).map((r) => [r.id, r])),
    rosterByPassport: Object.fromEntries((roster || []).map((r) => [r.passport, r])),
    blockedIds: new Set((blacklist || []).map((b) => b.player_id).filter(Boolean)),
    blockedDiscord: new Set((blacklist || []).map((b) => b.discord_id).filter(Boolean)),
    tagIds: new Set((tags || []).map((t) => t.id)),
    tagsByUser: (userTags || []).reduce((acc, t) => { (acc[t.user_id] = acc[t.user_id] || new Set()).add(t.tag_id); return acc; }, {})
  };
}

// Orçamento de gravações compartilhado por uma execução.
function budget(limit) {
  const state = { used: 0, limit };
  return { spend(n) { if (state.used + (n || 1) > state.limit) return false; state.used += n || 1; return true; }, get used() { return state.used; }, get left() { return state.limit - state.used; } };
}

async function createDiscordAccount(env, info) {
  const email = "discord." + info.discordId + "@members.invalid";
  const created = await callSupabase(env, "/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password: randomToken() + randomToken(), email_confirm: true, user_metadata: { full_name: info.name, role: info.rank ? "policial" : "visitante" }, app_metadata: { role: info.rank ? "policial" : "visitante" } }) });
  const row = { user_id: created.id, display_name: info.name, normalized_name: (normalizeName(info.name) || "discord") + "-d" + info.discordId.slice(-6), login_email: email, role: info.rank ? "policial" : "visitante", enabled: true, must_set_password: false, discord_id: info.discordId, discord_username: info.username };
  try { await db(env, "police_users", "POST", row, "return=minimal"); }
  catch (error) { await callSupabase(env, "/auth/v1/admin/users/" + encodeURIComponent(created.id), { method: "DELETE" }).catch(() => {}); throw error; }
  return { ...row, roster_id: null, login_id: null, removed_at: null, discord_left_at: null };
}

// Aplica a um membro o que o Discord diz. Devolve o que mudou (ou por que não mudou).
export async function syncMember(env, info, state, spend, options) {
  const opts = options || {};
  if (info.bot) return { skipped: "bot" };
  if (state.blockedDiscord.has(info.discordId) || (info.loginId && state.blockedIds.has(info.loginId))) return { skipped: "blacklist" };
  let account = state.byDiscord[info.discordId];
  if (account && account.removed_at) return { skipped: "removido" };
  const label = info.nickOk ? info.name : "@" + info.username;
  const result = { discordId: info.discordId, name: label, changes: [] };
  if (!info.nickOk) {
    result.conflict = "apelido fora do padrão [SIGLA] Nome [ID]";
    if (!account) return { skipped: "apelido fora do padrão", conflict: result.conflict, name: label };
  }
  if (!account) {
    if (!info.rank && !opts.allowVisitor) return { skipped: "sem cargo de patente" };
    if (!spend(3)) return { pending: true };
    account = await createDiscordAccount(env, info);
    state.byDiscord[info.discordId] = account;
    result.changes.push("conta criada");
  }
  const now = new Date().toISOString(), change = { discord_username: info.username, discord_synced_at: now };
  if (account.discord_left_at) { change.discord_left_at = null; change.enabled = true; result.changes.push("voltou ao servidor"); }
  if (info.nickOk && info.name !== account.display_name) { change.display_name = info.name; result.changes.push("nome"); }
  if (info.nickOk && info.loginId !== account.login_id) {
    const owner = state.accounts.find((a) => a.login_id === info.loginId && !a.removed_at && a.user_id !== account.user_id);
    if (owner) result.conflict = "ID " + info.loginId + " já é de outra conta";
    else { change.login_id = info.loginId; result.changes.push("ID"); }
  }

  // Patente: ficha do efetivo criada/atualizada; sem cargo de patente, a conta volta a visitante.
  if (info.rank) {
    let ficha = account.roster_id ? state.rosterById[account.roster_id] : null;
    const passport = info.loginId || (ficha && ficha.passport) || "D" + info.discordId.slice(-10);
    const baseName = info.nickOk ? info.name : (account.display_name || "Integrante");
    const qra = baseName.length >= 2 ? baseName : baseName + "·";
    const fullName = baseName.length >= 3 ? baseName : (baseName + " ROTA").slice(0, 100);
    if (!ficha) {
      const free = state.rosterByPassport[passport];
      const linked = free && state.accounts.some((a) => a.roster_id === free.id && a.user_id !== account.user_id && !a.removed_at && a.role === "policial");
      if (!spend(2)) return { ...result, pending: true };
      if (free && !linked) {
        await db(env, "police_users?roster_id=eq." + encodeURIComponent(free.id), "PATCH", { roster_id: null }, "return=minimal").catch(() => {});
        const rows = await db(env, "rota_roster?id=eq." + encodeURIComponent(free.id), "PATCH", { rank: info.rank, qra, full_name: fullName, status: "Ativo", updated_at: now }, "return=representation");
        ficha = rows[0];
      } else {
        const rows = await db(env, "rota_roster", "POST", { qra, full_name: fullName, rank: info.rank, passport: linked ? "D" + info.discordId.slice(-10) : passport, status: "Ativo", photo_path: "", photo_url: "", admitted_on: now.slice(0, 10) }, "return=representation");
        ficha = rows[0];
      }
      change.roster_id = ficha.id;
      if (spend(1)) await db(env, "rota_rank_history", "POST", { roster_id: ficha.id, qra, from_rank: "", to_rank: info.rank, actor: "Discord", reason: "Cargo no Discord" }, "return=minimal").catch(() => {});
      result.changes.push("ficha " + info.rank);
    } else if (ficha.rank !== info.rank || ficha.status !== "Ativo" || ficha.qra !== qra || (info.loginId && ficha.passport !== info.loginId)) {
      if (!spend(2)) return { ...result, pending: true };
      const patch = { rank: info.rank, status: "Ativo", qra, full_name: fullName, updated_at: now };
      if (info.loginId && ficha.passport !== info.loginId && !state.rosterByPassport[info.loginId]) patch.passport = info.loginId;
      await db(env, "rota_roster?id=eq." + encodeURIComponent(ficha.id), "PATCH", patch, "return=minimal");
      if (ficha.rank !== info.rank) {
        await db(env, "rota_rank_history", "POST", { roster_id: ficha.id, qra, from_rank: ficha.rank, to_rank: info.rank, actor: "Discord", reason: "Cargo no Discord" }, "return=minimal").catch(() => {});
        result.changes.push(ficha.rank + " → " + info.rank);
      }
    }
    if (account.role !== "policial") change.role = "policial";
  } else if (account.role === "policial") {
    change.role = "visitante";
    const ficha = account.roster_id ? state.rosterById[account.roster_id] : null;
    if (ficha && ficha.status !== "Inativo" && spend(1)) await db(env, "rota_roster?id=eq." + encodeURIComponent(ficha.id), "PATCH", { status: "Inativo", updated_at: now }, "return=minimal").catch(() => {});
    result.changes.push("sem patente → visitante");
  }

  // Tags mapeadas: o Discord manda nelas; tags que não estão no mapa continuam sendo do site.
  const current = state.tagsByUser[account.user_id] || new Set();
  const wanted = info.tags.filter((t) => state.tagIds.has(t));
  for (const tag of wanted) {
    if (current.has(tag)) continue;
    if (!spend(1)) return { ...result, pending: true };
    await db(env, "rota_user_tags", "POST", { user_id: account.user_id, tag_id: tag, granted_by: "Discord" }, "resolution=ignore-duplicates,return=minimal");
    current.add(tag); result.changes.push("+" + tag);
  }
  for (const tag of [...current]) {
    if (!opts.managedTags.has(tag) || wanted.includes(tag)) continue;
    if (!spend(1)) return { ...result, pending: true };
    await db(env, "rota_user_tags?user_id=eq." + encodeURIComponent(account.user_id) + "&tag_id=eq." + encodeURIComponent(tag), "DELETE", undefined, "return=minimal");
    current.delete(tag); result.changes.push("-" + tag);
  }
  state.tagsByUser[account.user_id] = current;

  if (!spend(1)) return { ...result, pending: true };
  try { await db(env, "police_users?user_id=eq." + encodeURIComponent(account.user_id), "PATCH", change, "return=minimal"); }
  catch (error) {
    if (!(error.status === 409 || /duplicate|unique/i.test(error.message)) || !change.login_id) throw error;
    delete change.login_id; result.conflict = "ID " + info.loginId + " já é de outra conta";
    await db(env, "police_users?user_id=eq." + encodeURIComponent(account.user_id), "PATCH", change, "return=minimal");
  }
  Object.assign(account, change);
  if (result.changes.length) await logTag(env, { action: "discord", actor: "Discord", target_user: account.user_id, target_name: label, details: { changes: result.changes } }).catch(() => {});
  result.userId = account.user_id;
  return result;
}

// Sincroniza o servidor inteiro (em lotes). Quem saiu do servidor tem a conta desativada.
export async function syncGuild(env) {
  if (!discordConfigured(env)) throw fail(503, "Configure DISCORD_BOT_TOKEN e DISCORD_GUILD_ID na hospedagem.");
  const [members, mapping, state] = await Promise.all([allGuildMembers(env), loadMapping(env), loadSiteState(env)]);
  const pool = budget(WRITE_BUDGET), spend = (n) => pool.spend(n);
  const report = { members: members.length, updated: 0, created: 0, left: 0, skipped: 0, conflicts: [], pending: false };
  const inGuild = new Set();
  for (const member of members) {
    const info = resolveMember(member, mapping);
    inGuild.add(info.discordId);
    if (!info.rank && !info.tags.length && !state.byDiscord[info.discordId]) continue;
    const outcome = await syncMember(env, info, state, spend, { managedTags: mapping.managedTags });
    if (outcome.pending) { report.pending = true; break; }
    if (outcome.skipped) report.skipped++;
    else if (outcome.changes && outcome.changes.length) { report.updated++; if (outcome.changes.includes("conta criada")) report.created++; }
    if (outcome.conflict) report.conflicts.push((outcome.name || info.name || "@" + info.username) + ": " + outcome.conflict);
  }
  if (!report.pending && members.length) {
    for (const account of state.accounts) {
      if (!account.discord_id || inGuild.has(account.discord_id) || account.removed_at || !account.enabled || account.discord_left_at) continue;
      if (!pool.spend(2)) { report.pending = true; break; }
      await db(env, "police_users?user_id=eq." + encodeURIComponent(account.user_id), "PATCH", { enabled: false, discord_left_at: new Date().toISOString() }, "return=minimal");
      await revokeSessions(env, account.user_id);
      report.left++;
    }
  }
  report.writes = pool.used;
  await db(env, "rota_discord_settings?id=eq.1", "PATCH", { last_sync_at: new Date().toISOString(), last_sync_result: report }, "return=minimal").catch(() => {});
  return report;
}

// Sincroniza só uma pessoa (login pelo Discord, vínculo de conta).
export async function syncOne(env, discordId, options) {
  const member = await guildMember(env, discordId);
  if (!member) return { notInGuild: true };
  const [mapping, state] = await Promise.all([loadMapping(env), loadSiteState(env)]);
  const info = resolveMember(member, mapping);
  const pool = budget(WRITE_BUDGET);
  const outcome = await syncMember(env, info, state, (n) => pool.spend(n), { managedTags: mapping.managedTags, allowVisitor: !!(options && options.allowVisitor) });
  return { info, outcome };
}

// Ao remover/colocar na blacklist pelo site: tira do membro os cargos mapeados no Discord.
export async function stripMappedRoles(env, discordId) {
  if (!discordConfigured(env) || !discordId) return;
  const [member, mapping] = await Promise.all([guildMember(env, discordId).catch(() => null), loadMapping(env)]);
  if (!member) return;
  for (const roleId of member.roles || []) {
    if (!mapping.byRole[roleId]) continue;
    await discordApi(env, "/guilds/" + env.DISCORD_GUILD_ID + "/members/" + encodeURIComponent(discordId) + "/roles/" + encodeURIComponent(roleId), { method: "DELETE", headers: { "X-Audit-Log-Reason": encodeURIComponent("Removido pelo Portal ROTA") } }).catch(() => {});
  }
}
