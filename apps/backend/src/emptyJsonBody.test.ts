import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Regression test for a production incident: a POST/PATCH sent with
 * `Content-Type: application/json` but no body (as the frontend api
 * client used to send for every body-less action - campaign archive,
 * agent publish, provider test-connection, etc.) made Fastify throw
 * FST_ERR_CTP_EMPTY_JSON_BODY, which fell through the error handler's
 * catch-all and came back as a 500 instead of a 400.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64);

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

describe('a POST with an empty body but a JSON content-type', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const { buildApp } = await import('./index.js');
    app = buildApp();
  });

  it('returns a 4xx BAD_REQUEST, not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    const body = res.json();
    expect(body.success).toBe(false);
  });
});
