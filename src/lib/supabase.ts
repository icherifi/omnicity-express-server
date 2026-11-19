import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables (SUPABASE_URL, SUPABASE_ANON_KEY)');
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

/** Anon client with no user attached: only used to validate a JWT (auth.getUser). */
export const authClient: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, clientOptions);

/**
 * Client acting AS the calling user: every query carries their JWT, so Postgres
 * row level security (can_access_project, approved accounts...) applies automatically.
 * Use this for everything that is triggered by a user request.
 */
export function createUserClient(accessToken: string): SupabaseClient {
  return createClient(supabaseUrl as string, supabaseAnonKey as string, {
    ...clientOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

let serviceClient: SupabaseClient | null = null;

/**
 * Service-role client: BYPASSES row level security. Only use it for trusted server-side
 * work (background staging, local model cache) and only after an explicit access check
 * done with the user's own client (see middleware/requireAccess.ts).
 */
export function getServiceClient(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  }
  if (!serviceClient) {
    serviceClient = createClient(supabaseUrl as string, serviceKey, clientOptions);
  }
  return serviceClient;
}
