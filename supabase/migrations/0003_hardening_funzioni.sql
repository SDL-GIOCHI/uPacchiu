-- 0003 — percorso di ricerca fisso e permessi di esecuzione minimi per le funzioni
alter function public.trainers_guard()        set search_path = public;
alter function public.pokemon_state_guard()  set search_path = public;
alter function public.pk_key_ok(text)        set search_path = public;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_master()       from public, anon;
revoke execute on function public.pk_in_team(int)   from public, anon;
grant  execute on function public.is_master()       to authenticated;
grant  execute on function public.pk_in_team(int)   to authenticated;
