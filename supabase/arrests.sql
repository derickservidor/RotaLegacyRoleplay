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
