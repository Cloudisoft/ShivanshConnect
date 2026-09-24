import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { getEnv } from '../env.js';

let adminClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

// This app never uses Supabase Realtime (no `.channel()` calls anywhere),
// but supabase-js's createClient() unconditionally constructs a
// RealtimeClient, which eagerly resolves a WebSocket constructor at
// construction time and throws if Node's native `WebSocket` global isn't
// detected - taking the whole client (and every caller of
// getSupabaseAdmin/Anon, including the campaign/SMS/email dispatch loops)
// down with it. Pointing it at our own `ws` dependency sidesteps that
// detection entirely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REALTIME_OPTIONS: any = { transport: WebSocket };

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
    realtime: REALTIME_OPTIONS,
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
    realtime: REALTIME_OPTIONS,
  });
  return anonClient;
}
