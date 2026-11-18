-- =====================================================================
-- Pokédex Lentinia — schema iniziale
-- Esegui questo file nel SQL Editor di Supabase (oppure `supabase db push`).
-- =====================================================================

-- ---------- Profili (uno per account di accesso) ----------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null unique check (username ~ '^[a-z0-9._-]{3,32}$'),
  role       text not null default 'player' check (role in ('master', 'player')),
  created_at timestamptz not null default now()
);

-- Funzione usata da tutte le policy. SECURITY DEFINER per evitare ricorsioni con la RLS di profiles.
create or replace function public.is_master()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'master');
$$;

-- Alla creazione di un utente (Auth) nasce il profilo, sempre come 'player'.
-- Il master si promuove a mano (vedi README).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    lower(coalesce(new.raw_user_meta_data ->> 'username', split_part(new.email, '@', 1)))
  )
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Allenatori ------------------------------------------------
-- master_data : statistiche, nome, concept, soldi, foto... (solo master)
-- player_data : squadra, achievement, pozioni, inventario, medaglie, note, rank (master o proprietario)
create table if not exists public.trainers (
  id          uuid primary key default gen_random_uuid(),
  position    int  not null default 0,
  owner_id    uuid references public.profiles(id) on delete set null,
  master_data jsonb not null default '{}'::jsonb,
  player_data jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create unique index if not exists trainers_owner_uidx on public.trainers (owner_id) where owner_id is not null;

-- Un giocatore può cambiare solo player_data. Tutto il resto è riservato al master.
create or replace function public.trainers_guard()
returns trigger
language plpgsql
as $$
begin
  if not public.is_master() then
    if new.id is distinct from old.id
       or new.master_data is distinct from old.master_data
       or new.owner_id is distinct from old.owner_id
       or new.position is distinct from old.position then
      raise exception 'Solo il master può modificare questi dati' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trainers_guard on public.trainers;
create trigger trainers_guard
  before update on public.trainers
  for each row execute function public.trainers_guard();

-- ---------- Pokédex (override e flag Incontrato/Catturato) -----------
create table if not exists public.pokemon_state (
  n          int primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- ---------- Mappa (una sola riga) ------------------------------------
create table if not exists public.map_state (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.map_state (id) values (1) on conflict do nothing;

-- ---------- Row Level Security ---------------------------------------
alter table public.profiles      enable row level security;
alter table public.trainers      enable row level security;
alter table public.pokemon_state enable row level security;
alter table public.map_state     enable row level security;

-- profiles: tutti gli utenti loggati leggono, solo il master modifica
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);
drop policy if exists profiles_master_write on public.profiles;
create policy profiles_master_write on public.profiles for all to authenticated
  using (public.is_master()) with check (public.is_master());

-- trainers: lettura per tutti; il giocatore aggiorna solo la propria scheda; il master tutto
drop policy if exists trainers_select on public.trainers;
create policy trainers_select on public.trainers for select to authenticated using (true);
drop policy if exists trainers_insert on public.trainers;
create policy trainers_insert on public.trainers for insert to authenticated with check (public.is_master());
drop policy if exists trainers_update on public.trainers;
create policy trainers_update on public.trainers for update to authenticated
  using (public.is_master() or owner_id = auth.uid())
  with check (public.is_master() or owner_id = auth.uid());
drop policy if exists trainers_delete on public.trainers;
create policy trainers_delete on public.trainers for delete to authenticated using (public.is_master());

-- pokemon_state e map_state: lettura per tutti, scrittura solo master
drop policy if exists pokemon_select on public.pokemon_state;
create policy pokemon_select on public.pokemon_state for select to authenticated using (true);
drop policy if exists pokemon_write on public.pokemon_state;
create policy pokemon_write on public.pokemon_state for all to authenticated
  using (public.is_master()) with check (public.is_master());

drop policy if exists map_select on public.map_state;
create policy map_select on public.map_state for select to authenticated using (true);
drop policy if exists map_write on public.map_state;
create policy map_write on public.map_state for all to authenticated
  using (public.is_master()) with check (public.is_master());

-- Nessun accesso anonimo
revoke all on public.profiles, public.trainers, public.pokemon_state, public.map_state from anon;
grant select, insert, update, delete on public.profiles, public.trainers, public.pokemon_state, public.map_state to authenticated;

-- ---------- RPC di "patch" -------------------------------------------
-- Uniscono SOLO le chiavi inviate (un valore null cancella la chiave): due persone che
-- modificano campi diversi della stessa scheda non si sovrascrivono a vicenda.
-- Sono SECURITY INVOKER: valgono RLS e trigger di sopra.
create or replace function public.patch_trainer(
  p_id uuid,
  p_master jsonb default '{}'::jsonb,
  p_player jsonb default '{}'::jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.trainers
  set master_data = case
        when p_master is null or p_master = '{}'::jsonb then master_data
        else jsonb_strip_nulls(master_data || p_master) end,
      player_data = case
        when p_player is null or p_player = '{}'::jsonb then player_data
        else jsonb_strip_nulls(player_data || p_player) end
  where id = p_id;
  if not found then
    raise exception 'Scheda non trovata o non modificabile' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.patch_pokemon(p_n int, p_patch jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.pokemon_state (n, data, updated_by)
  values (p_n, jsonb_strip_nulls(p_patch), auth.uid())
  on conflict (n) do update
    set data = jsonb_strip_nulls(public.pokemon_state.data || p_patch),
        updated_at = now(),
        updated_by = auth.uid();
end;
$$;

create or replace function public.patch_map(p_patch jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.map_state
  set data = jsonb_strip_nulls(data || p_patch),
      updated_at = now(),
      updated_by = auth.uid()
  where id = 1;
  if not found then
    raise exception 'Mappa non modificabile' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.patch_trainer(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.patch_pokemon(int, jsonb) from public, anon;
revoke execute on function public.patch_map(jsonb) from public, anon;
grant execute on function public.patch_trainer(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.patch_pokemon(int, jsonb) to authenticated;
grant execute on function public.patch_map(jsonb) to authenticated;

-- ---------- Realtime --------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare t text;
begin
  foreach t in array array['trainers', 'pokemon_state', 'map_state'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- Storage (immagini) ---------------------------------------
-- Bucket pubblico in lettura (gli URL contengono un hash e non sono indovinabili),
-- scrittura solo master.
insert into storage.buckets (id, name, public)
values ('lentinia', 'lentinia', true)
on conflict (id) do nothing;

drop policy if exists "lentinia read" on storage.objects;
create policy "lentinia read" on storage.objects
  for select using (bucket_id = 'lentinia');

drop policy if exists "lentinia master upload" on storage.objects;
create policy "lentinia master upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'lentinia' and public.is_master());
