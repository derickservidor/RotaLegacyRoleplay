import { handleArrestNotify } from "../_shared/arrest-notify.js";

export function onRequest(context) {
  return handleArrestNotify(context.request, context.env || {});
}
