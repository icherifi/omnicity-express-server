# DEV

npm install
npm run dev

### Update types from supabase

npx supabase gen types typescript --project-id "$PROJECT_REF" --schema public > database.types.ts

# TODO

    - Add middleware to create supabase client
    - Use Table type from type/database.types.ts
    - Use interfaces
