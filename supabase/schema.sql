-- GardenBud database setup
-- Paste this whole file into Supabase: SQL Editor > New query > Run.
-- Safe to run once on a fresh project.

-- ============ Tables ============

-- One row: the club and its invite code
create table if not exists public.club (
  id int primary key default 1 check (id = 1),
  invite_code text not null,
  admin_member uuid
);

-- People (one per person, can span several devices)
create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  first_name text not null check (char_length(first_name) between 1 and 40),
  units text not null default 'metric' check (units in ('metric', 'imperial')),
  created_at timestamptz not null default now()
);

-- Devices (anonymous logins) belonging to a person
create table if not exists public.member_devices (
  user_id uuid primary key references auth.users (id) on delete cascade,
  member_id uuid not null references public.members (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Short-lived codes for "use GardenBud on another device"
create table if not exists public.device_links (
  code text primary key,
  member_id uuid not null references public.members (id) on delete cascade,
  expires_at timestamptz not null
);

-- Garden designs
create table if not exists public.designs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.members (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  data jsonb not null default '{}'::jsonb,   -- garden shape, cut-outs, labels, items
  notes text not null default '',
  allow_edit boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.members (id) on delete set null,
  deleted_at timestamptz                      -- set = in Trash
);

-- Version history (last 10 per design, at most one every 10 minutes)
create table if not exists public.design_versions (
  id bigint generated always as identity primary key,
  design_id uuid not null references public.designs (id) on delete cascade,
  data jsonb not null,
  notes text not null default '',
  saved_by uuid references public.members (id) on delete set null,
  saved_at timestamptz not null default now()
);

-- General comments on a design
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references public.designs (id) on delete cascade,
  author_id uuid not null references public.members (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- When each person last read a design's comments (for the "!" badge)
create table if not exists public.comment_reads (
  member_id uuid not null references public.members (id) on delete cascade,
  design_id uuid not null references public.designs (id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (member_id, design_id)
);

create index if not exists designs_owner_idx on public.designs (owner_id);
create index if not exists versions_design_idx on public.design_versions (design_id, saved_at desc);
create index if not exists comments_design_idx on public.comments (design_id, created_at);

-- ============ Helper functions ============

-- The person behind the current device, or null
create or replace function public.current_member()
returns uuid language sql stable security definer set search_path = public as $$
  select member_id from public.member_devices where user_id = auth.uid()
$$;

-- Join the club with the invite code and a first name
create or replace function public.join_club(p_code text, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  m := public.current_member();
  if m is not null then return m; end if;
  if not exists (select 1 from public.club where invite_code = p_code) then
    raise exception 'invalid invite';
  end if;
  insert into public.members (first_name) values (trim(p_name)) returning id into m;
  insert into public.member_devices (user_id, member_id) values (auth.uid(), m);
  -- the first person to join becomes the admin
  update public.club set admin_member = m where admin_member is null;
  return m;
end $$;

-- Make a 15-minute code to sign another device in as you
create or replace function public.create_device_link()
returns text language plpgsql security definer set search_path = public as $$
declare m uuid := public.current_member(); c text;
begin
  if m is null then raise exception 'not a member'; end if;
  delete from public.device_links where expires_at < now();
  c := substr(md5(random()::text || clock_timestamp()::text), 1, 12);
  insert into public.device_links (code, member_id, expires_at) values (c, m, now() + interval '15 minutes');
  return c;
end $$;

-- Use that code on the new device
create or replace function public.claim_device_link(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare m uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select member_id into m from public.device_links where code = p_code and expires_at > now();
  if m is null then raise exception 'link expired'; end if;
  insert into public.member_devices (user_id, member_id) values (auth.uid(), m)
    on conflict (user_id) do update set member_id = excluded.member_id;
  delete from public.device_links where code = p_code;
  return m;
end $$;

-- Any member can see the invite code (to share with partners)
create or replace function public.get_invite_code()
returns text language sql stable security definer set search_path = public as $$
  select invite_code from public.club where public.current_member() is not null
$$;

-- Admin only: replace the invite code (old links stop working for new people)
create or replace function public.regenerate_invite()
returns text language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not exists (select 1 from public.club where admin_member = public.current_member()) then
    raise exception 'admin only';
  end if;
  c := substr(md5(random()::text || clock_timestamp()::text), 1, 10);
  update public.club set invite_code = c;
  return c;
end $$;

-- Is the current person the club admin?
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.club where admin_member = public.current_member())
$$;

-- Guard design updates: non-owners may only change layout and notes
create or replace function public.designs_before_update()
returns trigger language plpgsql security definer set search_path = public as $$
declare me uuid := public.current_member();
begin
  if new.owner_id <> old.owner_id then raise exception 'owner cannot change'; end if;
  if me is distinct from old.owner_id then
    if new.name <> old.name or new.allow_edit <> old.allow_edit
       or new.deleted_at is distinct from old.deleted_at then
      raise exception 'only the creator can change that';
    end if;
  end if;
  -- snapshot the previous version (at most one every 10 minutes, keep 10)
  if new.data is distinct from old.data or new.notes is distinct from old.notes then
    if not exists (
      select 1 from public.design_versions
      where design_id = old.id and saved_at > now() - interval '10 minutes'
    ) then
      insert into public.design_versions (design_id, data, notes, saved_by)
        values (old.id, old.data, old.notes, old.updated_by);
      delete from public.design_versions
        where design_id = old.id
          and id not in (select id from public.design_versions where design_id = old.id
                         order by saved_at desc limit 10);
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := me;
  return new;
end $$;

drop trigger if exists designs_guard on public.designs;
create trigger designs_guard before update on public.designs
  for each row execute function public.designs_before_update();

-- Remove designs that have been in the Trash more than 30 days
create or replace function public.purge_trash()
returns void language sql security definer set search_path = public as $$
  delete from public.designs where deleted_at < now() - interval '30 days'
$$;

-- ============ Row-level security ============

alter table public.club enable row level security;
alter table public.members enable row level security;
alter table public.member_devices enable row level security;
alter table public.device_links enable row level security;
alter table public.designs enable row level security;
alter table public.design_versions enable row level security;
alter table public.comments enable row level security;
alter table public.comment_reads enable row level security;
-- club and device_links have no policies: only the functions above can touch them.

-- members: everyone in the club sees names; you edit only yourself
create policy members_select on public.members for select to authenticated
  using (public.current_member() is not null);
create policy members_update on public.members for update to authenticated
  using (id = public.current_member()) with check (id = public.current_member());

-- member_devices: see your own
create policy devices_select on public.member_devices for select to authenticated
  using (user_id = auth.uid());

-- designs
create policy designs_select on public.designs for select to authenticated
  using (public.current_member() is not null
         and (deleted_at is null or owner_id = public.current_member()));
create policy designs_insert on public.designs for insert to authenticated
  with check (owner_id = public.current_member());
create policy designs_update on public.designs for update to authenticated
  using (owner_id = public.current_member()
         or (allow_edit and deleted_at is null and public.current_member() is not null))
  with check (public.current_member() is not null);
create policy designs_delete on public.designs for delete to authenticated
  using (owner_id = public.current_member());

-- versions: readable by members (written only by the trigger)
create policy versions_select on public.design_versions for select to authenticated
  using (public.current_member() is not null);

-- comments
create policy comments_select on public.comments for select to authenticated
  using (public.current_member() is not null);
create policy comments_insert on public.comments for insert to authenticated
  with check (author_id = public.current_member());
create policy comments_update on public.comments for update to authenticated
  using (author_id = public.current_member()) with check (author_id = public.current_member());
create policy comments_delete on public.comments for delete to authenticated
  using (author_id = public.current_member()
         or exists (select 1 from public.designs d
                    where d.id = design_id and d.owner_id = public.current_member()));

-- comment reads: your own only
create policy reads_all on public.comment_reads for all to authenticated
  using (member_id = public.current_member()) with check (member_id = public.current_member());

-- Function permissions
revoke all on function public.join_club(text, text) from public, anon;
revoke all on function public.create_device_link() from public, anon;
revoke all on function public.claim_device_link(text) from public, anon;
revoke all on function public.get_invite_code() from public, anon;
revoke all on function public.regenerate_invite() from public, anon;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.purge_trash() from public, anon;
grant execute on function public.join_club(text, text) to authenticated;
grant execute on function public.create_device_link() to authenticated;
grant execute on function public.claim_device_link(text) to authenticated;
grant execute on function public.get_invite_code() to authenticated;
grant execute on function public.regenerate_invite() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.purge_trash() to authenticated;

-- ============ Starting invite code ============
insert into public.club (id, invite_code)
values (1, substr(md5(random()::text || clock_timestamp()::text), 1, 10))
on conflict (id) do nothing;

-- Shows your invite code when the script finishes
select invite_code as "Your GardenBud invite code" from public.club;

-- ============ Table permissions (also in grants.sql) ============
grant usage on schema public to authenticated;
grant select, update on public.members to authenticated;
grant select on public.member_devices to authenticated;
grant select, insert, update, delete on public.designs to authenticated;
grant select on public.design_versions to authenticated;
grant select, insert, update, delete on public.comments to authenticated;
grant select, insert, update, delete on public.comment_reads to authenticated;
