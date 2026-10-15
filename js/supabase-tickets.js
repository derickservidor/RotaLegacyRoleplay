(function () {
  "use strict";

  var config = window.ROTA_SUPABASE_CONFIG || {};
  var url = String(config.url || "").trim().replace(/\/$/, "");
  var key = String(config.publishableKey || "").trim();
  var SESSION_KEY = "rota-supabase-officer-session";
  var ADMIN_KEY = "rota-admin-session";
  var current = readSession();
  var adminToken = sessionStorage.getItem(ADMIN_KEY) || "";

  function readSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); }
    catch (_) { return null; }
  }
  function saveSession(session) {
    current = session;
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  }
  function isConfigured() {
    return /^https:\/\//i.test(url) && !!key && !/COLE_AQUI|SUA_CHAVE/i.test(key);
  }
  function isAdmin() {
    return !!(current && current.access_token === "admin" && adminToken);
  }
  function apiHeaders(accessToken, extra) {
    var result = { apikey: key, "Content-Type": "application/json" };
    if (accessToken) result.Authorization = "Bearer " + accessToken;
    else if (!/^sb_publishable_/i.test(key)) result.Authorization = "Bearer " + key;
    Object.keys(extra || {}).forEach(function (name) { result[name] = extra[name]; });
    return result;
  }
  async function responseData(response) {
    var body = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      var reason = body.message || body.msg || body.error_description || body.error || "Erro na comunicação com o serviço.";
      throw new Error(reason);
    }
    return body;
  }
  async function functionCall(action, values, admin) {
    var headers = { "Content-Type": "application/json" };
    if (admin && adminToken) headers["x-rota-admin-session"] = adminToken;
    var response = await fetch("/api/police-access", {
      method: "POST", headers: headers, body: JSON.stringify(Object.assign({ action: action }, values || {}))
    });
    return responseData(response);
  }
  function normalizedName(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
  function makeToken() {
    var bytes = new Uint8Array(6);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("").toUpperCase();
  }
  function makeTrackingToken() {
    var bytes = new Uint8Array(32);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  async function policeMembership(session) {
    if (!session || !session.access_token || !session.user || !session.user.id) return false;
    var query = "/rest/v1/police_users?select=user_id,display_name,role,enabled&user_id=eq." + encodeURIComponent(session.user.id) + "&enabled=eq.true";
    var rows = await responseData(await fetch(url + query, { headers: apiHeaders(session.access_token) }));
    if (!Array.isArray(rows) || !rows.length) return false;
    session.user.user_metadata = session.user.user_metadata || {};
    session.user.user_metadata.full_name = rows[0].display_name || session.user.user_metadata.full_name || session.user.email;
    session.user.user_metadata.role = rows[0].role || "policial";
    return true;
  }
  async function refreshSession() {
    if (!current || !current.refresh_token) return null;
    var res = await fetch(url + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST", headers: apiHeaders(), body: JSON.stringify({ refresh_token: current.refresh_token })
    });
    var body = await responseData(res);
    current = { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000, user: body.user };
    saveSession(current);
    return current;
  }
  async function validSession() {
    if (adminToken) {
      try {
        var result = await functionCall("admin-session", {}, true);
        if (result && result.valid) {
          current = { access_token: "admin", user: { id: "rota-admin", email: "admin@rota.invalid", user_metadata: { full_name: "Administrador ROTA", role: "admin" } } };
          return true;
        }
      } catch (_) {}
      adminToken = "";
      sessionStorage.removeItem(ADMIN_KEY);
    }
    if (!isConfigured() || !current || current.access_token === "admin") return false;
    try {
      if (current.expires_at && current.expires_at < Date.now() + 60000) await refreshSession();
      var ok = await policeMembership(current);
      if (!ok) saveSession(null);
      return ok;
    } catch (_) { return false; }
  }
  async function signIn(name, token) {
    if (!isConfigured()) throw new Error("Configure a URL e a chave publishable em js/supabase-config.js e publique as funções do portal.");
    var body = await functionCall("officer-login", { name: String(name || "").trim(), token: String(token || "") });
    var session = body.session;
    if (!session || !session.access_token || !(await policeMembership(session))) throw new Error("A conta não está ativa. Peça aprovação à administração da ROTA.");
    session.expires_at = Date.now() + (Number(session.expires_in) || 3600) * 1000;
    adminToken = "";
    sessionStorage.removeItem(ADMIN_KEY);
    saveSession(session);
    return session;
  }
  async function adminLogin(username, password) {
    var body = await functionCall("admin-login", { username: String(username || "").trim(), password: String(password || "") });
    adminToken = body.adminToken || "";
    if (!adminToken) throw new Error("O servidor não retornou uma sessão administrativa.");
    sessionStorage.setItem(ADMIN_KEY, adminToken);
    saveSession(null);
    current = { access_token: "admin", user: { id: "rota-admin", email: "admin@rota.invalid", user_metadata: { full_name: "Administrador ROTA", role: "admin" } } };
    return current;
  }
  async function requestAccess(name) { return functionCall("request-access", { name: String(name || "").trim() }); }
  async function requestTokenReset(name) { return functionCall("request-reset", { name: String(name || "").trim() }); }
  async function adminAction(action, values) {
    if (!adminToken) throw new Error("Sua sessão administrativa expirou. Entre novamente.");
    return functionCall(action, values, true);
  }
  async function authedFetch(path, options) {
    if (current && current.access_token === "admin") throw new Error("A administração acessa este módulo pelo painel seguro.");
    if (!current || !current.access_token) throw new Error("Entre novamente no portal policial.");
    if (current.expires_at && current.expires_at < Date.now() + 60000) await refreshSession();
    var init = options || {};
    init.headers = apiHeaders(current.access_token, init.headers);
    return fetch(url + path, init);
  }
  function tableFor(kind) {
    if (kind === "ouvidoria") return "ouvidoria_tickets";
    if (kind === "bo") return "bo_tickets";
    throw new Error("Tipo de ticket inválido.");
  }
  function rowToTicket(row, kind) {
    return {
      id: row.public_id, uuid: row.id, type: kind, discord: row.discord,
      player: row.player, legacyName: row.legacy_name || "", reason: row.reason || "",
      category: row.category || "", title: row.category || row.reason || "",
      detail: row.detail || "", status: row.status || "Pendente",
      created: row.created_at ? new Date(row.created_at).toLocaleString("pt-BR") : "",
      createdAt: row.created_at || "", decisionAt: row.decision_at ? new Date(row.decision_at).toLocaleString("pt-BR") : "",
      trackingToken: row.tracking_token || ""
    };
  }
  async function submit(kind, details) {
    if (!isConfigured()) throw new Error("O banco ainda não foi configurado. Preencha a URL e a chave publishable em js/supabase-config.js.");
    var isBo = kind === "bo", table = tableFor(kind);
    var record = {
      public_id: (isBo ? "BO-" : "OUV-") + makeToken(), tracking_token: makeTrackingToken(),
      discord: String(details.discord || "").trim(), player: String(details.player || "").trim(),
      legacy_name: String(details.legacyName || "").trim(), reason: String(details.reason || "").trim(),
      category: String(details.category || "").trim(), detail: String(details.detail || "").trim(), status: "Pendente"
    };
    var response = await fetch(url + "/rest/v1/" + table, {
      method: "POST", headers: apiHeaders(null, { Prefer: "return=minimal" }), body: JSON.stringify(record)
    });
    await responseData(response);
    return rowToTicket(Object.assign({ created_at: new Date().toISOString() }, record), kind);
  }
  async function getCitizenStatus(kind, publicId, token) {
    if (!isConfigured() || !publicId || !token) return null;
    var table = tableFor(kind);
    var query = "/rest/v1/" + table + "?select=public_id,status,decision_at,created_at&public_id=eq." + encodeURIComponent(publicId);
    var res = await fetch(url + query, { headers: apiHeaders(null, { "x-ticket-token": token }) });
    var rows = await responseData(res);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }
  async function list(kind) {
    if (isAdmin()) {
      var adminResult = await adminAction("tickets-list", { kind: kind });
      return (adminResult.rows || []).map(function (row) { return rowToTicket(row, kind); });
    }
    var table = tableFor(kind);
    var query = "/rest/v1/" + table + "?select=id,public_id,discord,player,legacy_name,reason,category,detail,status,created_at,decision_at&order=created_at.desc";
    var rows = await responseData(await authedFetch(query));
    return rows.map(function (row) { return rowToTicket(row, kind); });
  }
  async function decide(kind, publicId, status) {
    if (status !== "Aceito" && status !== "Recusado") throw new Error("Decisão inválida.");
    if (isAdmin()) {
      var adminResult = await adminAction("ticket-decide", { kind: kind, publicId: publicId, status: status });
      return rowToTicket(adminResult.row, kind);
    }
    var table = tableFor(kind);
    var query = "/rest/v1/" + table + "?public_id=eq." + encodeURIComponent(publicId) + "&status=eq.Pendente";
    var rows = await responseData(await authedFetch(query, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: status, decision_at: new Date().toISOString() }) }));
    if (!Array.isArray(rows) || !rows.length) throw new Error("O ticket já foi decidido ou não está mais disponível.");
    return rowToTicket(rows[0], kind);
  }

  window.ROTA_TICKETS = {
    isConfigured: isConfigured,
    current: function () { return current; },
    isAdmin: isAdmin,
    restore: validSession,
    signIn: signIn,
    adminLogin: adminLogin,
    requestAccess: requestAccess,
    requestTokenReset: requestTokenReset,
    adminAction: adminAction,
    signOut: function () { saveSession(null); adminToken = ""; sessionStorage.removeItem(ADMIN_KEY); },
    submit: submit,
    getCitizenStatus: getCitizenStatus,
    list: list,
    decide: decide
  };
})();
