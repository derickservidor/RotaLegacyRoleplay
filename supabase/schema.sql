-- ROTA Portal RP: tickets compartilhados, aprovação de integrantes e auditoria de login.
-- Execute no Supabase > SQL Editor. Operações administrativas usam as Functions do Cloudflare
-- com a chave secret/service_role guardada somente nas variáveis privadas do Cloudflare.

create extension if not exists pgcrypto;

create table if not exists public.police_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  normalized_name text,
  login_email text,
  role text not null default 'policial' check (role in ('policial', 'admin')),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.police_users add column if not exists display_name text;
alter table public.police_users add column if not exists normalized_name text;
alter table public.police_users add column if not exists login_email text;
alter table public.police_users add column if not exists role text not null default 'policial';
alter table public.police_users add column if not exists enabled boolean not null default true;
alter table public.police_users add column if not exists created_at timestamptz not null default now();
create unique index if not exists police_users_normalized_name_uidx on public.police_users (normalized_name) where normalized_name is not null;
create unique index if not exists police_users_login_email_uidx on public.police_users (login_email) where login_email is not null;

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  normalized_name text not null,
  request_type text not null check (request_type in ('acesso', 'troca_token')),
  status text not null default 'Pendente' check (status in ('Pendente', 'Aprovado', 'Recusado')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint access_request_name_length check (length(trim(display_name)) between 2 and 80 and length(normalized_name) between 2 and 80)
);
create unique index if not exists access_requests_one_pending_per_type_uidx on public.access_requests (normalized_name, request_type) where status = 'Pendente';
create index if not exists access_requests_created_idx on public.access_requests (created_at desc);

create table if not exists public.login_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  role text not null default 'policial',
  logged_at timestamptz not null default now()
);
create index if not exists login_events_logged_at_idx on public.login_events (logged_at desc);

-- Tentativas de login administrativo, usadas para bloquear força bruta.
-- client_key é um hash do IP (o endereço não é guardado em claro).
create table if not exists public.admin_login_attempts (
  id bigint generated always as identity primary key,
  client_key text not null,
  succeeded boolean not null,
  attempted_at timestamptz not null default now()
);
create index if not exists admin_login_attempts_recent_idx on public.admin_login_attempts (attempted_at desc, client_key);
alter table public.admin_login_attempts enable row level security;
revoke all on public.admin_login_attempts from public, anon, authenticated;
grant all on public.admin_login_attempts to service_role;

create table if not exists public.ouvidoria_tickets (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  tracking_token text not null,
  discord text not null,
  player text not null,
  legacy_name text not null,
  reason text not null,
  category text not null default '',
  detail text not null default '',
  status text not null default 'Pendente' check (status in ('Pendente', 'Aceito', 'Recusado')),
  created_at timestamptz not null default now(),
  decision_at timestamptz,
  constraint ouvidoria_ticket_values check (
    length(trim(discord)) between 1 and 100 and length(trim(player)) between 1 and 40 and
    length(trim(legacy_name)) between 1 and 100 and length(trim(reason)) between 1 and 1500 and length(tracking_token) = 64
  )
);

create table if not exists public.bo_tickets (
  id uuid primary key default gen_random_uuid(),
  public_id text not null unique,
  tracking_token text not null,
  discord text not null,
  player text not null,
  legacy_name text not null default '',
  reason text not null,
  category text not null,
  detail text not null,
  status text not null default 'Pendente' check (status in ('Pendente', 'Aceito', 'Recusado')),
  created_at timestamptz not null default now(),
  decision_at timestamptz,
  constraint bo_ticket_values check (
    length(trim(discord)) between 1 and 100 and length(trim(player)) between 1 and 40 and
    length(trim(category)) between 1 and 100 and length(trim(detail)) between 1 and 2000 and length(tracking_token) = 64
  )
);

create index if not exists ouvidoria_tickets_created_at_idx on public.ouvidoria_tickets (created_at desc);
create index if not exists bo_tickets_created_at_idx on public.bo_tickets (created_at desc);

alter table public.police_users enable row level security;
alter table public.access_requests enable row level security;
alter table public.login_events enable row level security;
alter table public.ouvidoria_tickets enable row level security;
alter table public.bo_tickets enable row level security;

-- Versão básica só na primeira instalação: patentes.sql, recepcao.sql e integrantes.sql a substituem por uma mais rígida.
-- Rodar este arquivo de novo não pode afrouxar a regra que já está valendo.
do $do$ begin
  if not exists (select 1 from pg_proc f join pg_namespace n on n.oid = f.pronamespace where n.nspname = 'public' and f.proname = 'is_rota_police') then
    execute $f$create function public.is_rota_police()
      returns boolean language sql stable security definer set search_path = '' as $b$
        select exists (select 1 from public.police_users p where p.user_id = (select auth.uid()) and p.enabled = true);
      $b$$f$;
  end if;
end $do$;
revoke all on function public.is_rota_police() from public, anon;
grant execute on function public.is_rota_police() to authenticated;

revoke all on public.access_requests from anon, authenticated;
revoke all on public.login_events from anon, authenticated;
revoke all on public.police_users from anon;
grant select on public.police_users to authenticated;
-- Policiais só leem os campos do atendimento (o tracking_token fica com o cidadão)
-- e só alteram a decisão; texto, contato e datas do ticket não podem ser reescritos.
revoke all on public.ouvidoria_tickets from anon, authenticated;
revoke all on public.bo_tickets from anon, authenticated;
grant insert on public.ouvidoria_tickets to anon, authenticated;
grant insert on public.bo_tickets to anon, authenticated;
grant select (public_id, status, decision_at, created_at) on public.ouvidoria_tickets to anon;
grant select (public_id, status, decision_at, created_at) on public.bo_tickets to anon;
grant select (id, public_id, discord, player, legacy_name, reason, category, detail, status, created_at, decision_at) on public.ouvidoria_tickets to authenticated;
grant select (id, public_id, discord, player, legacy_name, reason, category, detail, status, created_at, decision_at) on public.bo_tickets to authenticated;
grant update (status, decision_at) on public.ouvidoria_tickets to authenticated;
grant update (status, decision_at) on public.bo_tickets to authenticated;

