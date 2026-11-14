// Aba Discord da administração: mapa cargo → patente/tag/visitante, canal do relatório e sincronização manual.
import { clean, fail, json, originError } from "./http.js";
import { requireStaff } from "./auth.js";
import { RANKS } from "./permissions.js";
import { db } from "./police-access.js";
import { discordApi, discordConfigured, syncGuild } from "./discord.js";

const MAX_BODY = 4000;

async function overview(env) {
  const guildId = env.DISCORD_GUILD_ID;
  const [guild, roles, channels, mapping, settings, linked, tags] = await Promise.all([
    discordApi(env, "/guilds/" + guildId),
    discordApi(env, "/guilds/" + guildId + "/roles"),
    discordApi(env, "/guilds/" + guildId + "/channels"),
    db(env, "rota_discord_roles?select=role_id,role_name,kind,value", "GET").catch(() => []),
    db(env, "rota_discord_settings?select=report_channel_id,last_sync_at,last_sync_result&id=eq.1", "GET").catch(() => []),
    db(env, "police_users?select=user_id&discord_id=not.is.null&removed_at=is.null", "GET").catch(() => []),
    db(env, "rota_tags?select=id,name&order=name.asc", "GET").catch(() => [])
  ]);
  const me = (roles || []).find((r) => r.tags && r.tags.bot_id === env.DISCORD_APPLICATION_ID);
  return {
    guild: { id: guild.id, name: guild.name },
    botRolePosition: me ? me.position : null,
    roles: (roles || []).filter((r) => r.name !== "@everyone" && !r.managed).sort((a, b) => b.position - a.position)
      .map((r) => ({ id: r.id, name: r.name, color: r.color ? "#" + r.color.toString(16).padStart(6, "0") : "", position: r.position, belowBot: me ? r.position < me.position : false })),
    channels: (channels || []).filter((c) => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position).map((c) => ({ id: c.id, name: c.name })),
    mapping: mapping || [],
    settings: (settings && settings[0]) || {},
    linkedAccounts: (linked || []).length,
    ranks: RANKS,
    tags: tags || []
  };
}

export async function handleDiscordAdmin(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  const rejected = originError(request);
  if (rejected) return json(403, { error: rejected });
  try {
    const actor = await requireStaff(request, env);
    if (actor.role !== "admin" && !actor.permissions.includes("regras.ajustar")) throw fail(403, "A aba Discord é do administrador e de quem tem o poder Acesso por patente.");
    if (!discordConfigured(env)) throw fail(503, "O bot do Discord ainda não está configurado na hospedagem (DISCORD_BOT_TOKEN e DISCORD_GUILD_ID).");
    const text = await request.text();
    if (text.length > MAX_BODY) return json(413, { error: "Solicitação muito grande." });
    const input = JSON.parse(text || "{}");
    const actorName = actor.role === "admin" ? "Administração" : (actor.name || "Integrante");
    if (input.action === "overview") return json(200, await overview(env));
    if (input.action === "map-save") {
      const roleId = clean(input.roleId, 25), kind = clean(input.kind, 12), roleName = clean(input.roleName, 100);
      if (!/^[0-9]{5,25}$/.test(roleId)) throw fail(400, "Cargo inválido.");
      if (!kind) {
        await db(env, "rota_discord_roles?role_id=eq." + roleId, "DELETE", undefined, "return=minimal");
        return json(200, { ok: true });
      }
      let value = clean(input.value, 40);
      if (kind === "patente" && !RANKS.includes(value)) throw fail(400, "Escolha uma patente da lista.");
      if (kind === "tag") {
        const tag = await db(env, "rota_tags?select=id&id=eq." + encodeURIComponent(value) + "&limit=1", "GET");
        if (!tag.length) throw fail(400, "Tag não encontrada.");
      }
      if (kind === "visitante") value = "";
      if (!["patente", "tag", "visitante"].includes(kind)) throw fail(400, "Tipo inválido.");
      await db(env, "rota_discord_roles", "POST", { role_id: roleId, role_name: roleName, kind, value, updated_by: actorName, updated_at: new Date().toISOString() }, "resolution=merge-duplicates,return=minimal");
      return json(200, { ok: true });
    }
    if (input.action === "settings-save") {
      const channel = clean(input.reportChannelId, 25);
      if (channel && !/^[0-9]{5,25}$/.test(channel)) throw fail(400, "Canal inválido.");
      await db(env, "rota_discord_settings?id=eq.1", "PATCH", { report_channel_id: channel, updated_by: actorName, updated_at: new Date().toISOString() }, "return=minimal");
      return json(200, { ok: true });
    }
    if (input.action === "sync") return json(200, await syncGuild(env));
    throw fail(400, "Ação desconhecida.");
  } catch (error) {
    return json(error.status || 500, { error: error.message || "Erro inesperado." });
  }
}
