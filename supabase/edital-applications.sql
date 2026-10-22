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
