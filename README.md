# ROTA — Portal de Roleplay MTA

Portal comunitário fictício para a unidade ROTA no servidor Legacy Roleplay. O site é estático, usa Supabase para tickets e autenticação, e tem funções de servidor para administração e integração com Discord.

## Hospedagem

O projeto pode continuar publicado no Netlify ou ser implantado no Cloudflare Pages. As funções do Cloudflare ficam na pasta `functions/`, na raiz do projeto; os arquivos estáticos compilados ficam em `dist/`.

### Cloudflare Pages

1. Envie estes arquivos atualizados ao GitHub e crie um projeto Pages conectado ao repositório e à branch `main`. Use integração Git; o envio direto de arquivos pelo painel não publica as Pages Functions.
2. Na configuração de build do Pages, use:
   - **Root directory:** deixe o padrão (raiz do repositório, onde aparecem `index.html`, `build.js` e `functions/`).
   - **Build command:** `node build.js`.
   - **Build output directory:** `dist`.
3. Em **Settings → Variables and Secrets**, adicione as variáveis e segredos da seção Supabase abaixo para **Production**. Configure Preview também caso vá testar deploys de preview. A URL e a chave pública precisam estar disponíveis no build; os segredos são lidos pelas Functions em runtime.
4. Faça o deploy e teste primeiro no endereço `*.pages.dev`. Mantenha o Netlify ativo até confirmar login, pedidos de acesso, tickets no celular/PC e a integração opcional com Discord. Só depois aponte um domínio próprio para o Cloudflare.

O build cria `dist/_routes.json` para encaminhar somente `/api/*` às Pages Functions; o conteúdo estático continua sendo servido pela CDN. O Netlify mantém a mesma rota `/api/*` por meio do redirecionamento em `netlify.toml`.

### Netlify

O `netlify.toml` define `node build.js`, publica `dist` e usa `netlify/functions`. Enviar uma alteração à branch conectada ao Netlify inicia um deploy automático. As novas rotas `/api/police-access` e `/api/arrest-notify` também são encaminhadas às funções Netlify.

## Configurar o Supabase

1. No Supabase, abra **SQL Editor** e execute todo o arquivo `supabase/schema.sql`.
2. Em **Project Settings → API Keys**, copie a URL do projeto e a chave **publishable** (ou `anon` legado). Nunca use a chave `secret`/`service_role` no navegador.
3. Na hospedagem, cadastre:

   **Variáveis comuns:**
   - `SUPABASE_URL`: URL do projeto Supabase; precisa estar disponível no build e nas Functions.
   - `SUPABASE_PUBLISHABLE_KEY`: chave publishable, também disponível no build e nas Functions. Para projetos antigos, pode usar `SUPABASE_ANON_KEY` no lugar.
   - `ROTA_ADMIN_USERNAME`: nome de usuário administrativo configurado no servidor. É uma variável comum, não uma senha.

   **Segredos das Functions (marque como secretos/criptografados):**
   - `SUPABASE_SECRET_KEY`: chave `sb_secret_...`. Para projetos que ainda só tenham a chave antiga, use `SUPABASE_SERVICE_ROLE_KEY` com a `service_role` legada.
   - `ROTA_ADMIN_PASSWORD`: senha administrativa forte, configurada somente no servidor.
   - `ROTA_SESSION_SECRET`: valor aleatório com pelo menos 32 caracteres para assinar sessões administrativas.
   - `DISCORD_WEBHOOK_URL`: opcional; URL de webhook do Discord para enviar registros de prisão.

   No Netlify, configure em **Project configuration → Environment variables**. No Cloudflare, configure em **Workers & Pages → seu Pages project → Settings → Variables and Secrets**. Não coloque os segredos em arquivos do site, GitHub ou navegador. No Cloudflare, escolha **Encrypt** para cada segredo e salve os valores antes de fazer o deploy.

4. `build.js` injeta somente a URL e a chave pública no arquivo `dist/js/supabase-config.js`. Os segredos administrativos e a chave privada do Supabase nunca são enviados ao navegador.

## Login policial e tokens

- O policial abre **Login → Solicitar acesso** e informa somente seu nome.
- O administrador abre **Login → Administrador**, entra com as credenciais configuradas no servidor e analisa **Administração → Solicitações**.
- Ao aprovar, o servidor cria a conta Supabase e mostra um token aleatório uma única vez. O administrador copia e envia o token ao policial por mensagem privada.
- No login policial, o integrante informa o mesmo nome aprovado e o token. O token continua válido até a administração emitir outro.
- Se esquecer, o policial pede troca de token usando o nome. O administrador aprova o pedido ou troca diretamente pela aba **Contas e tokens**. O token antigo deixa de funcionar para novos logins.
- A administração pode desativar e reativar contas, consultar solicitações e acompanhar os logins registrados.
- A página consulta logins a cada 15 segundos enquanto a sessão administrativa está aberta. Para alertas, permita notificações do navegador. O navegador precisa ficar aberto e conectado; não é um alerta push quando o administrador estiver offline.

O nome deve ser digitado da mesma forma nos pedidos e no login. Solicitações públicas não são aprovadas automaticamente. Confira a identidade do integrante pelo canal oficial do servidor antes de entregar o token.

## Tickets do cidadão

Os pedidos de B.O. e Ouvidoria são armazenados no Supabase e podem ser enviados em um aparelho e analisados em outro. A equipe policial precisa entrar com uma conta aprovada para ler e decidir tickets. O cidadão consulta o status no navegador em que enviou o pedido, usando o identificador privado salvo localmente.

## Integração de prisões com Discord

O formulário de prisão chama `/api/arrest-notify`. Para enviar registros a um canal, crie um webhook no Discord e cadastre sua URL como `DISCORD_WEBHOOK_URL` nas variáveis/segredos do servidor. Nunca salve o webhook nos arquivos públicos.

## Conteúdo do portal

- Gestão do cidadão, comunicados, formulário de B.O. e tickets de Ouvidoria.
- Painel policial, registros fictícios de prisão, operações, efetivo, recrutamento e procurados RP.
- Código penal RP com calculadora de penas e regras de não-somatória em roubos.
- Página da Cidade Legacy com links para Discord, diretrizes e Instagram.

As informações operacionais que ainda usam armazenamento do navegador não são compartilhadas entre usuários. O portal é exclusivamente para roleplay e não tem validade oficial.
