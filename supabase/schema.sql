-- ROTA Portal RP: tickets compartilhados, aprovação de integrantes e auditoria de login.
-- Execute no Supabase > SQL Editor. Operações administrativas usam a Netlify Function
-- com a chave secret/service_role guardada somente nas variáveis privadas do Netlify.

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

create or replace function public.is_rota_police()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.police_users p where p.user_id = (select auth.uid()) and p.enabled = true);
$$;
revoke all on function public.is_rota_police() from public, anon;
grant execute on function public.is_rota_police() to authenticated;

revoke all on public.access_requests from anon, authenticated;
revoke all on public.login_events from anon, authenticated;
revoke all on public.police_users from anon;
grant select on public.police_users to authenticated;
grant insert, select on public.ouvidoria_tickets to anon, authenticated;
grant update, select on public.ouvidoria_tickets to authenticated;
grant insert, select on public.bo_tickets to anon, authenticated;
grant update, select on public.bo_tickets to authenticated;

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
drop policy if exists "authorized police reads ouvidoria tickets" on public.ouvidoria_tickets;
create policy "authorized police reads ouvidoria tickets" on public.ouvidoria_tickets for select to authenticated
  using ((select public.is_rota_police()));
drop policy if exists "authorized police decides ouvidoria tickets" on public.ouvidoria_tickets;
create policy "authorized police decides ouvidoria tickets" on public.ouvidoria_tickets for update to authenticated
  using ((select public.is_rota_police())) with check ((select public.is_rota_police()));

drop policy if exists "citizens submit pending bo tickets" on public.bo_tickets;
create policy "citizens submit pending bo tickets" on public.bo_tickets for insert to anon, authenticated
  with check (status = 'Pendente' and decision_at is null);
