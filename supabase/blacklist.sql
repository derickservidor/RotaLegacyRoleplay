-- Blacklist pública da ROTA RP. Execute este arquivo no Supabase > SQL Editor.
-- Só a sessão de administrador do portal pode incluir/remover registros.
-- Cidadãos e policiais consultam a lista pública; fotos também ficam públicas.

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

-- Migração para instalações que já possuem a blacklist antiga.
alter table public.rota_blacklist add column if not exists photo_path text not null default '';
alter table public.rota_blacklist add column if not exists photo_url text not null default '';

create index if not exists rota_blacklist_active_created_idx
  on public.rota_blacklist (created_at desc) where is_active = true;

alter table public.rota_blacklist enable row level security;
revoke all on public.rota_blacklist from public, anon, authenticated;
grant select (id, character_name, player_id, photo_url, created_at, is_active) on public.rota_blacklist to anon, authenticated;
grant all on public.rota_blacklist to service_role;
drop policy if exists "public can view active ROTA blacklist entries" on public.rota_blacklist;
create policy "public can view active ROTA blacklist entries" on public.rota_blacklist for select to anon, authenticated using (is_active = true);

-- Bucket público para visualização das fotos; os uploads são feitos pela API
-- da Cloudflare usando a chave secreta do servidor, nunca pelo navegador.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rota-blacklist-photos', 'rota-blacklist-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
