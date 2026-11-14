-- Ficha do efetivo Inativa ou conta removida não contam como policial no banco.
-- Execute no Supabase > SQL Editor depois do discord.sql. Pode ser executado de novo com segurança.

create or replace function public.is_rota_police()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.police_users p
    join public.rota_roster r on r.id = p.roster_id
    where p.user_id = (select auth.uid()) and p.enabled = true and p.removed_at is null
      and p.role = 'policial' and r.status = 'Ativo'
      and (p.suspended_until is null or p.suspended_until <= now()));
$$;
revoke all on function public.is_rota_police() from public, anon;
grant execute on function public.is_rota_police() to authenticated;

create or replace function public.rota_can(area_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.is_rota_police()
  and public.rota_user_level((select auth.uid())) >= coalesce((select r.level from public.rota_area_rules a
    join public.rota_ranks r on r.rank = a.min_rank where a.area = area_name), 0);
$$;
revoke all on function public.rota_can(text) from public, anon;
grant execute on function public.rota_can(text) to authenticated;
