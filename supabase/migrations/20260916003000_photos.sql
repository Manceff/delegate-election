-- Candidate photos: one square image per candidate, in a public bucket.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('candidate-photos', 'candidate-photos', true, 400000, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "candidate photos are public" on storage.objects;
drop policy if exists "anyone can add a candidate photo" on storage.objects;

create policy "candidate photos are public" on storage.objects
  for select to anon, authenticated using (bucket_id = 'candidate-photos');

-- Uploads only: nobody can overwrite or delete someone else's photo.
create policy "anyone can add a candidate photo" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'candidate-photos');

alter table public.candidates add column photo_path text;
alter table public.candidates add constraint candidates_photo_path_check
  check (photo_path is null or photo_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-z]{6,32}\.(jpg|jpeg|png|webp)$');

create or replace function public.election_state(p_device uuid default null)
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
               'photo_path', c.photo_path,
               'registered_at', c.created_at,
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

drop function public.election_register(text, text, uuid);

create function public.election_register(p_full_name text, p_statement text, p_device uuid, p_photo text default null)
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
  if p_photo is not null and p_photo !~ ('^' || p_device::text || '/[0-9a-z]{6,32}\.(jpg|jpeg|png|webp)$') then
    raise exception 'invalid_photo';
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

  insert into public.candidates (full_name, name_key, statement, device_id, photo_path)
  values (v_name, v_key, v_statement, p_device, p_photo)
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

-- A candidate can add, replace or remove their own photo, from their own device.
create function public.election_set_photo(p_device uuid, p_photo text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_device is null then raise exception 'missing_device'; end if;
  if now() >= (select polls_close_at from public.election where id = 1) then
    raise exception 'polls_closed';
  end if;
  if p_photo is not null and p_photo !~ ('^' || p_device::text || '/[0-9a-z]{6,32}\.(jpg|jpeg|png|webp)$') then
    raise exception 'invalid_photo';
  end if;

  update public.candidates set photo_path = p_photo where device_id = p_device;
  if not found then raise exception 'not_found'; end if;

  return jsonb_build_object('photo_path', p_photo);
end
$$;

create or replace function public.admin_overview(p_key text)
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
               'photo_path', c.photo_path,
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

create function public.admin_clear_photo(p_key text, p_candidate uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin(p_key) then raise exception 'not_admin'; end if;
  update public.candidates set photo_path = null where id = p_candidate;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('cleared', true);
end
$$;

revoke execute on function public.election_register(text, text, uuid, text) from public;
revoke execute on function public.election_set_photo(uuid, text) from public;
revoke execute on function public.admin_clear_photo(text, uuid) from public;
grant execute on function public.election_register(text, text, uuid, text) to anon, authenticated;
grant execute on function public.election_set_photo(uuid, text) to anon, authenticated;
grant execute on function public.admin_clear_photo(text, uuid) to anon, authenticated;
