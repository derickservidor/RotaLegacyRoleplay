import { handleArrestPhoto } from "../_shared/arrests.js";
export function onRequest(context) { return handleArrestPhoto(context.request, context.env || {}); }
