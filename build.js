const fs = require("fs");
const path = require("path");
const root = __dirname;
const out = path.join(root, "dist");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const item of ["index.html", "README.md", "assets", "css", "js"]) {
  const from = path.join(root, item);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(out, item), { recursive: true });
}
// Supabase's URL and publishable key are public client settings. Inject them
// at build time so the static site and Netlify Functions use the same project.
// Never expose the service-role key, admin password, or session secret here.
const sourceConfigPath = path.join(out, "js", "supabase-config.js");
const sourceConfig = fs.readFileSync(sourceConfigPath, "utf8");
function readPublicSetting(name) {
  const match = sourceConfig.match(new RegExp("\\b" + name + "\\s*:\\s*([\"'])(.*?)\\1"));
  return match ? match[2] : "";
}
const supabaseUrl = String(process.env.SUPABASE_URL || readPublicSetting("url")).trim().replace(/\/$/, "");
const publishableKey = String(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || readPublicSetting("publishableKey")).trim();
const publicConfig = {
  url: /^https:\/\//i.test(supabaseUrl) ? supabaseUrl : "",
  publishableKey: publishableKey && !/service_role|sb_secret_/i.test(publishableKey) ? publishableKey : ""
};
fs.writeFileSync(
  path.join(out, "js", "supabase-config.js"),
  "// Gerado no build. Contém somente configurações públicas.\nwindow.ROTA_SUPABASE_CONFIG = " + JSON.stringify(publicConfig, null, 2) + ";\n"
);
// Cloudflare Pages Functions serve only the API routes; static assets stay
// on the CDN and do not invoke a Function.
fs.writeFileSync(path.join(out, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }, null, 2) + "\n");
console.log("Static portal copied to dist/.");
