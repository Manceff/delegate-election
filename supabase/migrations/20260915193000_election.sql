-- Class delegate election.
-- Tables are private (RLS on, no policies, no grants): the website only talks
-- to the three functions at the bottom, which enforce every rule server-side.

create extension if not exists unaccent with schema extensions;

create table public.election (
  id smallint primary key default 1 check (id = 1),
  title text not null,
  polls_close_at timestamptz not null
);

-- "Monday midnight" = the night of Monday 21 → Tuesday 22 September, Paris time.
insert into public.election (title, polls_close_at)
values ('Class Delegate Election 2026–2027', '2026-09-22 00:00:00+02');

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  name_key text not null unique,
  statement text not null,
  device_id uuid not null unique,
  created_at timestamptz not null default now()
);

-- The voter roll (who voted) and the ballot box (what was voted) are never linked.
create table public.voter_roll (
  name_key text primary key,
  full_name text not null,
  device_id uuid not null unique,
  signed_at timestamptz not null default now()
);

create table public.ballot_box (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates (id) on delete cascade
);

alter table public.election enable row level security;
alter table public.candidates enable row level security;
alter table public.voter_roll enable row level security;
alter table public.ballot_box enable row level security;
revoke all on table public.election, public.candidates, public.voter_roll, public.ballot_box
  from anon, authenticated;

-- "  Léa   Martin " and "lea martin" are the same person.
create function public.name_key(p text)
returns text
language sql
stable
set search_path = ''
as $$
  select lower(regexp_replace(btrim(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p, ''))), '\s+', ' ', 'g'))
$$;

create function public.clean_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')
$$;

create function public.election_state(p_device uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e public.election;
  is_closed boolean;
begin
  select * into e from public.election where id = 1;
  is_closed := now() >= e.polls_close_at;

  return jsonb_build_object(
    'title', e.title,
    'server_now', now(),
    'polls_close_at', e.polls_close_at,
    'closed', is_closed,
    'turnout', (select count(*) from public.voter_roll),
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'full_name', c.full_name,
               'statement', c.statement,
               'registered_at', c.created_at,
               -- tallies stay sealed until polls close
               'votes', case when is_closed
                          then (select count(*) from public.ballot_box b where b.candidate_id = c.id)
                        end
             ) order by c.created_at)
      from public.candidates c
    ), '[]'::jsonb),
    'me', case when p_device is null then null else jsonb_build_object(
      'has_voted', exists (select 1 from public.voter_roll v where v.device_id = p_device),
      'candidate_id', (select c.id from public.candidates c where c.device_id = p_device)
    ) end
  );
end
$$;

create function public.election_register(p_full_name text, p_statement text, p_device uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_name text := public.clean_name(p_full_name);
  v_key text := public.name_key(p_full_name);
  v_statement text := btrim(coalesce(p_statement, ''));
  v_id uuid;
begin
  if p_device is null then raise exception 'missing_device'; end if;
  if now() >= (select polls_close_at from public.election where id = 1) then
    raise exception 'polls_closed';
  end if;
  if char_length(v_name) not between 3 and 60 or position(' ' in v_name) = 0 then
    raise exception 'invalid_name';
  end if;
  if char_length(v_statement) not between 20 and 600 then
    raise exception 'invalid_statement';
  end if;
  if exists (select 1 from public.candidates where device_id = p_device) then
    raise exception 'device_already_candidate';
  end if;
  if exists (select 1 from public.candidates where name_key = v_key) then
    raise exception 'name_taken';
  end if;
  if (select count(*) from public.candidates) >= 40 then
    raise exception 'too_many_candidates';
  end if;

  insert into public.candidates (full_name, name_key, statement, device_id)
  values (v_name, v_key, v_statement, p_device)
  returning id into v_id;

  return jsonb_build_object('id', v_id);
exception
  when unique_violation then
    if exists (select 1 from public.candidates where device_id = p_device) then
      raise exception 'device_already_candidate';
    end if;
    raise exception 'name_taken';
end
$$;

create function public.election_vote(p_full_name text, p_candidate uuid, p_device uuid)
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
  insert into public.ballot_box (candidate_id) values (p_candidate);

  return jsonb_build_object('turnout', (select count(*) from public.voter_roll));
exception
  when unique_violation then
    if exists (select 1 from public.voter_roll where device_id = p_device) then
      raise exception 'device_already_voted';
    end if;
    raise exception 'name_already_voted';
end
$$;

revoke execute on function public.name_key(text) from public, anon, authenticated;
revoke execute on function public.clean_name(text) from public, anon, authenticated;
revoke execute on function public.election_state(uuid) from public;
revoke execute on function public.election_register(text, text, uuid) from public;
revoke execute on function public.election_vote(text, uuid, uuid) from public;
grant execute on function public.election_state(uuid) to anon, authenticated;
grant execute on function public.election_register(text, text, uuid) to anon, authenticated;
grant execute on function public.election_vote(text, uuid, uuid) to anon, authenticated;
