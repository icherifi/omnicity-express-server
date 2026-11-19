-- Multi-user access control.
--
-- Model:
--   * public.accounts holds one row per auth user (created automatically by a trigger).
--       - approved            : an admin must flip this to true before the account can use anything
--                               (no payment flow yet: each customer company signs a contract).
--       - admin               : sees and edits every project.
--       - shared_project_ids  : paste a project id here to give that user read+write access to it.
--   * Everything project-scoped hangs off projects.id and is guarded by can_access_project().
--
-- IMPORTANT: this migration DROPS every existing RLS policy on the tables below (their
-- definitions were never versioned in this repo) and replaces them. It also drops the
-- storage.objects policies that mention the project-images / documents buckets.
-- The service_role key bypasses RLS, so server-side jobs (staging, local models) keep working.

-- ---------------------------------------------------------------------------
-- 1. accounts: new columns, one row per auth user
-- ---------------------------------------------------------------------------

-- Added with default true so every EXISTING account stays approved; new sign-ups default to false.
alter table public.accounts
  add column if not exists approved boolean not null default true,
  add column if not exists shared_project_ids uuid[] not null default '{}';
alter table public.accounts alter column approved set default false;

comment on column public.accounts.approved is
  'false = account created and email verified but not yet activated by an admin: no access to any feature. Admins are always treated as approved.';
comment on column public.accounts.shared_project_ids is
  'Project ids this user may read and write in addition to the ones they created. Edit from the Supabase dashboard.';

-- Backfill: an account row for every existing auth user that lacks one (already-existing users stay approved).
insert into public.accounts ("user", admin, approved)
select u.id, false, true
from auth.users u
where not exists (select 1 from public.accounts a where a."user" = u.id);

create unique index if not exists accounts_user_key on public.accounts ("user");

-- New auth user -> new accounts row (approved = false).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.accounts ("user", admin, approved)
  values (new.id, false, false)
  on conflict ("user") do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. Access helpers (single source of truth for "who can see what")
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.admin from public.accounts a where a."user" = auth.uid() limit 1),
    false
  );
$$;

create or replace function public.is_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select a.admin or a.approved from public.accounts a where a."user" = auth.uid() limit 1),
    false
  );
$$;

create or replace function public.can_access_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select pid is not null
    and public.is_approved()
    and (
      exists (
        select 1 from public.accounts a
        where a."user" = auth.uid()
          and (a.admin or pid = any (a.shared_project_ids))
      )
      or exists (
        select 1 from public.projects p
        where p.id = pid and p.created_by = auth.uid()
      )
    );
$$;

create or replace function public.try_uuid(v text)
returns uuid
language plpgsql
immutable
as $$
begin
  return v::uuid;
exception when others then
  return null;
end;
$$;

