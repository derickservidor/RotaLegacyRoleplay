import { handleArrests } from "../_shared/arrests.js";

export function onRequest(context) {
  return handleArrests(context.request, context.env || {});
}
