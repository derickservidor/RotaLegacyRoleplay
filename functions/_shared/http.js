// Respostas e validações comuns a todas as Functions do portal.

export function json(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

// Erro com status HTTP; a mensagem é escrita para quem usa o portal.
export function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

// Erro vindo do banco, do Storage ou do Auth: a mensagem original (em inglês, com nomes de tabela) fica só no log.
export function technical(status, message, detail) {
  return Object.assign(new Error(message || "Falha no banco de dados."), { status, technical: true, detail });
}

// Mensagens do Postgres que o próprio SQL do portal escreveu para o usuário (raise exception).
export function userFacingDbError(body) {
  const message = String((body && body.message) || "");
  if (!message) return false;
  if (body.code === "P0001") return true;
  return body.code === "23514" && !/^new row|violates|relation /i.test(message);
}

const GENERIC = { 401: "Sessão inválida ou expirada. Entre de novo.", 403: "Acesso recusado para esta ação.", 404: "Registro não encontrado. Atualize a página.", 409: "Este registro já existe ou foi alterado por outra pessoa. Atualize a página e confira.", 413: "Arquivo ou envio grande demais.", 429: "Muitas tentativas seguidas. Aguarde um pouco e tente de novo." };

// O que o cliente vê: mensagens escritas pelo portal passam; erros técnicos ou inesperados viram um aviso genérico.
export function publicMessage(error) {
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  if (error && error.message && Number.isInteger(error.status) && !error.technical) return error.message;
  console.error("[rota] erro técnico", status, error && (error.detail || error.message));
  if (status >= 500) return "Erro interno. Tente de novo em instantes.";
  return GENERIC[status] || "Os dados enviados foram recusados. Confira e tente de novo.";
}

// Remove caracteres de controle (mantém tab e, se multiline, quebra de linha), apara e limita o tamanho.
export function clean(value, limit, multiline) {
  return Array.from(String(value || "")).filter((character) => { const code = character.charCodeAt(0); return code >= 32 || code === 9 || (multiline && code === 10); }).join("").trim().slice(0, limit);
}

// Bloqueia requisições de outra origem; sem cabeçalho Origin a requisição segue (ver T-10 na auditoria).
export function originError(request) {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return null;
  try { if (new URL(origin).host.toLowerCase() !== new URL(request.url).host.toLowerCase()) return "Origem não autorizada."; }
  catch (_) { return "Origem inválida."; }
  return null;
}

export function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function decodeBase64Url(value) {
  const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
