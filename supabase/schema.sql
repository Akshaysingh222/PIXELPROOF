-- PixelProof shared team workspace: database schema for Supabase.
-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again: it only creates things that don't exist yet and replaces the functions.
--
-- What it sets up:
--   workspaces  one per team: name, join code, the brand kit (JSON) and its change history
--   members     who belongs to which workspace, and their role: creator, reviewer or admin
--   items       submitted content with all its versions, comments and check results (JSON)
-- Row Level Security makes sure people only ever see their own team's data,
-- and a trigger makes sure only reviewers/admins can approve or send content back.

create table if not exists public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  join_code   text not null unique,
  kit         jsonb not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.members (
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'creator' check (role in ('creator', 'reviewer', 'admin')),
  display_name  text not null default 'Team member' check (char_length(display_name) between 1 and 60),
  joined_at     timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.items (
  id            text primary key check (char_length(id) between 4 and 40),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  status        text not null default 'in_review' check (status in ('in_review', 'approved', 'changes_requested')),
  data          jsonb not null,
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid,
  updated_at    timestamptz not null default now()
);
create index if not exists items_workspace_idx on public.items (workspace_id, updated_at desc);

-- The caller's role in a workspace (null if they aren't a member).
-- "security definer" lets the policies below use it without looping back into themselves.
create or replace function public.my_role(ws uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where workspace_id = ws and user_id = auth.uid()
$$;

alter table public.workspaces enable row level security;
alter table public.members    enable row level security;
alter table public.items      enable row level security;

drop policy if exists "members can read their workspace" on public.workspaces;
create policy "members can read their workspace" on public.workspaces
  for select to authenticated using (public.my_role(id) is not null);

drop policy if exists "reviewers can edit the brand kit" on public.workspaces;
create policy "reviewers can edit the brand kit" on public.workspaces
  for update to authenticated using (public.my_role(id) in ('reviewer', 'admin'))
  with check (public.my_role(id) in ('reviewer', 'admin'));

drop policy if exists "members can see their team" on public.members;
create policy "members can see their team" on public.members
  for select to authenticated using (public.my_role(workspace_id) is not null);

drop policy if exists "members can read items" on public.items;
create policy "members can read items" on public.items
  for select to authenticated using (public.my_role(workspace_id) is not null);

drop policy if exists "members can add items" on public.items;
create policy "members can add items" on public.items
  for insert to authenticated with check (public.my_role(workspace_id) is not null);

drop policy if exists "members can update items" on public.items;
create policy "members can update items" on public.items
  for update to authenticated using (public.my_role(workspace_id) is not null)
  with check (public.my_role(workspace_id) is not null);

drop policy if exists "admins can delete items" on public.items;
create policy "admins can delete items" on public.items
  for delete to authenticated using (public.my_role(workspace_id) = 'admin');

-- Keeps the status column in step with the JSON, and enforces who may approve.
-- A creator can submit or resubmit (in_review); only a reviewer or admin can approve or request changes.
create or replace function public.items_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  new.status := coalesce(new.data->>'status', new.status);
  new.updated_at := now();
  new.updated_by := auth.uid();
  r := public.my_role(new.workspace_id);
  if r is null then
    raise exception 'You are not a member of this workspace';
  end if;
  if tg_op = 'UPDATE' and new.workspace_id <> old.workspace_id then
    raise exception 'Items cannot move between workspaces';
  end if;
  if new.status in ('approved', 'changes_requested')
     and (tg_op = 'INSERT' or new.status is distinct from old.status)
     and r not in ('reviewer', 'admin') then
    raise exception 'Only a reviewer or admin can approve content or request changes';
  end if;
  return new;
end $$;

drop trigger if exists items_guard on public.items;
create trigger items_guard before insert or update on public.items
  for each row execute function public.items_guard();

create or replace function public.workspaces_touch() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
drop trigger if exists workspaces_touch on public.workspaces;
create trigger workspaces_touch before update on public.workspaces
  for each row execute function public.workspaces_touch();

-- Create a workspace. The person who creates it becomes its admin.
create or replace function public.create_workspace(p_name text, p_kit jsonb, p_display_name text)
returns public.workspaces
language plpgsql security definer set search_path = public as $$
declare ws public.workspaces; code text;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  if p_kit is null or jsonb_typeof(p_kit->'rules') <> 'array' then raise exception 'The brand kit is missing its rules'; end if;
  loop
    code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.workspaces where join_code = code);
  end loop;
  insert into public.workspaces (name, join_code, kit, created_by)
    values (trim(p_name), code, p_kit, auth.uid()) returning * into ws;
  insert into public.members (workspace_id, user_id, role, display_name)
    values (ws.id, auth.uid(), 'admin', coalesce(nullif(trim(p_display_name), ''), 'Admin'));
  return ws;
end $$;

-- Join a workspace with its 6-letter code. New members join as creators; an admin can change roles.
create or replace function public.join_workspace(p_code text, p_display_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare ws_id uuid;
begin
  if auth.uid() is null then raise exception 'Please sign in first'; end if;
  select id into ws_id from public.workspaces where join_code = upper(trim(p_code));
  if ws_id is null then raise exception 'No workspace has that code'; end if;
  insert into public.members (workspace_id, user_id, role, display_name)
    values (ws_id, auth.uid(), 'creator', coalesce(nullif(trim(p_display_name), ''), 'Team member'))
    on conflict (workspace_id, user_id) do nothing;
  return ws_id;
end $$;

-- Admins change someone's role. The last admin can't remove their own admin role.
create or replace function public.set_member_role(p_workspace uuid, p_user uuid, p_role text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role(p_workspace) is distinct from 'admin' then raise exception 'Only an admin can change roles'; end if;
  if p_role not in ('creator', 'reviewer', 'admin') then raise exception 'Unknown role'; end if;
  if p_role <> 'admin' and (select count(*) from public.members where workspace_id = p_workspace and role = 'admin' and user_id <> p_user) = 0 then
    raise exception 'A workspace needs at least one admin';
  end if;
  update public.members set role = p_role where workspace_id = p_workspace and user_id = p_user;
end $$;

-- Lets someone change the name the rest of the team sees.
create or replace function public.set_display_name(p_workspace uuid, p_name text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if nullif(trim(p_name), '') is null then raise exception 'Name cannot be empty'; end if;
  update public.members set display_name = left(trim(p_name), 60) where workspace_id = p_workspace and user_id = auth.uid();
end $$;

revoke all on function public.create_workspace(text, jsonb, text) from public, anon;
revoke all on function public.join_workspace(text, text) from public, anon;
revoke all on function public.set_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.set_display_name(uuid, text) from public, anon;
grant execute on function public.my_role(uuid) to authenticated;
grant execute on function public.create_workspace(text, jsonb, text) to authenticated;
grant execute on function public.join_workspace(text, text) to authenticated;
grant execute on function public.set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.set_display_name(uuid, text) to authenticated;
grant select, update on public.workspaces to authenticated;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.items to authenticated;
revoke all on public.workspaces, public.members, public.items from anon;

-- Live updates: the app listens for changes so a reviewer sees new submissions without refreshing.
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.items; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.workspaces; exception when duplicate_object then null; end;
  end if;
end $$;
