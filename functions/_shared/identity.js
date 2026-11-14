// Identidade única dos integrantes: [Patente | Visitante | Imprensa] Nome [ID], foto e cor do nome.
// Montada sempre a partir do cadastro (conta, ficha do efetivo e tags): nunca é digitada à mão.
import { supabase } from "./supabase.js";

const ROLE_LABEL = { visitante: "Visitante", imprensa: "Imprensa", advogado: "Advogado" };
const DEFAULT_COLOR = "#FFFFFF";
const HEX = /^#[0-9A-Fa-f]{6}$/;

async function rows(env, path) {
  const result = await supabase(env, "/rest/v1/" + path, { method: "GET" }).catch(() => []);
  return Array.isArray(result) ? result : [];
}

// Regras de cor centralizadas: tags (segmentos) por prioridade; depois, no futuro, a cor da patente; senão branco.
export async function colorRules(env) {
  const [tags, ranks] = await Promise.all([
    rows(env, "rota_tags?select=id,name,name_color,color_priority&name_color=not.is.null"),
    rows(env, "rota_ranks?select=rank,name_color&name_color=not.is.null")
  ]);
  return {
    segments: tags.filter((t) => HEX.test(t.name_color || "")).sort((a, b) => (a.color_priority ?? 999) - (b.color_priority ?? 999)),
    ranks: Object.fromEntries(ranks.filter((r) => HEX.test(r.name_color || "")).map((r) => [r.rank, r.name_color]))
  };
}

// people: linhas de police_users com user_id, display_name, role, roster_id, login_id, photo_url.
export async function identitiesFor(env, people) {
  const list = (people || []).filter((p) => p && p.user_id);
  if (!list.length) return {};
  const rosterIds = list.map((p) => p.roster_id).filter(Boolean);
  const ids = list.map((p) => encodeURIComponent(p.user_id)).join(",");
  const [roster, links, rules] = await Promise.all([
    rosterIds.length ? rows(env, "rota_roster?select=id,rank,status&id=in.(" + rosterIds.join(",") + ")") : [],
    rows(env, "rota_user_tags?select=user_id,tag_id&user_id=in.(" + ids + ")"),
    colorRules(env)
  ]);
  const rankById = Object.fromEntries(roster.filter((r) => r.status === "Ativo").map((r) => [r.id, r.rank]));
  const tagsByUser = {};
  links.forEach((l) => { (tagsByUser[l.user_id] = tagsByUser[l.user_id] || []).push(l.tag_id); });
  const result = {};
  for (const p of list) {
    const rank = p.role === "policial" && p.roster_id ? rankById[p.roster_id] || "" : "";
    const held = tagsByUser[p.user_id] || [];
    const segment = rules.segments.find((s) => held.includes(s.id)) || null;
    result[p.user_id] = {
      userId: p.user_id,
      label: rank || ROLE_LABEL[p.role] || "Visitante",
      rank,
      member: !!rank,
      name: p.display_name || "",
      loginId: p.login_id || "",
      photoUrl: p.photo_url || "",
      nameColor: (segment && segment.name_color) || (rank && rules.ranks[rank]) || DEFAULT_COLOR,
      segment: segment ? { id: segment.id, name: segment.name } : null
    };
  }
  return result;
}

export async function identitiesByIds(env, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const people = await rows(env, "police_users?select=user_id,display_name,role,roster_id,login_id,photo_url&user_id=in.(" + ids.map(encodeURIComponent).join(",") + ")");
  return identitiesFor(env, people);
}
