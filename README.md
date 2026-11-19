# DEV

npm install
npm run dev

### Update types from supabase

npx supabase gen types typescript --project-id "$PROJECT_REF" --schema public > database.types.ts

# TODO

    - Add middleware to create supabase client
    - Use Table type from type/database.types.ts
    - Use interfaces

## Multi-user access (administration)

All of this is done from the Supabase dashboard (Table editor > `accounts`); there is no admin UI.

- **Activate a new account**: users can sign up freely and verify their email, but have no access to any
  feature until you set `accounts.approved = true` on their row (found via `accounts.user` = their auth user id).
- **Make someone an admin**: set `accounts.admin = true`. Admins see and edit every project.
- **Share a project** with another user (read + write, no delete, no ownership change): add the project's
  `id` to that user's `accounts.shared_project_ids` array. Remove it from the array to stop sharing.
- A project is otherwise only visible to the user in `projects.created_by`.
- Access rules live in the database (`can_access_project()` + row level security, see
  `supabase/migrations/20261118000000_multi_user_access.sql`); the API queries as the calling user, so they
  apply everywhere. SQL tests: `supabase/tests/`. API tests: `npm test`.
