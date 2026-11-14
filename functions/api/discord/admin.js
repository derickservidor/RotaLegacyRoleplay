import { handleDiscordAdmin } from "../../_shared/discord-admin.js";

export function onRequest(context) {
  return handleDiscordAdmin(context.request, context.env || {});
}
