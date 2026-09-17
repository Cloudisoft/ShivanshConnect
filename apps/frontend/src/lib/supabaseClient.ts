import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.',
  );
}

/**
 * Frontend Supabase client, using only the public anon key - never the
 * service role key, which lives only on the backend. This client owns
 * the browser session (sign up, sign in, password reset, token refresh);
 * the backend independently re-verifies every JWT it receives rather
 * than trusting the client.
 */
export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
