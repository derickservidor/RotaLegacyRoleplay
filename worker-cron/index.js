// Agendador do Portal ROTA: a cada 10 minutos chama a rotina do site (sincronizar o Discord
// e, no dia 1º, publicar o relatório do mês anterior). A chave fica só nas variáveis do Worker.
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch(String(env.SITE_URL).replace(/\/$/, "") + "/api/discord/cron", {
      method: "POST",
      headers: { "x-rota-cron": env.ROTA_CRON_SECRET }
    }).then((r) => r.text()).catch(() => ""));
  }
};
