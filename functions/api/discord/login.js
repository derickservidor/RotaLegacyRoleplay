import { handleDiscordLogin } from "../../_shared/discord-auth.js";

export function onRequest(context) {
  return handleDiscordLogin(context.request, context.env || {});
}
