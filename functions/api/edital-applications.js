import { handleEditalApplication } from "../_shared/edital-applications.js";

export function onRequest(context) {
  return handleEditalApplication(context.request, context.env || {});
}