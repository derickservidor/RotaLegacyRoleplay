import { handleRoster } from "../_shared/roster.js";

export function onRequest(context) {
  return handleRoster(context.request, context.env || {});
}