drop policy if exists "citizen reads own bo status by token" on public.bo_tickets;
create policy "citizen reads own bo status by token" on public.bo_tickets for select to anon using (
  tracking_token = coalesce(nullif((coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-ticket-token'), ''), '!no-ticket-token!')
);
drop policy if exists "authorized police reads bo tickets" on public.bo_tickets;
create policy "authorized police reads bo tickets" on public.bo_tickets for select to authenticated
  using ((select public.is_rota_police()));
drop policy if exists "authorized police decides bo tickets" on public.bo_tickets;
create policy "authorized police decides bo tickets" on public.bo_tickets for update to authenticated
  using ((select public.is_rota_police())) with check ((select public.is_rota_police()));

-- A chave secret/service_role usada pela Netlify Function ignora RLS; nunca a coloque no navegador ou no GitHub.


-- Atualiza a ficha pública de recrutamento da ROTA e mantém o intervalo de 48 horas por ID MTA.
-- Execute no Supabase > SQL Editor. É seguro executar também se a tabela antiga já existir.

create extension if not exists pgcrypto;

create table if not exists public.edital_applications (
  id uuid primary key default gen_random_uuid(),
  edital_id text not null,
  edital_title text not null,
  candidate_name text not null,
  player_id text not null,
  candidate_hash text not null,
  discord text not null default '',
  availability text not null default 'Variável' check (availability in ('Noite', 'Tarde', 'Manhã', 'Variável')),
  motivation text not null,
  full_name text,
  server_rg text,
  real_age integer,
  rp_experience text,
  police_experience text,
  roleplay_definition text,
  metagaming_definition text,
  powergaming_definition text,
  why_pmce text,
  character_story text,
  status text not null default 'Pendente' check (status in ('Pendente', 'Aprovado', 'Reprovado')),
  created_at timestamptz not null default now(),
  constraint edital_application_values check (
    length(trim(edital_id)) between 1 and 100 and
    length(trim(edital_title)) between 1 and 160 and
    length(trim(candidate_name)) between 2 and 100 and
    length(trim(player_id)) between 1 and 40 and
    length(candidate_hash) = 64 and
    length(trim(discord)) <= 100 and
    length(trim(motivation)) between 5 and 1500
  )
);

-- Migração idempotente para quem já executou a versão anterior do SQL.
alter table public.edital_applications add column if not exists full_name text;
alter table public.edital_applications add column if not exists server_rg text;
alter table public.edital_applications add column if not exists real_age integer;
alter table public.edital_applications add column if not exists rp_experience text;
alter table public.edital_applications add column if not exists police_experience text;
alter table public.edital_applications add column if not exists roleplay_definition text;
alter table public.edital_applications add column if not exists metagaming_definition text;
alter table public.edital_applications add column if not exists powergaming_definition text;
alter table public.edital_applications add column if not exists why_pmce text;
alter table public.edital_applications add column if not exists character_story text;

-- Colunas mantidas para compatibilidade com inscrições antigas.
alter table public.edital_applications alter column discord set default '';
alter table public.edital_applications alter column availability set default 'Variável';

create index if not exists edital_applications_candidate_created_idx
  on public.edital_applications (candidate_hash, created_at desc);
create index if not exists edital_applications_created_idx
  on public.edital_applications (created_at desc);

alter table public.edital_applications enable row level security;
revoke all on public.edital_applications from public, anon, authenticated;

create or replace function public.check_public_edital_application_cooldown(p_candidate_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last timestamptz;
  v_available_at timestamptz;
  v_can_apply boolean;
  v_remaining integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'not allowed';
  end if;
  if p_candidate_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'candidate hash invalid';
  end if;
  select max(created_at) into v_last
  from public.edital_applications
  where candidate_hash = p_candidate_hash;
  if v_last is null then
    return pg_catalog.jsonb_build_object('canApply', true, 'availableAt', null, 'remainingSeconds', 0);
  end if;
  v_available_at := v_last + interval '48 hours';
  v_can_apply := v_available_at <= pg_catalog.now();
  v_remaining := greatest(0, ceil(extract(epoch from (v_available_at - pg_catalog.now())))::integer);
  return pg_catalog.jsonb_build_object('canApply', v_can_apply, 'availableAt', v_available_at, 'remainingSeconds', v_remaining);
end;
$$;

drop function if exists public.submit_public_edital_application(text, text, text, text, text, text, text, text);

create or replace function public.submit_public_edital_application(
  p_edital_id text,
  p_edital_title text,
  p_full_name text,
  p_server_rg text,
  p_candidate_name text,
  p_player_id text,
  p_real_age integer,
  p_rp_experience text,
  p_police_experience text,
  p_roleplay_definition text,
  p_metagaming_definition text,
  p_powergaming_definition text,
  p_why_pmce text,
  p_character_story text,
  p_candidate_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cooldown jsonb;
  v_id uuid;
  v_created_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'not allowed';
  end if;
  if p_candidate_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'candidate hash invalid';
  end if;
  if p_real_age is null or p_real_age < 1 or p_real_age > 120 then
    raise exception using errcode = '22023', message = 'real age invalid';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_candidate_hash, 0));
  v_cooldown := public.check_public_edital_application_cooldown(p_candidate_hash);
  if coalesce((v_cooldown ->> 'canApply')::boolean, false) = false then
    return v_cooldown || pg_catalog.jsonb_build_object('allowed', false);
  end if;
  insert into public.edital_applications (
    edital_id, edital_title, candidate_name, player_id, candidate_hash,
    discord, availability, motivation, full_name, server_rg, real_age,
    rp_experience, police_experience, roleplay_definition, metagaming_definition,
    powergaming_definition, why_pmce, character_story
  ) values (
    p_edital_id, p_edital_title, p_candidate_name, p_player_id, p_candidate_hash,
    '', 'Variável', p_why_pmce, p_full_name, p_server_rg, p_real_age,
    p_rp_experience, p_police_experience, p_roleplay_definition, p_metagaming_definition,
    p_powergaming_definition, p_why_pmce, p_character_story
  ) returning id, created_at into v_id, v_created_at;
  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'id', v_id,
    'createdAt', v_created_at,
    'availableAt', v_created_at + interval '48 hours'
  );
end;
$$;

revoke all on function public.check_public_edital_application_cooldown(text) from public, anon, authenticated;
revoke all on function public.submit_public_edital_application(text, text, text, text, text, text, integer, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.check_public_edital_application_cooldown(text) to service_role;
grant execute on function public.submit_public_edital_application(text, text, text, text, text, text, integer, text, text, text, text, text, text, text, text) to service_role;


-- Blacklist pública da ROTA RP. Só a sessão de administrador do portal altera registros.

create extension if not exists pgcrypto;

create table if not exists public.rota_blacklist (
  id uuid primary key default gen_random_uuid(),
  character_name text not null,
  player_id text not null,
  reason text not null default 'Inclusão administrativa na blacklist RP.',
  photo_path text not null default '',
  photo_url text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  is_active boolean not null default true,
  removed_by uuid references auth.users(id) on delete set null,
  removed_at timestamptz,
  constraint rota_blacklist_character_name_length check (length(trim(character_name)) between 2 and 80),
  constraint rota_blacklist_player_id_length check (length(trim(player_id)) between 1 and 24),
  constraint rota_blacklist_reason_length check (length(trim(reason)) between 3 and 500)
);

create index if not exists rota_blacklist_active_created_idx
  on public.rota_blacklist (created_at desc) where is_active = true;

alter table public.rota_blacklist enable row level security;
revoke all on public.rota_blacklist from public, anon, authenticated;
grant all on public.rota_blacklist to service_role;

alter table public.rota_blacklist add column if not exists photo_path text not null default '';
alter table public.rota_blacklist add column if not exists photo_url text not null default '';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rota-blacklist-photos', 'rota-blacklist-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;


-- Livro compartilhado de registros de prisão RP.
-- Execute no Supabase > SQL Editor para persistir os registros da equipe.

create extension if not exists pgcrypto;

create table if not exists public.arrest_records (
  id uuid primary key default gen_random_uuid(),
  character_name text not null,
  player_id text not null,
  discord text not null default '',
  officer text not null,
  place text not null default '',
  weapon text not null,
  weapons text[] not null default '{}',
  person_photo_path text not null default '',
  inventory_photo_path text not null default '',
  has_c4 text not null check (has_c4 in ('Sim', 'Não')),
  has_dirty_money text not null check (has_dirty_money in ('Sim', 'Não')),
  dirty_money_amount bigint not null default 0 check (dirty_money_amount between 0 and 999999999),
  has_drugs text not null check (has_drugs in ('Sim', 'Não')),
  drug_amount integer not null default 0 check (drug_amount between 0 and 99999999),
  reason text not null,
  sentence text not null,
  detail text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  is_active boolean not null default true,
  removed_by uuid references auth.users(id) on delete set null,
  removed_at timestamptz,
  constraint arrest_records_character_length check (length(trim(character_name)) between 1 and 80),
  constraint arrest_records_player_id_length check (length(trim(player_id)) between 1 and 24),
  constraint arrest_records_discord_length check (length(trim(discord)) <= 100),
  constraint arrest_records_officer_length check (length(trim(officer)) between 1 and 80),
  constraint arrest_records_weapon_length check (length(trim(weapon)) between 1 and 100),
  constraint arrest_records_reason_length check (length(trim(reason)) between 1 and 250),
  constraint arrest_records_sentence_length check (length(trim(sentence)) between 1 and 60),
  constraint arrest_records_detail_length check (length(trim(detail)) between 1 and 1500)
);

create index if not exists arrest_records_active_created_idx
  on public.arrest_records (created_at desc) where is_active = true;

alter table public.arrest_records enable row level security;
revoke all on public.arrest_records from public, anon, authenticated;
grant all on public.arrest_records to service_role;

-- Migração para inventário em checklist e fotos privadas do registro de apreensão.
alter table public.arrest_records add column if not exists weapons text[] not null default '{}';
alter table public.arrest_records add column if not exists person_photo_path text not null default '';
alter table public.arrest_records add column if not exists inventory_photo_path text not null default '';
alter table public.arrest_records alter column place set default '';
alter table public.arrest_records drop constraint if exists arrest_records_place_length;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rota-arrest-photos', 'rota-arrest-photos', false, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
