-- pgTAP tests for the multi-user access rules. Run with: supabase test db
-- (needs the Supabase CLI + Docker; not run automatically.)
begin;
select plan(15);

-- Fixtures: owner A, other user B, admin, and a not-yet-approved user P.
insert into auth.users (id, email, instance_id, aud, role) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.dev', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.dev', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000ad', 'admin@test.dev', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
  ('00000000-0000-0000-0000-0000000000f0', 'pending@test.dev', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

-- The trigger created an account row for each, with approved = false.
select is((select approved from public.accounts where "user" = '00000000-0000-0000-0000-00000000000a'), false,
  'new accounts start unapproved');

update public.accounts set approved = true where "user" in
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b');
update public.accounts set admin = true where "user" = '00000000-0000-0000-0000-0000000000ad';

insert into public.projects (id, created_by, name) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-00000000000a', 'A project');
insert into public.scans (project_id) values ('11111111-1111-1111-1111-111111111111');

-- Owner sees and writes their project
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}';
select is((select count(*)::int from public.projects), 1, 'owner sees own project');
select is((select count(*)::int from public.scans), 1, 'owner sees own scans');

-- Another approved user sees nothing and cannot write
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}';
select is((select count(*)::int from public.projects), 0, 'other user cannot see the project');
select is((select count(*)::int from public.scans), 0, 'other user cannot see its scans');
select is_empty($$ update public.projects set name = 'hacked' where id = '11111111-1111-1111-1111-111111111111' returning 1 $$,
  'other user cannot update the project');

-- Nobody can edit their own account flags
select throws_ok($$ update public.accounts set admin = true where "user" = auth.uid() $$, '42501',
  null, 'users cannot make themselves admin');

-- Sharing: put the project id in B's shared_project_ids (done as the dashboard / service role would)
reset role;
update public.accounts set shared_project_ids = array['11111111-1111-1111-1111-111111111111'::uuid]
  where "user" = '00000000-0000-0000-0000-00000000000b';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}';
select is((select count(*)::int from public.projects), 1, 'shared user sees the shared project');
select lives_ok($$ update public.projects set name = 'edited by B' where id = '11111111-1111-1111-1111-111111111111' $$,
  'shared user can edit');
select is_empty($$ delete from public.projects where id = '11111111-1111-1111-1111-111111111111' returning 1 $$,
  'shared user cannot delete');
select throws_ok($$ update public.projects set created_by = auth.uid() where id = '11111111-1111-1111-1111-111111111111' $$,
  'Only an admin can change the owner of a project', 'shared user cannot take ownership');

-- Admin sees everything
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000ad","role":"authenticated"}';
select is((select count(*)::int from public.projects), 1, 'admin sees all projects');

-- Unapproved account sees and creates nothing, even with the project shared with it
reset role;
update public.accounts set shared_project_ids = array['11111111-1111-1111-1111-111111111111'::uuid]
  where "user" = '00000000-0000-0000-0000-0000000000f0';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000f0","role":"authenticated"}';
select is((select count(*)::int from public.projects), 0, 'unapproved account sees nothing');
select throws_ok($$ insert into public.projects (created_by, name) values (auth.uid(), 'x') $$, '42501',
  null, 'unapproved account cannot create projects');

select * from finish();
rollback;
