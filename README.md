# ROTA — Portal de Roleplay MTA

Portal comunitário fictício para a unidade ROTA no servidor Legacy Roleplay. O site é estático, usa Supabase para tickets e autenticação, e tem funções de servidor para administração e integração com Discord.

## Hospedagem

O portal é publicado no Cloudflare Pages (https://rotalegacyroleplay.pages.dev). As funções de servidor ficam na pasta `functions/`, na raiz do projeto; os arquivos estáticos compilados ficam em `dist/`.

**Importante:** extraia o ZIP completo e publique a partir da raiz do projeto, mantendo `functions/` ao lado de `build.js`. Não publique somente `dist/` nem abra `index.html` direto do arquivo: sem as Functions e as variáveis do Supabase, o efetivo, a blacklist e os cadastros não conseguem carregar ou salvar dados.

### Cloudflare Pages

1. Envie estes arquivos atualizados ao GitHub e crie um projeto Pages conectado ao repositório e à branch `main`. Use integração Git; o envio direto de arquivos pelo painel não publica as Pages Functions.
2. Na configuração de build do Pages, use:
   - **Root directory:** deixe o padrão (raiz do repositório, onde aparecem `index.html`, `build.js` e `functions/`).
   - **Build command:** `node build.js`.
   - **Build output directory:** `dist`.
3. Em **Settings → Variables and Secrets**, adicione as variáveis e segredos da seção Supabase abaixo para **Production**. Configure Preview também caso vá testar deploys de preview. A URL e a chave pública precisam estar disponíveis no build; os segredos são lidos pelas Functions em runtime.
4. Faça o deploy e teste no endereço `*.pages.dev`. Um domínio próprio pode ser apontado depois.

A pasta `dist/` é gerada pelo build e não fica no repositório (está no `.gitignore`); o Cloudflare Pages roda `node build.js` a cada deploy. O build também acrescenta `?v=<hash do conteúdo>` aos CSS e JS do `index.html`, então não é preciso mexer em versões para atualizar o cache dos navegadores. O build cria `dist/_routes.json` para encaminhar somente `/api/*` às Pages Functions; o conteúdo estático continua sendo servido pela CDN.

## Configurar o Supabase

1. No Supabase, abra **SQL Editor** e execute todo o arquivo `supabase/schema.sql`.
2. Para habilitar a consulta pública e as fotos da blacklist, execute também `supabase/blacklist.sql` no SQL Editor. Esse script cria/atualiza a tabela, concede leitura pública somente dos campos exibidos e cria o bucket público das imagens. Cidadãos e policiais podem consultar; incluir e retirar exigem o poder Blacklist, o ID e a senha de quem faz e uma confirmação final.
3. Cada registro público exibe a foto do personagem, nome e Passaporte Legacy. Cadastre somente personagens e fatos fictícios do roleplay. As fotos ficam acessíveis publicamente no bucket `rota-blacklist-photos`.
4. Para o livro compartilhado de prisões e as fotos de apreensão, execute (ou execute novamente) `supabase/arrests.sql` antes de publicar. O script atualiza as colunas de armas e imagens e cria o bucket privado `rota-arrest-photos`; listar, registrar, anexar imagens e remover exigem uma conta policial autorizada. As fotos recebem links temporários e só aparecem na área policial.

   Para os quadros compartilhados da área policial (**Operações**, **Registros RP** e **Procurados RP**), execute também `supabase/police-board.sql`. Sem ele, essas páginas mostram "Não foi possível carregar o quadro da equipe".

   Para as **tags e permissões** da equipe (Comando, Recrutador, Corregedoria e as que o comando criar), execute `supabase/tags.sql` depois do `schema.sql` e do `roster-shared-login.sql`. Sem ele, só o administrador do servidor consegue usar a Administração.

   Para as **patentes** (o que cada patente vê e faz, poderes avulsos, suspensão com prazo e promoções), execute `supabase/patentes.sql` depois do `tags.sql`. Contas sem ficha do efetivo vinculada contam como Recruta (só consulta): vincule cada conta à sua ficha em Administração → Contas e tags.

   Para a **recepção da delegacia** (sala de espera com fila, balcão de quem libera acesso e entrega do token na própria sala), execute `supabase/recepcao.sql` depois do `patentes.sql`. Ele separa as contas em **visitante** (cidadão: só o portal público) e **integrante** (policial com ficha do efetivo); contas policiais sem ficha vinculada viram visitante, então vincule antes. O tempo real usa o Realtime do Supabase (canal público `rota-recepcao`); sem ele, as telas se atualizam a cada 15 segundos.

   Para **senha própria, manter conectado e idade na recepção**, execute `supabase/senhas.sql` depois do `recepcao.sql`. No primeiro login com o token, cada conta cria a própria senha (o token vira só recuperação). Troca de token, suspensão e desativação derrubam as sessões salvas na hora.

   Para **login por ID, remoção de integrantes e Blacklist que bloqueia acesso**, execute `supabase/integrantes.sql` depois do `senhas.sql`. O login passa a ser pelo ID no servidor (passaporte) e senha; contas antigas sem ID entram uma última vez pelo nome e registram o ID. Remover integrante, incluir e retirar da Blacklist exigem o ID e a senha de quem faz, motivo e confirmação final, e tudo fica na auditoria permanente (`rota_audit_log`, que não aceita alteração nem exclusão).

   Para a **identidade dos integrantes** (`[Patente] Nome [ID]` com foto e cor do nome por segmento), execute `supabase/identidade.sql` depois do `integrantes.sql`. As cores ficam em `rota_tags.name_color`/`color_priority` (Comando, Corregedoria, Recrutador) e há o gancho `rota_ranks.name_color` para cores por patente no futuro. As fotos ficam no bucket público `rota-avatars`; sem foto, o site usa a logo da ROTA.

   Para o **Discord** (login pelo Discord, patente/nome/ID vindos do servidor, bot `/apreensao` e `/relatorio` e relatório mensal), execute `supabase/discord.sql` depois do `identidade.sql` e configure:
   - Variáveis no Cloudflare Pages: `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` (segredo), `DISCORD_CLIENT_SECRET` (segredo), `DISCORD_GUILD_ID` (ID do servidor) e `ROTA_CRON_SECRET` (segredo, 32+ caracteres).
   - No portal do Discord (OAuth2 → Redirects): `https://SEU-SITE/api/discord/callback`. Em General Information → Interactions Endpoint URL: `https://SEU-SITE/api/discord/interactions`.
   - Comandos do bot: registrados no servidor de `DISCORD_GUILD_ID` (`PUT /applications/{id}/guilds/{guild}/commands` com `apreensao` e `relatorio`).
   - Agendamento: a pasta `worker-cron/` é um Worker com cron a cada 10 minutos (`npx wrangler deploy` dentro dela e `npx wrangler secret put ROTA_CRON_SECRET` com o mesmo valor do Pages).
   - O apelido no servidor deve seguir `[SIGLA] Nome [ID]`; os cargos são mapeados para patentes e tags em Administração → Discord. Como o Discord manda, só o comando deve poder gerenciar cargos e apelidos no servidor.

   Para **Comunicados** e **Editais**, execute `supabase/public-content.sql`. A administração publica e remove os dois pelo **Painel policial** (botões "Publicar comunicado" e "Publicar edital"), sem precisar editar o código. As inscrições só são aceitas para editais publicados e dentro do período de inscrição.

   Ao atualizar o portal, execute de novo o `supabase/schema.sql`: ele pode ser reexecutado com segurança e aplica as proteções novas (decisão única de tickets, limite de pedidos e bloqueio de tentativas de login administrativo).

5. Em **Project Settings → API Keys**, copie a URL do projeto e a chave **publishable** (ou `anon` legado). Nunca use a chave `secret`/`service_role` no navegador.
6. Na hospedagem, cadastre:

   **Variáveis comuns:**
   - `SUPABASE_URL`: URL do projeto Supabase; precisa estar disponível no build e nas Functions.
   - `SUPABASE_PUBLISHABLE_KEY`: chave publishable, também disponível no build e nas Functions. Para projetos antigos, pode usar `SUPABASE_ANON_KEY` no lugar.
   - `ROTA_ADMIN_USERNAME`: nome de usuário administrativo configurado no servidor. É uma variável comum, não uma senha.

   **Segredos das Functions (marque como secretos/criptografados):**
   - `SUPABASE_SECRET_KEY`: chave `sb_secret_...`. Para projetos que ainda só tenham a chave antiga, use `SUPABASE_SERVICE_ROLE_KEY` com a `service_role` legada.
   - `ROTA_ADMIN_PASSWORD`: senha administrativa forte, configurada somente no servidor.
   - `ROTA_SESSION_SECRET`: valor aleatório com pelo menos 32 caracteres para assinar sessões administrativas.
   - `DISCORD_WEBHOOK_URL`: opcional; URL de webhook do Discord para enviar registros de prisão.

   No Cloudflare, configure em **Workers & Pages → seu Pages project → Settings → Variables and Secrets**. Não coloque os segredos em arquivos do site, GitHub ou navegador. No Cloudflare, escolha **Encrypt** para cada segredo e salve os valores antes de fazer o deploy.

7. `build.js` injeta somente a URL e a chave pública no arquivo `dist/js/supabase-config.js`. Os segredos administrativos e a chave privada do Supabase nunca são enviados ao navegador.

## Acesso policial por token e efetivo

- Execute `supabase/roster-shared-login.sql` no SQL Editor do Supabase para criar o quadro público do efetivo e o bucket de fotos. O portal usa acesso policial individual por token; o login coletivo legado não é oferecido nem aceito pela API.
- O policial solicita um token informando o nome aprovado e escolhe entre primeiro acesso e troca de token. Ambos os pedidos ficam aguardando a aprovação em **Administração → Solicitações**. Só após a aprovação o sistema gera um token para o administrador copiar e entregar ao policial por canal privado.
- Em **Administração → Acesso policial**, o administrador pode reativar contas individuais antigas, desativar integrantes e emitir novos tokens. Contas antigas desligadas não são reativadas automaticamente.
- A entrada policial usa nome aprovado e token individual. A entrada administrativa usa credenciais próprias e abre o painel de administração, com acesso às áreas públicas e operacionais.
- Em **Administração → Efetivo ROTA**, cadastre QRA, nome completo, patente/cargo, Passaporte Legacy, admissão, nascimento, situação e foto. A lista pública **Efetivo** mostra os integrantes e abre a carteirinha funcional.
- Apenas a sessão administrativa pode aprovar pedidos, gerir contas e tokens, cadastrar ou editar o efetivo e enviar fotos. A consulta pública mostra os dados funcionais e a foto da carteirinha.
## Tickets do cidadão

Os pedidos de B.O. e Ouvidoria são armazenados no Supabase e podem ser enviados em um aparelho e analisados em outro. A equipe policial precisa entrar com uma conta aprovada para ler e decidir tickets. O cidadão consulta o status no navegador em que enviou o pedido, usando o identificador privado salvo localmente.

## Editais e candidaturas

- O mural e a ficha de inscrição são públicos; o candidato não precisa fazer login no portal policial.
- A ficha pede nome completo, RG no servidor e as dez respostas do questionário do processo seletivo. Todos os campos são obrigatórios. O ID do personagem é normalizado no servidor e controla o intervalo de 48 horas entre inscrições, mesmo em outro edital, navegador ou aparelho.
- As fichas são gravadas no Supabase pelo endpoint seguro `/api/edital-applications`; os dados não são enviados diretamente do navegador com uma chave administrativa.
- A equipe autorizada consulta as fichas em **Administração → Candidaturas**. O ID é usado para controlar o prazo; a lista completa só fica disponível na sessão administrativa.
- Para ativar ou atualizar o fluxo, execute `supabase/edital-applications.sql` no SQL Editor do Supabase antes de publicar o novo código. O script atualiza a tabela e a função de envio e pode ser executado sobre a versão anterior. A função usa as variáveis de servidor `SUPABASE_URL` e `SUPABASE_SECRET_KEY` (ou a chave legada `SUPABASE_SERVICE_ROLE_KEY`) já cadastradas no Cloudflare.
- `Minhas inscrições` mostra as candidaturas deste navegador. A regra de 48 horas e a gravação principal ficam no servidor, não dependem dessa lista local.

Os editais são publicados e removidos pela administração no **Painel policial**, com título, resumo e período de inscrição. O servidor recusa inscrições em editais inexistentes, agendados ou encerrados, e grava o título do edital cadastrado.

## Desenvolvimento local

É possível rodar o portal completo no próprio computador, sem tocar no projeto publicado:

1. Instale o Docker Desktop e suba um Supabase local com `npx supabase init` e `npx supabase start` (numa pasta separada). Execute os arquivos de `supabase/` no banco local, na mesma ordem descrita acima.
2. Crie um arquivo `.dev.vars` na raiz deste projeto com `SUPABASE_URL` (por exemplo `http://127.0.0.1:54321`), `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `ROTA_ADMIN_USERNAME`, `ROTA_ADMIN_PASSWORD` e `ROTA_SESSION_SECRET`. Os valores do Supabase local aparecem em `npx supabase status`. O `.dev.vars` está no `.gitignore` e nunca deve ser enviado ao GitHub.
3. Gere o site com essas variáveis (`node build.js`) e rode `npx wrangler pages dev dist --port 8788`.

Endereços `http://` só são aceitos para `localhost` e `127.0.0.1`; em produção a URL do Supabase continua precisando ser `https://`.
