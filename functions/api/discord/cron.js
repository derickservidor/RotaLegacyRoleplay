import { handleDiscordCron } from "../../_shared/discord-cron.js";

export function onRequest(context) {
  return handleDiscordCron(context.request, context.env || {});
}
