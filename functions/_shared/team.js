// Equipe: todas as contas ativas do portal com patente, ID e presença (online ou visto por último). Consulta pública.
import { json, publicMessage } from "./http.js";
import { supabase } from "./supabase.js";
import { rankLevel } from "./permissions.js";
import { identitiesFor } from "./identity.js";

export const ONLINE_MS = 150 * 1000; // visto nos últimos 2min30s = online

export async function handleTeam(request, env) {
  if (request.method !== "GET") return json(405, { error: "Método não permitido." });
  try {
    const people = await supabase(env, "/rest/v1/police_users?select=user_id,display_name,role,roster_id,login_id,photo_url,last_seen_at&enabled=eq.true&removed_at=is.null&order=display_name.asc&limit=500", { method: "GET" });
    const who = await identitiesFor(env, people || []);
    const now = Date.now();
    const rows = (people || []).map((p) => {
      const id = who[p.user_id] || {};
      const seen = p.last_seen_at ? new Date(p.last_seen_at).getTime() : 0;
      return { label: id.label, name: id.name, rank: id.rank, role: id.member ? "integrante" : "visitante", loginId: id.loginId, photoUrl: id.photoUrl, nameColor: id.nameColor, online: !!seen && now - seen < ONLINE_MS, lastSeen: p.last_seen_at || null };
    }).sort((a, b) => (b.online - a.online) || ((b.role === "integrante") - (a.role === "integrante")) || (rankLevel(b.rank) - rankLevel(a.rank)) || a.name.localeCompare(b.name, "pt-BR"));
    return json(200, { rows, serverTime: new Date(now).toISOString() });
  } catch (error) {
    return json(error.status || 500, { error: publicMessage(error) });
  }
}
