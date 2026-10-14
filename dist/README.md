# ROTA — Portal de Roleplay MTA

Portal comunitário fictício para a unidade ROTA no servidor Legacy Roleplay. O projeto é estático e publica pelo Netlify; funções administrativas e de autenticação ficam em `netlify/functions`.

## Publicar alterações

Envie o conteúdo desta pasta ao repositório GitHub ligado ao Netlify. O arquivo `netlify.toml` define `node build.js`, publica `dist` e envia as funções de `netlify/functions`. Cada atualização enviada à branch configurada inicia um novo deploy.

## Configurar o Supabase

1. No Supabase, abra **SQL Editor** e execute todo o arquivo `supabase/schema.sql`.
2. Em **Project Settings → API**, copie a URL do projeto e a chave **publishable** (ou `anon` legado). Não use a chave `secret`/`service_role` no navegador.
3. No Netlify, abra **Project configuration → Environment variables** e configure as variáveis abaixo. `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` (ou `SUPABASE_ANON_KEY`) precisam estar disponíveis no **build** e nas **Functions**. O build injeta somente esses dois valores públicos em `dist/js/supabase-config.js`, para os tickets funcionarem entre dispositivos. Como alternativa, a URL e a chave pública já podem ficar em `js/supabase-config.js`; o build mantém esses valores como fallback:

   - `SUPABASE_URL`: URL do projeto Supabase.
   - `SUPABASE_PUBLISHABLE_KEY`: chave publishable (ou use `SUPABASE_ANON_KEY` com a chave anon antiga). É pública.
   - `SUPABASE_SECRET_KEY`: chave `sb_secret_...` do Supabase; restrinja às **Functions** e nunca a publique no GitHub ou navegador. Para projeto que ainda só tenha a chave antiga, use `SUPABASE_SERVICE_ROLE_KEY` com a `service_role` legada.
   - `ROTA_ADMIN_USERNAME`: usuário administrativo. O padrão é `derickadm`.
   - `ROTA_ADMIN_PASSWORD`: defina uma senha nova e forte para o administrador. Ela é validada no servidor e não fica no HTML, JavaScript ou Git.
   - `ROTA_SESSION_SECRET`: segredo aleatório com no mínimo 32 caracteres para assinar a sessão administrativa. Gere um valor com `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` e cole diretamente nas variáveis do Netlify. Restrinja às **Functions**.

4. Confirme os escopos descritos e faça um novo deploy depois de salvar todas as variáveis.

Não coloque `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ROTA_ADMIN_PASSWORD`, `ROTA_SESSION_SECRET` ou o webhook do Discord em arquivos do site.

## Login policial e tokens

- O policial abre **Login → Solicitar acesso** e informa somente seu nome.
- O administrador abre **Login → Administrador**, entra com a credencial configurada no Netlify e analisa a aba **Administração → Solicitações**.
- Ao aprovar, o servidor cria a conta Supabase e mostra um token aleatório uma única vez. O administrador copia e envia o token ao policial por mensagem privada.
- No login policial, o integrante informa o mesmo nome aprovado e o token. O token continua válido até a administração gerar outro.
- Se esquecer, o policial pede troca de token usando o nome. O administrador aprova o pedido ou troca diretamente pela aba **Contas e tokens**. O token antigo deixa de funcionar para novos logins.
- A administração pode desativar e reativar contas, consultar solicitações e acompanhar os logins registrados.
- A página consulta logins a cada 15 segundos enquanto a sessão administrativa está aberta. Para alertas do sistema, permita as notificações do navegador. O navegador precisa estar aberto e conectado; isto não é um alerta push quando o administrador estiver offline.

O nome é usado para identificar a conta e deve ser digitado da mesma forma nos pedidos e no login. Solicitações públicas não são aprovadas automaticamente. Confira a identidade do integrante pelo canal oficial do servidor antes de entregar o token.

## Tickets do cidadão

Os pedidos de B.O. e Ouvidoria são armazenados no Supabase e podem ser enviados em um aparelho e analisados em outro. A equipe policial precisa entrar com uma conta aprovada para ler e decidir tickets. O cidadão consulta o status no navegador em que enviou o pedido, usando o identificador privado salvo localmente.

## Integração de prisões com Discord

O formulário de prisão chama `/.netlify/functions/arrest-notify`. Para enviar registros a um canal, crie um webhook no Discord e cadastre a URL na variável Netlify `DISCORD_WEBHOOK_URL`, com escopo **Functions**. Nunca salve o webhook nos arquivos públicos.

## Conteúdo do portal

- Gestão do cidadão, comunicados, formulário de B.O. e tickets de Ouvidoria.
- Painel policial, registros fictícios de prisão, operações, efetivo, recrutamento e procurados RP.
- Código penal RP com calculadora de penas e regras de não-somatória em roubos.
- Página da Cidade Legacy com links para Discord, diretrizes e Instagram.

As informações operacionais que ainda usam armazenamento do navegador não são compartilhadas entre usuários. O portal é exclusivamente para roleplay e não tem validade oficial.
