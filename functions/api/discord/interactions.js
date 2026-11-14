import { handleInteractions } from "../../_shared/discord-bot.js";

export function onRequest(context) {
  return handleInteractions(context.request, context.env || {});
}
