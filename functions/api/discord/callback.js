import { handleDiscordCallback } from "../../_shared/discord-auth.js";

export function onRequest(context) {
  return handleDiscordCallback(context.request, context.env || {});
}
