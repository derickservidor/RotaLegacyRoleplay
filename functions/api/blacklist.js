import { handleBlacklist } from "../_shared/blacklist.js";

export function onRequest(context) {
  return handleBlacklist(context.request, context.env || {});
}
