-- Discord como fonte da identidade: mapa de cargos, vínculo das contas e configuração do bot.
-- Execute depois de identidade.sql. Pode ser executado de novo.

-- Configuração única (linha id = 1): canal do relatório mensal e último resultado da sincronização.
create table if not exists public.rota_discord_settings (
  id integer primary key default 1 check (id = 1),
  report_channel_id text not null default '',
  last_sync_at timestamptz,
  last_sync_result jsonb not null default '{}',
  last_report_month text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.rota_discord_settings (id) values (1) on conflict (id) do nothing;

-- Mapa: cada cargo do servidor corresponde a uma patente, uma tag ou "visitante".
create table if not exists public.rota_discord_roles (
  role_id text primary key check (role_id ~ '^[0-9]{5,25}$'),
  role_name text not null default '',
  kind text not null check (kind in ('patente', 'tag', 'visitante')),
  value text not null default '',
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

-- Conta ligada ao Discord (um Discord por conta).
alter table public.police_users add column if not exists discord_id text;
alter table public.police_users add column if not exists discord_username text not null default '';
alter table public.police_users add column if not exists discord_synced_at timestamptz;
-- Saiu do servidor do Discord: a conta fica desativada e volta sozinha se a pessoa retornar.
alter table public.police_users add column if not exists discord_left_at timestamptz;
alter table public.police_users drop constraint if exists police_users_discord_id_digits;
alter table public.police_users add constraint police_users_discord_id_digits check (discord_id is null or discord_id ~ '^[0-9]{5,25}$');
create unique index if not exists police_users_discord_id_uidx on public.police_users (discord_id) where discord_id is not null;

-- Blacklist também bloqueia pela conta do Discord.
alter table public.rota_blacklist add column if not exists discord_id text not null default '';
create index if not exists rota_blacklist_discord_idx on public.rota_blacklist (discord_id) where is_active = true and discord_id <> '';

-- Fichas criadas pelo Discord podem não ter data de nascimento nem de admissão.
alter table public.rota_roster alter column birth_date drop not null;
alter table public.rota_roster alter column admitted_on drop not null;

-- Entrega da sessão do login pelo Discord: código de uso único, curto, guardado só como hash.
create table if not exists public.rota_login_handoff (
  code_hash text primary key,
  session jsonb not null,
  expires_at timestamptz not null
);
create index if not exists rota_login_handoff_expires_idx on public.rota_login_handoff (expires_at);

-- Histórico: ações vindas do Discord.
alter table public.rota_tag_log drop constraint if exists rota_tag_log_action_check;
alter table public.rota_tag_log add constraint rota_tag_log_action_check check (action in (
  'criar', 'editar', 'apagar', 'dar', 'tirar', 'vincular',
  'poder', 'tirar-poder', 'suspender', 'cancelar-suspensao', 'promover', 'rebaixar', 'regra',
  'recepcao-atender', 'recepcao-aprovar', 'recepcao-recusar', 'discord'));

-- Tudo só pelo servidor (chave secreta); o navegador não lê nem grava estas tabelas.
alter table public.rota_discord_settings enable row level security;
alter table public.rota_discord_roles enable row level security;
alter table public.rota_login_handoff enable row level security;
revoke all on public.rota_discord_settings from public, anon, authenticated;
revoke all on public.rota_discord_roles from public, anon, authenticated;
revoke all on public.rota_login_handoff from public, anon, authenticated;
grant all on public.rota_discord_settings to service_role;
grant all on public.rota_discord_roles to service_role;
grant all on public.rota_login_handoff to service_role;
