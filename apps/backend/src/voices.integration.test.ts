import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 4 integration test: connect ElevenLabs credentials (HTTP mocked
 * at the fetch boundary only - real route/adapter code runs unmocked) ->
 * test-connection succeeds -> sync voices -> list shows the synced
 * voices, scoped to the connecting organization only (cross-org
 * isolation) -> voice cloning rejects a request missing explicit
 * consent -> a consented clone request creates a pending voice and
 * (mocked provider response) transitions it to ready.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.CREDENTIAL_ENCRYPTION_KEY = 'a'.repeat(64); // 32 bytes hex, test-only

const fake = createFakeSupabase();

vi.mock('./lib/supabase.js', () => ({
  getSupabaseAdmin: () => fake.supabase,
  getSupabaseAnon: () => fake.supabase,
}));

function buildMultipart(fields: Record<string, string>, file: { fieldname: string; filename: string; content: string; contentType: string }) {
  const boundary = '----phase4TestBoundary';
  let body = '';
  for (const [key, value] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  }
  body +=
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${file.fieldname}"; filename="${file.filename}"\r\n` +
    `Content-Type: ${file.contentType}\r\n\r\n` +
    `${file.content}\r\n` +
    `--${boundary}--\r\n`;
  return { body: Buffer.from(body), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function waitForCloneStatus(
  app: Awaited<ReturnType<typeof import('./index.js').buildApp>>,
  token: string,
  voiceId: string,
  targetStatuses: string[],
  maxAttempts = 50,
): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await app.inject({ method: 'GET', url: '/api/v1/voices', headers: { authorization: `Bearer ${token}` } });
    const voice = res.json().data.find((v: any) => v.id === voiceId);
    if (voice && targetStatuses.includes(voice.clone_status)) return voice;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Voice ${voiceId} did not reach clone_status ${targetStatuses.join('/')} in time`);
}

describe('Phase 4: voice provider connect -> sync -> list, cloning consent + async status', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const storage = await import('./lib/storage/index.js');
    const os = await import('node:os');
    const path = await import('node:path');
    const { LocalDiskStorageAdapter } = storage;
    storage.__setStorageAdapterForTests(new LocalDiskStorageAdapter(path.join(os.tmpdir(), `phase4-voice-test-${Date.now()}`)));

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === 'https://api.elevenlabs.io/v1/voices' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            voices: [
              { voice_id: 'el-voice-1', name: 'Rachel', labels: { gender: 'female', accent: 'american' } },
              { voice_id: 'el-voice-2', name: 'Josh', labels: { gender: 'male', accent: 'american' } },
            ],
          }),
        } as unknown as Response;
      }

      if (url === 'https://api.elevenlabs.io/v1/voices/add' && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ voice_id: 'el-cloned-1' }) } as unknown as Response;
      }

      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  it('connects ElevenLabs, syncs voices, lists them scoped to the connecting org only', async () => {
    const signupA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Voice Org A',
        full_name: 'Vera Voiceworth',
        email: 'vera@voicetest.com',
        password: 'supersecret123',
      },
    });
    expect(signupA.statusCode).toBe(201);
    const tokenA = signupA.json().data.session.access_token;

    const signupB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Voice Org B',
        full_name: 'Bea Belcanto',
        email: 'bea@voicetest.com',
        password: 'supersecret123',
      },
    });
    expect(signupB.statusCode).toBe(201);
    const tokenB = signupB.json().data.session.access_token;

    // Org A: catalog shows not_connected before any credentials exist.
    const catalogBefore = await app.inject({
      method: 'GET',
      url: '/api/v1/voice-providers',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(catalogBefore.statusCode).toBe(200);
    const elevenLabsEntry = catalogBefore.json().data.find((p: any) => p.key === 'elevenlabs');
    expect(elevenLabsEntry.status).toBe('not_connected');
    expect(elevenLabsEntry.masked_credential).toBeNull();

    // Org A: save credentials - the raw key must never come back.
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/voice-providers/elevenlabs/credentials',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { kind: 'api_key', api_key: 'sk-elevenlabs-real-secret-key-12345' },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(JSON.stringify(saveRes.json())).not.toContain('sk-elevenlabs-real-secret-key-12345');
    expect(saveRes.json().data.masked_credential).toMatch(/^sk-e/);

    // Org A: test-connection makes a real (mocked-at-fetch) call and
    // reports a genuine pass.
    const testRes = await app.inject({
      method: 'POST',
      url: '/api/v1/voice-providers/elevenlabs/test-connection',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().data.success).toBe(true);
    expect(testRes.json().data.status).toBe('connected');

    // Org A: sync pulls the 2 mocked ElevenLabs voices into `voices`.
    const syncRes = await app.inject({
      method: 'POST',
      url: '/api/v1/voices/sync/elevenlabs',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(syncRes.statusCode).toBe(200);
    expect(syncRes.json().data.created).toBe(2);

    const listA = await app.inject({ method: 'GET', url: '/api/v1/voices', headers: { authorization: `Bearer ${tokenA}` } });
    expect(listA.json().data).toHaveLength(2);
    expect(listA.json().data.every((v: any) => v.requires_external_hosting === false)).toBe(true);

    // Org B never connected ElevenLabs and never synced - its voice list
    // must stay empty even though org A's sync just ran.
    const listB = await app.inject({ method: 'GET', url: '/api/v1/voices', headers: { authorization: `Bearer ${tokenB}` } });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().data).toHaveLength(0);
    const catalogB = await app.inject({ method: 'GET', url: '/api/v1/voice-providers', headers: { authorization: `Bearer ${tokenB}` } });
    expect(catalogB.json().data.find((p: any) => p.key === 'elevenlabs').status).toBe('not_connected');
  });

  it('rejects voice cloning with no explicit consent, and completes cloning once consent + a real provider response arrive', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        organization_name: 'Voice Org C',
        full_name: 'Cara Cadence',
        email: 'cara@voicetest.com',
        password: 'supersecret123',
      },
    });
    const token = signup.json().data.session.access_token;

    await app.inject({
      method: 'POST',
      url: '/api/v1/voice-providers/elevenlabs/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'api_key', api_key: 'sk-elevenlabs-real-secret-key-99999' },
    });

    // Missing consent_confirmed entirely -> hard rejection, no voice row created.
    const noConsent = buildMultipart(
      { provider_key: 'elevenlabs', name: 'My Cloned Voice' },
      { fieldname: 'sample', filename: 'sample.wav', content: 'fake-audio-bytes', contentType: 'audio/wav' },
    );
    const rejectRes = await app.inject({
      method: 'POST',
      url: '/api/v1/voices/clone',
      headers: { authorization: `Bearer ${token}`, 'content-type': noConsent.contentType },
      payload: noConsent.body,
    });
    expect(rejectRes.statusCode).toBe(422);
    expect(fake.tables.voices.some((v) => v.name === 'My Cloned Voice')).toBe(false);

    // With consent_confirmed=true -> accepted, pending, then transitions
    // to ready once the (mocked) provider call succeeds.
    const withConsent = buildMultipart(
      { provider_key: 'elevenlabs', name: 'My Cloned Voice', consent_confirmed: 'true' },
      { fieldname: 'sample', filename: 'sample.wav', content: 'fake-audio-bytes', contentType: 'audio/wav' },
    );
    const cloneRes = await app.inject({
      method: 'POST',
      url: '/api/v1/voices/clone',
      headers: { authorization: `Bearer ${token}`, 'content-type': withConsent.contentType },
      payload: withConsent.body,
    });
    expect(cloneRes.statusCode).toBe(202);
    const voice = cloneRes.json().data;
    expect(voice.consent_confirmed).toBe(true);
    expect(voice.clone_status).toBe('pending');

    const readyVoice = await waitForCloneStatus(app, token, voice.id, ['ready', 'failed']);
    expect(readyVoice.clone_status).toBe('ready');
    expect(readyVoice.provider_voice_id).toBe('el-cloned-1');
  });
});
