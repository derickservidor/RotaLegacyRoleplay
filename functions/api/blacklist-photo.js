import { handleBlacklistPhoto } from "../_shared/blacklist.js";

export function onRequest(context) {
  return handleBlacklistPhoto(context.request, context.env || {});
}
