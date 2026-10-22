import { handleRosterPhoto } from "../_shared/roster.js";

export function onRequest(context) {
  return handleRosterPhoto(context.request, context.env || {});
}
