-- Efetivo público ROTA e armazenamento das fotos das carteirinhas.
-- O arquivo mantém o nome legado, mas só cria recursos usados pelo efetivo público.
-- As gravações passam pelo servidor com a chave secreta; o visitante só lê o quadro público.

create extension if not exists pgcrypto;

create table if not exists public.rota_roster (
  id uuid primary key default gen_random_uuid(),
  qra text not null,
  full_name text not null,
  rank text not null,
  passport text not null,
  admitted_on date not null,
  birth_date date not null,
  status text not null check (status in ('Ativo', 'Inativo')),
  photo_path text not null,
  photo_url text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rota_roster_values check (
    length(trim(qra)) between 2 and 40 and
    length(trim(full_name)) between 3 and 100 and
    length(trim(rank)) between 2 and 60 and
    length(trim(passport)) between 1 and 40
  )
);
create unique index if not exists rota_roster_qra_uidx on public.rota_roster (lower(qra));
create unique index if not exists rota_roster_passport_uidx on public.rota_roster (passport);
create index if not exists rota_roster_status_qra_idx on public.rota_roster (status, qra);
alter table public.rota_roster enable row level security;
revoke all on public.rota_roster from anon, authenticated;
grant select on public.rota_roster to anon, authenticated;
grant all on public.rota_roster to service_role;
drop policy if exists "public can view ROTA roster" on public.rota_roster;
create policy "public can view ROTA roster" on public.rota_roster for select to anon, authenticated using (true);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rota-roster-photos', 'rota-roster-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = excluded.allowed_mime_types;

-- Nenhuma política de escrita pública é criada para a tabela ou para o bucket.
-- O servidor usa SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY e valida a sessão admin.
