# ROTA — Portal de Roleplay MTA

Portal comunitário fictício para a unidade ROTA no servidor Legacy Roleplay. O site é estático, usa Supabase para tickets e autenticação, e tem funções de servidor para administração e integração com Discord.

## Hospedagem

O projeto pode continuar publicado no Netlify ou ser implantado no Cloudflare Pages. As funções do Cloudflare ficam na pasta `functions/`, na raiz do projeto; os arquivos estáticos compilados ficam em `dist/`.

**Importante:** extraia o ZIP completo e publique a partir da raiz do projeto, mantendo `functions/` ao lado de `build.js`. Não publique somente `dist/` nem abra `index.html` direto do arquivo: sem as Functions e as variáveis do Supabase, o efetivo, a blacklist e os cadastros não conseguem carregar ou salvar dados.

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

O `netlify.toml` define `node build.js`, publica `dist` e usa `netlify/functions`. Enviar uma alteração à branch conectada ao Netlify inicia um deploy automático. As rotas `/api/police-access` e `/api/arrest-notify` são encaminhadas às funções Netlify. As rotas `/api/blacklist` e `/api/arrests` usam Pages Functions do Cloudflare.

## Configurar o Supabase

1. No Supabase, abra **SQL Editor** e execute todo o arquivo `supabase/schema.sql`.
2. Para habilitar a consulta pública e as fotos da blacklist, execute também `supabase/blacklist.sql` no SQL Editor. Esse script cria/atualiza a tabela, concede leitura pública somente dos campos exibidos e cria o bucket público das imagens. Cidadãos e policiais podem consultar; somente uma sessão de administrador pode incluir ou remover registros.
3. Cada registro público exibe a foto do personagem, nome e Passaporte Legacy. Cadastre somente personagens e fatos fictícios do roleplay. As fotos ficam acessíveis publicamente no bucket `rota-blacklist-photos`.
4. Para o livro compartilhado de prisões e as fotos de apreensão, execute (ou execute novamente) `supabase/arrests.sql` antes de publicar. O script atualiza as colunas de armas e imagens e cria o bucket privado `rota-arrest-photos`; listar, registrar, anexar imagens e remover exigem uma conta policial autorizada. As fotos recebem links temporários e só aparecem na área policial.

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

   No Netlify, configure em **Project configuration → Environment variables**. No Cloudflare, configure em **Workers & Pages → seu Pages project → Settings → Variables and Secrets**. Não coloque os segredos em arquivos do site, GitHub ou navegador. No Cloudflare, escolha **Encrypt** para cada segredo e salve os valores antes de fazer o deploy.

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

O edital incluído no pacote é demonstrativo. Atualize título, critérios e prazos para o processo seletivo real antes de divulgá-lo.