-- Storage path -> access decision. Conventions in use:
--   project-images : <projectId>/<imageId>
--   documents      : plans-<projectId>/scan-<uuid>.usdz   (written by the iOS app)
--                    staging/<scanId>/preview.png          (written by the server)
--                    local-models/...                      (server only, never client-readable)
create or replace function public.can_access_storage_path(bucket text, object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  parts text[] := string_to_array(object_name, '/');
  first text := parts[1];
begin
  if bucket = 'project-images' then
    return public.can_access_project(public.try_uuid(first));
  elsif bucket = 'documents' then
    if first like 'plans-%' then
      return public.can_access_project(public.try_uuid(substr(first, 7)));
    elsif first = 'staging' then
      return exists (
        select 1 from public.scans s
        where s.id::text = parts[2] and public.can_access_project(s.project_id)
      );
    end if;
    return false;
  end if;
  return false;
end;
$$;

revoke all on function public.is_admin() from public, anon;
revoke all on function public.is_approved() from public, anon;
revoke all on function public.can_access_project(uuid) from public, anon;
revoke all on function public.can_access_storage_path(text, text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_approved() to authenticated;
grant execute on function public.can_access_project(uuid) to authenticated;
grant execute on function public.can_access_storage_path(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Row level security
-- ---------------------------------------------------------------------------

-- Drop every pre-existing policy on the tables we manage (permissive policies are OR-ed,
-- so a forgotten "using (true)" would silently defeat everything below).
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in ('projects', 'scans', 'dpe', 'energy', 'energy_choices', 'accounts', 'exports')
  loop
    execute format('drop policy %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

alter table public.projects       enable row level security;
alter table public.scans          enable row level security;
alter table public.dpe            enable row level security;
alter table public.energy         enable row level security;
alter table public.energy_choices enable row level security;
alter table public.accounts       enable row level security;
alter table public.exports        enable row level security;  -- unused: no policy = no client access

-- accounts: a user can only read their own row; nobody can write from a client
-- (otherwise they could set admin/approved or extend shared_project_ids themselves).
create policy accounts_select_own on public.accounts
  for select to authenticated using ("user" = auth.uid());
revoke insert, update, delete on public.accounts from anon, authenticated;

-- projects
create policy projects_select on public.projects
  for select to authenticated using (public.can_access_project(id));
create policy projects_insert on public.projects
  for insert to authenticated with check (created_by = auth.uid() and public.is_approved());
create policy projects_update on public.projects
  for update to authenticated
  using (public.can_access_project(id)) with check (public.can_access_project(id));
-- Shared users get read+write but cannot delete: only the owner or an admin can.
create policy projects_delete on public.projects
  for delete to authenticated
  using (public.is_approved() and (created_by = auth.uid() or public.is_admin()));

-- Only an admin may change a project's owner (calls from the dashboard / service role have no auth.uid()).
create or replace function public.projects_protect_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is distinct from old.created_by
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'Only an admin can change the owner of a project';
  end if;
  return new;
end;
$$;

drop trigger if exists projects_protect_owner on public.projects;
create trigger projects_protect_owner
  before update on public.projects
  for each row execute function public.projects_protect_owner();

-- scans (project_id)
create policy scans_all on public.scans
  for all to authenticated
  using (public.can_access_project(project_id))
  with check (public.can_access_project(project_id));

-- per-project result tables (id_project)
create policy dpe_all on public.dpe
  for all to authenticated
  using (public.can_access_project(id_project))
  with check (public.can_access_project(id_project));
create policy energy_all on public.energy
  for all to authenticated
  using (public.can_access_project(id_project))
  with check (public.can_access_project(id_project));
create policy energy_choices_all on public.energy_choices
  for all to authenticated
  using (public.can_access_project(id_project))
  with check (public.can_access_project(id_project));

-- Helpful indexes (policies and the API filter on these columns).
create index if not exists projects_created_by_idx on public.projects (created_by);
create index if not exists scans_project_id_idx on public.scans (project_id);
create index if not exists dpe_id_project_idx on public.dpe (id_project);
create index if not exists energy_id_project_idx on public.energy (id_project);
create index if not exists energy_choices_id_project_idx on public.energy_choices (id_project);

-- ---------------------------------------------------------------------------
-- 4. Storage (project-images, documents)
-- ---------------------------------------------------------------------------

do $$
declare
  pol record;
begin
  for pol in
    select policyname
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual, '') ilike any (array['%project-images%', '%documents%'])
        or coalesce(with_check, '') ilike any (array['%project-images%', '%documents%']))
  loop
    execute format('drop policy %I on storage.objects', pol.policyname);
  end loop;
end $$;

create policy project_files_select on storage.objects
  for select to authenticated
  using (bucket_id in ('project-images', 'documents') and public.can_access_storage_path(bucket_id, name));
create policy project_files_insert on storage.objects
  for insert to authenticated
  with check (bucket_id in ('project-images', 'documents') and public.can_access_storage_path(bucket_id, name));
create policy project_files_update on storage.objects
  for update to authenticated
  using (bucket_id in ('project-images', 'documents') and public.can_access_storage_path(bucket_id, name))
  with check (bucket_id in ('project-images', 'documents') and public.can_access_storage_path(bucket_id, name));
create policy project_files_delete on storage.objects
  for delete to authenticated
  using (bucket_id in ('project-images', 'documents') and public.can_access_storage_path(bucket_id, name));

-- Surface any remaining storage.objects policy so it can be reviewed by hand
-- (a generic permissive policy would defeat the ones above).
do $$
declare
  pol record;
begin
  for pol in
    select policyname, cmd, roles, qual
    from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname not like 'project_files_%'
  loop
    raise notice 'Review remaining storage policy: % (% for %) using %', pol.policyname, pol.cmd, pol.roles, pol.qual;
  end loop;
end $$;
