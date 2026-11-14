// Rotina automática (chamada pelo Worker de agendamento a cada 10 minutos, com a chave ROTA_CRON_SECRET):
// sincroniza o servidor do Discord e, no dia 1º (horário de Brasília), publica o relatório do mês anterior.
import { json } from "./http.js";
import { db } from "./police-access.js";
import { discordConfigured, syncGuild } from "./discord.js";
import { buildReport, postReport } from "./discord-bot.js";

const encoder = new TextEncoder();
function sameSecret(a, b) {
  const x = encoder.encode(String(a || "")), y = encoder.encode(String(b || ""));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 && y.length >= 32;
}
function brasilia(date) { return new Date(date.getTime() - 3 * 3600 * 1000); }

export async function handleDiscordCron(request, env) {
  if (request.method !== "POST") return json(405, { error: "Método não permitido." });
  if (!sameSecret(request.headers.get("x-rota-cron"), env.ROTA_CRON_SECRET)) return json(401, { error: "Não autorizado." });
  if (!discordConfigured(env)) return json(503, { error: "Discord não configurado." });
  const result = {};
  try { result.sync = await syncGuild(env); } catch (error) { result.syncError = error.message; }
  try {
    const now = brasilia(new Date());
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const month = previous.getUTCFullYear() + "-" + String(previous.getUTCMonth() + 1).padStart(2, "0");
    const settings = (await db(env, "rota_discord_settings?select=report_channel_id,last_report_month&id=eq.1", "GET"))[0] || {};
    if (now.getUTCDate() === 1 && settings.report_channel_id && settings.last_report_month !== month) {
      const report = await buildReport(env, month);
      await postReport(env, settings.report_channel_id, report);
      await db(env, "rota_discord_settings?id=eq.1", "PATCH", { last_report_month: month }, "return=minimal");
      result.report = month;
    }
  } catch (error) { result.reportError = error.message; }
  return json(200, result);
}
