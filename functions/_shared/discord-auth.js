// Login pelo Discord (OAuth2) e vínculo de uma conta existente ao Discord.
// O "state" é assinado (HMAC) e preso ao navegador por um cookie; a sessão chega ao site por um código de uso único.
import { clean, decodeBase64Url, encodeBase64Url, fail, json } from "./http.js";
import { requireAccount } from "./auth.js";
import { callSupabase, db, randomToken, revokeSessions } from "./police-access.js";
import { discordConfigured, syncOne } from "./discord.js";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const STATE_SECONDS = 600, HANDOFF_SECONDS = 60, COOKIE = "rota_discord_nonce";

async function hmac(env, data) {
  const secret = String(env.ROTA_SESSION_SECRET || "");
  if (secret.length < 32) throw fail(503, "Configure ROTA_SESSION_SECRET na hospedagem.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("discord-state|" + data))));
}
async function signState(env, payload) {
  const data = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  return data + "." + await hmac(env, data);
}
async function readState(env, state) {
  const [data, sig] = String(state || "").split(".");
  if (!data || !sig) return null;
  const expected = await hmac(env, data);
  if (expected.length !== sig.length) return null;
  let diff = 0; for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff) return null;
  try { const payload = JSON.parse(decoder.decode(decodeBase64Url(data))); return payload.exp > Date.now() / 1000 ? payload : null; } catch (_) { return null; }
}
async function sha(text) { return encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)))); }
function cookieValue(request, name) {
  const match = String(request.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? match[1] : "";
}
function redirect(location, cookie) {
  const headers = new Headers({ Location: location, "cache-control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}
function callbackUrl(request) { return new URL(request.url).origin + "/api/discord/callback"; }
function siteUrl(request, params) { return new URL(request.url).origin + "/?" + new URLSearchParams(params).toString() + "#painel"; }

async function authorizeUrl(env, request, payload) {
  const nonce = randomToken();
  const state = await signState(env, { ...payload, n: nonce, exp: Math.floor(Date.now() / 1000) + STATE_SECONDS });
  const url = "https://discord.com/oauth2/authorize?" + new URLSearchParams({ client_id: env.DISCORD_APPLICATION_ID, response_type: "code", scope: "identify", redirect_uri: callbackUrl(request), state, prompt: "none" }).toString();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return { url, cookie: COOKIE + "=" + nonce + "; Path=/api/discord; HttpOnly; SameSite=Lax; Max-Age=" + STATE_SECONDS + secure };
}

// GET /api/discord/login → vai para o Discord. POST (logado) → devolve o endereço para vincular a conta.
export async function handleDiscordLogin(request, env) {
  try {
    if (!discordConfigured(env) || !env.DISCORD_APPLICATION_ID || !env.DISCORD_CLIENT_SECRET) throw fail(503, "O login pelo Discord ainda não está configurado.");
    if (request.method === "GET") {
      const { url, cookie } = await authorizeUrl(env, request, { mode: "login" });
      return redirect(url, cookie);
    }
    if (request.method === "POST") {
      const member = await requireAccount(request, env);
      if (member.discord_id) throw fail(409, "Esta conta já está ligada a um Discord.");
      const { url, cookie } = await authorizeUrl(env, request, { mode: "link", uid: member.user_id });
      const response = json(200, { url });
      response.headers.append("Set-Cookie", cookie);
      return response;
    }
    return json(405, { error: "Método não permitido." });
  } catch (error) {
    if (request.method === "GET") return redirect(siteUrl(request, { discord_erro: error.message || "Falha no login pelo Discord." }));
    return json(error.status || 500, { error: error.message || "Falha no login pelo Discord." });
  }
}

async function discordUser(env, request, code) {
  const token = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.DISCORD_APPLICATION_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: callbackUrl(request) })
  });
  const grant = await token.json().catch(() => ({}));
  if (!token.ok || !grant.access_token) throw fail(401, "O Discord não confirmou o login. Tente de novo.");
  const me = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: "Bearer " + grant.access_token } });
  const user = await me.json().catch(() => ({}));
  if (!me.ok || !/^[0-9]{5,25}$/.test(String(user.id || ""))) throw fail(401, "Não foi possível ler a sua conta do Discord.");
  return user;
}

async function blockedDiscord(env, discordId) {
  const rows = await db(env, "rota_blacklist?select=id&is_active=eq.true&discord_id=eq." + encodeURIComponent(discordId) + "&limit=1", "GET").catch(() => []);
  return rows.length > 0;
}

// Abre a sessão do Supabase da conta sem senha (link mágico gerado e verificado pelo servidor).
async function sessionFor(env, email) {
  const link = await callSupabase(env, "/auth/v1/admin/generate_link", { method: "POST", body: JSON.stringify({ type: "magiclink", email }) });
  const tokenHash = link.hashed_token || (link.properties && link.properties.hashed_token);
  if (!tokenHash) throw fail(502, "Não foi possível abrir a sessão.");
  return callSupabase(env, "/auth/v1/verify", { method: "POST", body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }) }, true);
}