-- Uma decisão só pode ser tomada uma vez: Pendente -> Aceito/Recusado.
create or replace function public.enforce_ticket_decision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status <> 'Pendente' or new.status not in ('Aceito', 'Recusado') then
    raise exception 'Este ticket já foi decidido.' using errcode = 'check_violation';
  end if;
  new.decision_at := now();
  return new;
end;
$$;
drop trigger if exists enforce_ouvidoria_ticket_decision on public.ouvidoria_tickets;
create trigger enforce_ouvidoria_ticket_decision before update on public.ouvidoria_tickets
  for each row execute function public.enforce_ticket_decision();
drop trigger if exists enforce_bo_ticket_decision on public.bo_tickets;
create trigger enforce_bo_ticket_decision before update on public.bo_tickets
  for each row execute function public.enforce_ticket_decision();

-- Freio contra spam: até 3 pedidos pendentes por passaporte e 20 pedidos por minuto no total, por tabela.
create or replace function public.limit_ticket_spam()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  pending_for_player integer;
  last_minute integer;
begin
  perform pg_advisory_xact_lock(hashtext(tg_table_name));
  execute format('select count(*) from public.%I where status = ''Pendente'' and lower(trim(player)) = lower(trim($1))', tg_table_name)
    into pending_for_player using new.player;
  if pending_for_player >= 3 then
    raise exception 'Você já tem 3 pedidos aguardando análise. Aguarde a resposta da equipe antes de enviar outro.' using errcode = 'check_violation';
  end if;
  execute format('select count(*) from public.%I where created_at > now() - interval ''1 minute''', tg_table_name)
    into last_minute;
  if last_minute >= 20 then
    raise exception 'Muitos pedidos chegando agora. Tente novamente em alguns minutos.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.limit_ticket_spam() from public, anon, authenticated;
drop trigger if exists limit_ouvidoria_ticket_spam on public.ouvidoria_tickets;
create trigger limit_ouvidoria_ticket_spam before insert on public.ouvidoria_tickets
  for each row execute function public.limit_ticket_spam();
drop trigger if exists limit_bo_ticket_spam on public.bo_tickets;
create trigger limit_bo_ticket_spam before insert on public.bo_tickets
  for each row execute function public.limit_ticket_spam();

drop policy if exists "police can read own membership" on public.police_users;
create policy "police can read own membership" on public.police_users for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "citizens submit pending ouvidoria tickets" on public.ouvidoria_tickets;
create policy "citizens submit pending ouvidoria tickets" on public.ouvidoria_tickets for insert to anon, authenticated
  with check (status = 'Pendente' and decision_at is null);
drop policy if exists "citizen reads own ouvidoria status by token" on public.ouvidoria_tickets;
create policy "citizen reads own ouvidoria status by token" on public.ouvidoria_tickets for select to anon using (
  tracking_token = coalesce(nullif((coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-ticket-token'), ''), '!no-ticket-token!')
);
-- Criada só se ainda não existir: patentes.sql a troca pela regra com patente mínima (rota_can).
do $do$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ouvidoria_tickets' and policyname = 'authorized police reads ouvidoria tickets') then
    execute $p$create policy "authorized police reads ouvidoria tickets" on public.ouvidoria_tickets for select to authenticated using ((select public.is_rota_police()))$p$;
  end if;
end $do$;
-- Criada só se ainda não existir: patentes.sql a troca pela regra com patente mínima (rota_can).
do $do$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ouvidoria_tickets' and policyname = 'authorized police decides ouvidoria tickets') then
    execute $p$create policy "authorized police decides ouvidoria tickets" on public.ouvidoria_tickets for update to authenticated using ((select public.is_rota_police())) with check ((select public.is_rota_police()))$p$;
  end if;
end $do$;

drop policy if exists "citizens submit pending bo tickets" on public.bo_tickets;
create policy "citizens submit pending bo tickets" on public.bo_tickets for insert to anon, authenticated
  with check (status = 'Pendente' and decision_at is null);
drop policy if exists "citizen reads own bo status by token" on public.bo_tickets;
create policy "citizen reads own bo status by token" on public.bo_tickets for select to anon using (
  tracking_token = coalesce(nullif((coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-ticket-token'), ''), '!no-ticket-token!')
);
-- Criada só se ainda não existir: patentes.sql a troca pela regra com patente mínima (rota_can).
do $do$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bo_tickets' and policyname = 'authorized police reads bo tickets') then
    execute $p$create policy "authorized police reads bo tickets" on public.bo_tickets for select to authenticated using ((select public.is_rota_police()))$p$;
  end if;
end $do$;
-- Criada só se ainda não existir: patentes.sql a troca pela regra com patente mínima (rota_can).
do $do$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bo_tickets' and policyname = 'authorized police decides bo tickets') then
    execute $p$create policy "authorized police decides bo tickets" on public.bo_tickets for update to authenticated using ((select public.is_rota_police())) with check ((select public.is_rota_police()))$p$;
  end if;
end $do$;

-- A chave secret/service_role usada pelas Functions do Cloudflare ignora RLS; nunca a coloque no navegador ou no GitHub.

-- Blacklist, registros de apreensão e inscrições de edital ficam nos próprios arquivos:
-- supabase/blacklist.sql, supabase/arrests.sql e supabase/edital-applications.sql.
