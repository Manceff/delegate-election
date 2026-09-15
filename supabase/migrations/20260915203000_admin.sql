-- Organiser page: live counts, voter roll, removal of duplicates.
-- Access needs the organiser key. Only its SHA-256 hash is stored, and it is set outside this file.

create extension if not exists pgcrypto with schema extensions;

create table public.admin_keys (
  id smallint primary key default 1 check (id = 1),
  key_hash text not null
);
alter table public.admin_keys enable row level security;
revoke all on table public.admin_keys from anon, authenticated;

-- Each ballot points to its voter-roll entry, so removing a duplicate or fraudulent entry
-- also removes the vote it cast. Neither page ever shows who voted for whom.
alter table public.ballot_box
  add column voter_key text references public.voter_roll (name_key) on delete cascade;

-- A single ballot cast before this change can be matched without ambiguity.
update public.ballot_box
set voter_key = (select name_key from public.voter_roll)
where voter_key is null
  and (select count(*) from public.voter_roll) = 1
  and (select count(*) from public.ballot_box) = 1;

create or replace function public.election_vote(p_full_name text, p_candidate uuid, p_device uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := public.clean_name(p_full_name);
  v_key text := public.name_key(p_full_name);
begin
  if p_device is null then raise exception 'missing_device'; end if;
  if now() >= (select polls_close_at from public.election where id = 1) then
    raise exception 'polls_closed';
  end if;
  if char_length(v_name) not between 3 and 60 or position(' ' in v_name) = 0 then
    raise exception 'invalid_name';
  end if;
  if not exists (select 1 from public.candidates where id = p_candidate) then
    raise exception 'unknown_candidate';
  end if;
  if exists (select 1 from public.voter_roll where device_id = p_device) then
    raise exception 'device_already_voted';
  end if;
  if exists (select 1 from public.voter_roll where name_key = v_key) then
    raise exception 'name_already_voted';
  end if;

  insert into public.voter_roll (name_key, full_name, device_id) values (v_key, v_name, p_device);
  insert into public.ballot_box (candidate_id, voter_key) values (p_candidate, v_key);

  return jsonb_build_object('turnout', (select count(*) from public.voter_roll));
exception
  when unique_violation then
    if exists (select 1 from public.voter_roll where device_id = p_device) then
      raise exception 'device_already_voted';
    end if;
    raise exception 'name_already_voted';
end
$$;

create function public.is_admin(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_keys
    where key_hash = encode(extensions.digest(coalesce(p_key, ''), 'sha256'), 'hex')
  )
$$;

create function public.admin_overview(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_key) then raise exception 'not_admin'; end if;

  return jsonb_build_object(
    'server_now', now(),
    'polls_close_at', (select polls_close_at from public.election where id = 1),
    'ballots', (select count(*) from public.ballot_box),
    'unlinked_ballots', (select count(*) from public.ballot_box where voter_key is null),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'full_name', c.full_name,
               'name_key', c.name_key,
               'statement', c.statement,
               'registered_at', c.created_at,
               'votes', (select count(*) from public.ballot_box b where b.candidate_id = c.id)
             ) order by c.created_at)
      from public.candidates c
    ), '[]'::jsonb),
    'voters', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name_key', v.name_key,
               'full_name', v.full_name,
               'voted_at', v.signed_at,
               'ballot_linked', exists (select 1 from public.ballot_box b where b.voter_key = v.name_key)
             ) order by v.signed_at)
      from public.voter_roll v
    ), '[]'::jsonb)
  );
end
$$;

create function public.admin_delete_candidate(p_key text, p_candidate uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_votes int;
  v_freed int;
begin
  if not public.is_admin(p_key) then raise exception 'not_admin'; end if;
  if not exists (select 1 from public.candidates where id = p_candidate) then
    raise exception 'not_found';
  end if;

  select count(*) into v_votes from public.ballot_box where candidate_id = p_candidate;

  -- Classmates who voted for this entry get their vote back.
  delete from public.voter_roll v
  using public.ballot_box b
  where b.candidate_id = p_candidate and b.voter_key = v.name_key;
  get diagnostics v_freed = row_count;

  delete from public.candidates where id = p_candidate;

  return jsonb_build_object('votes_removed', v_votes, 'voters_freed', v_freed);
end
$$;

create function public.admin_delete_voter(p_key text, p_name_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ballots int;
begin
  if not public.is_admin(p_key) then raise exception 'not_admin'; end if;
  if not exists (select 1 from public.voter_roll where name_key = p_name_key) then
    raise exception 'not_found';
  end if;

  select count(*) into v_ballots from public.ballot_box where voter_key = p_name_key;
  delete from public.voter_roll where name_key = p_name_key; -- its ballot cascades

  return jsonb_build_object('ballots_removed', v_ballots);
end
$$;

revoke execute on function public.is_admin(text) from public, anon, authenticated;
revoke execute on function public.admin_overview(text) from public;
revoke execute on function public.admin_delete_candidate(text, uuid) from public;
revoke execute on function public.admin_delete_voter(text, text) from public;
grant execute on function public.admin_overview(text) to anon, authenticated;
grant execute on function public.admin_delete_candidate(text, uuid) to anon, authenticated;
grant execute on function public.admin_delete_voter(text, text) to anon, authenticated;
