-- =====================================================================
-- 0002 — permessi giocatore estesi, Pokémon di squadra, icona dell'app
-- (da eseguire dopo 0001_init.sql)
-- =====================================================================

-- ---------- Impostazioni condivise (icona dell'app) ------------------
create table if not exists public.app_settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.app_settings (id) values (1) on conflict do nothing;

alter table public.app_settings enable row level security;

-- Lettura anche senza login: serve alla schermata di accesso e alla build dell'APK (contiene solo l'URL dell'icona)
drop policy if exists settings_select on public.app_settings;
create policy settings_select on public.app_settings for select to anon, authenticated using (true);
drop policy if exists settings_write on public.app_settings;
create policy settings_write on public.app_settings for all to authenticated
  using (public.is_master()) with check (public.is_master());

revoke all on public.app_settings from anon;
grant select on public.app_settings to anon;
grant select, insert, update, delete on public.app_settings to authenticated;

create or replace function public.patch_settings(p_patch jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.app_settings
  set data = jsonb_strip_nulls(data || p_patch),
      updated_at = now(),
      updated_by = auth.uid()
  where id = 1;
  if not found then
    raise exception 'Impostazioni non modificabili' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public.patch_settings(jsonb) from public, anon;
grant execute on function public.patch_settings(jsonb) to authenticated;

-- ---------- Pokémon: i giocatori modificano solo quelli della propria squadra ----
-- Campi consentiti al giocatore: precisione, danno, oggetto, attributi, skill, note.
create or replace function public.pk_key_ok(k text)
returns boolean
language sql
immutable
as $$
  select k ~ '^(Quick References: (Precisione|Danno|Oggetto)|Attributi (Fisici|Sociali): .+|Skill (di Lotta|di Sopravvivenza|Sociali): .+|Note)$';
$$;

-- Il Pokémon n è nella squadra dell'allenatore di cui sono proprietario?
-- (l'app scrive in player_data le chiavi "SqN 1".."SqN 6" con il numero del Pokémon)
create or replace function public.pk_in_team(p_n int)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trainers t
    where t.owner_id = auth.uid()
      and p_n::text in (
        t.player_data ->> 'SqN 1', t.player_data ->> 'SqN 2', t.player_data ->> 'SqN 3',
        t.player_data ->> 'SqN 4', t.player_data ->> 'SqN 5', t.player_data ->> 'SqN 6')
  );
$$;

create or replace function public.pokemon_state_guard()
returns trigger
language plpgsql
as $$
declare
  k text;
  o jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else old.data end;
begin
  if not public.is_master() then
    if tg_op = 'UPDATE' and new.n is distinct from old.n then
      raise exception 'Solo il master può modificare questi dati' using errcode = '42501';
    end if;
    for k in
      select jsonb_object_keys(coalesce(new.data, '{}'::jsonb))
      union
      select jsonb_object_keys(o)
    loop
      if (new.data -> k) is distinct from (o -> k) and not public.pk_key_ok(k) then
        raise exception 'Campo non modificabile dal giocatore: %', k using errcode = '42501';
      end if;
    end loop;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists pokemon_state_guard on public.pokemon_state;
create trigger pokemon_state_guard
  before insert or update on public.pokemon_state
  for each row execute function public.pokemon_state_guard();

drop policy if exists pokemon_player_insert on public.pokemon_state;
create policy pokemon_player_insert on public.pokemon_state for insert to authenticated
  with check (public.pk_in_team(n));
drop policy if exists pokemon_player_update on public.pokemon_state;
create policy pokemon_player_update on public.pokemon_state for update to authenticated
  using (public.pk_in_team(n)) with check (public.pk_in_team(n));

-- ---------- Realtime -------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_settings'
  ) then
    alter publication supabase_realtime add table public.app_settings;
  end if;
end $$;
