import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  // Comma-separated extra origins allowed to call this API (e.g. a custom
  // domain in front of the frontend, in addition to FRONTEND_URL itself -
  // which stays the single canonical URL used for building links such as
  // password-reset/invite emails). Each entry is validated as a real URL;
  // an invalid entry is dropped rather than crashing startup, since a
  // misconfigured extra origin should degrade CORS, not take the API down.
  ADDITIONAL_ALLOWED_ORIGINS: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

/**
 * FRONTEND_URL plus every valid entry in ADDITIONAL_ALLOWED_ORIGINS,
 * normalized (no trailing slash) and de-duplicated. Used for CORS so more
 * than one real frontend origin (e.g. a Railway-generated domain and a
 * custom domain both pointed at the same frontend) can call the API.
 */
export function getAllowedOrigins(env: Env): string[] {
  const normalize = (url: string) => url.trim().replace(/\/+$/, '');
  const origins = [env.FRONTEND_URL, ...(env.ADDITIONAL_ALLOWED_ORIGINS?.split(',') ?? [])]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      try {
        new URL(entry);
        return true;
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`Ignoring invalid origin in ADDITIONAL_ALLOWED_ORIGINS: ${entry}`);
        return false;
      }
    })
    .map(normalize);
  return Array.from(new Set(origins));
}

let cachedEnv: Env | null = null;

/**
 * Parses and validates process.env once, lazily. Lazy so unit tests that
 * only import individual modules (e.g. zod schemas) don't need a full
 * environment configured.
 */
export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration. Check .env against .env.example.');
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}
