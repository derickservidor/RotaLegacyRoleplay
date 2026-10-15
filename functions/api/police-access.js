import { handlePoliceAccess } from "../_shared/police-access.js";

export function onRequest(context) {
  return handlePoliceAccess(context.request, context.env || {});
}