// GET /api/discord/callback: o Discord devolve a pessoa aqui.
export async function handleDiscordCallback(request, env) {
  const url = new URL(request.url);
  const clearCookie = COOKIE + "=; Path=/api/discord; HttpOnly; SameSite=Lax; Max-Age=0";
  try {
    if (url.searchParams.get("error")) throw fail(400, "Login pelo Discord cancelado.");
    const state = await readState(env, url.searchParams.get("state"));
    if (!state || !state.n || state.n !== cookieValue(request, COOKIE)) throw fail(400, "O pedido de login expirou ou veio de outro navegador. Tente de novo.");
    const user = await discordUser(env, request, clean(url.searchParams.get("code"), 200));
    if (await blockedDiscord(env, user.id)) throw fail(403, "Esta conta do Discord está na Blacklist da ROTA.");

    if (state.mode === "link") {
      const taken = await db(env, "police_users?select=user_id&discord_id=eq." + encodeURIComponent(user.id) + "&limit=1", "GET");
      if (taken.length && taken[0].user_id !== state.uid) throw fail(409, "Este Discord já está ligado a outra conta do portal.");
      await db(env, "police_users?user_id=eq." + encodeURIComponent(state.uid) + "&discord_id=is.null", "PATCH", { discord_id: user.id, discord_username: clean(user.username, 40) }, "return=minimal");
      await syncOne(env, user.id).catch(() => {});
      return redirect(siteUrl(request, { discord_ok: "Conta ligada ao Discord. Patente, nome e ID agora seguem o servidor." }), clearCookie);
    }

    const synced = await syncOne(env, user.id, { allowVisitor: true });
    if (synced.notInGuild) throw fail(403, "Entre no servidor da ROTA no Discord para acessar o portal.");
    if (synced.outcome && synced.outcome.skipped === "blacklist") throw fail(403, "Este ID está na Blacklist da ROTA.");
    if (synced.outcome && synced.outcome.skipped === "apelido fora do padrão") throw fail(403, "Defina o seu apelido no servidor da ROTA no Discord no padrão [SIGLA] Nome [ID] (ex.: [CAP] João Silva [17319]) e entre de novo.");
    const rows = await db(env, "police_users?select=user_id,display_name,role,enabled,removed_at,login_email,suspended_until,suspension_reason&discord_id=eq." + encodeURIComponent(user.id) + "&limit=1", "GET");
    const account = rows[0];
    if (!account || account.removed_at) throw fail(403, "Esta conta foi removida da corporação.");
    if (!account.enabled) throw fail(403, "Esta conta está desativada.");
    if (account.suspended_until && new Date(account.suspended_until) > new Date()) throw fail(403, "Sua conta está suspensa" + (account.suspension_reason ? ": " + account.suspension_reason : "."));
    const session = await sessionFor(env, account.login_email);
    session.user = session.user || {};
    session.user.user_metadata = { ...(session.user.user_metadata || {}), full_name: account.display_name, role: account.role };
    const code = randomToken() + randomToken();
    await db(env, "rota_login_handoff?expires_at=lt." + encodeURIComponent(new Date().toISOString()), "DELETE", undefined, "return=minimal").catch(() => {});
    await db(env, "rota_login_handoff", "POST", { code_hash: await sha(code), session, expires_at: new Date(Date.now() + HANDOFF_SECONDS * 1000).toISOString() }, "return=minimal");
    await db(env, "login_events", "POST", { user_id: account.user_id, display_name: account.display_name, role: account.role, logged_at: new Date().toISOString() }, "return=minimal").catch(() => {});
    await db(env, "police_users?user_id=eq." + encodeURIComponent(account.user_id), "PATCH", { last_seen_at: new Date().toISOString() }, "return=minimal").catch(() => {});
    return redirect(siteUrl(request, { discord_code: code }), clearCookie);
  } catch (error) {
    return redirect(siteUrl(request, { discord_erro: error.message || "Falha no login pelo Discord." }), clearCookie);
  }
}

// O site troca o código de uso único pela sessão (uma vez só, em até 60 s).
export async function redeemHandoff(env, input) {
  const code = clean(input.code, 200);
  if (code.length < 40) throw fail(400, "Código de login inválido.");
  const rows = await db(env, "rota_login_handoff?code_hash=eq." + encodeURIComponent(await sha(code)), "DELETE", undefined, "return=representation");
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || new Date(row.expires_at) < new Date()) throw fail(401, "O login pelo Discord expirou. Entre de novo.");
  return { session: row.session };
}

export { revokeSessions };
