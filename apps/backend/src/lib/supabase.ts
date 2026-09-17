import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../env.js';

let adminClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

/**
 * Service-role Supabase client. Bypasses Row Level Security entirely, so
 * every query issued through this client MUST be scoped to the caller's
 * organization_id explicitly in application code (see lib/tenant.ts).
 * Never expose this key to the frontend.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (adminClient) return adminClient;
  const env = getEnv();
  adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}

/**
 * Anon-key Supabase client, used only for auth flows that must run with
 * the anon role semantics (sign in, sign up, password reset emails).
 */
export function getSupabaseAnon(): SupabaseClient {
  if (anonClient) return anonClient;
  const env = getEnv();
  anonClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return anonClient;
}
