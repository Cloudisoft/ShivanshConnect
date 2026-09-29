import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

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

describe('List filters (CDR, Leads, Voices, DIDs)', () => {
  let app: any;

  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      throw new Error(`Unexpected fetch call in test: ${String(input)}`);
    }));
    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return { token: res.json().data.session.access_token as string, orgId: res.json().data.organization.id as string };
  }

  const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('filters leads by state, called, callback and date added - and "select all matching" bulk actions cover exactly those leads', async () => {
    const { token, orgId } = await signup('Lead Filter Org', `lead-filter-${Date.now()}@test.com`);
    const base = { organization_id: orgId, status: 'new', attempts: 0, is_dnc: false, custom_fields: {}, lead_list_id: null, next_callback_at: null, last_called_at: null };
    const ids = { paNever: randomUUID(), paCalled: randomUUID(), njCallback: randomUUID(), paOld: randomUUID() };
    fake.tables.leads.push(
      { ...base, id: ids.paNever, first_name: 'Ann', phone_normalized: '+14845550001', state: 'PA', created_at: '2026-09-10T12:00:00Z' },
      { ...base, id: ids.paCalled, first_name: 'Bob', phone_normalized: '+14845550002', state: 'pa', attempts: 1, last_called_at: '2026-09-11T12:00:00Z', created_at: '2026-09-10T13:00:00Z' },
      { ...base, id: ids.njCallback, first_name: 'Cy', phone_normalized: '+14845550003', state: 'NJ', next_callback_at: '2026-10-01T12:00:00Z', created_at: '2026-09-10T14:00:00Z' },
      { ...base, id: ids.paOld, first_name: 'Di', phone_normalized: '+14845550004', state: 'PA', created_at: '2026-08-01T12:00:00Z' },
    );
    const idsOf = (res: any) => res.json().data.map((l: any) => l.id).sort();

    expect(idsOf(await get(token, '/api/v1/leads?state=PA'))).toEqual([ids.paNever, ids.paCalled, ids.paOld].sort());
    expect(idsOf(await get(token, '/api/v1/leads?state=PA&called=never'))).toEqual([ids.paNever, ids.paOld].sort());
    expect(idsOf(await get(token, '/api/v1/leads?called=called'))).toEqual([ids.paCalled]);
    expect(idsOf(await get(token, '/api/v1/leads?has_callback=true'))).toEqual([ids.njCallback]);
    expect(idsOf(await get(token, '/api/v1/leads?created_from=2026-09-01T00:00:00.000Z&created_to=2026-09-30T23:59:59.999Z'))).toEqual(
      [ids.paNever, ids.paCalled, ids.njCallback].sort(),
    );

    const bulk = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/bulk-actions',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'delete', filter: { state: 'PA', called: 'never', created_from: '2026-09-01T00:00:00.000Z' } },
    });
    expect(bulk.statusCode).toBe(200);
    expect(idsOf(await get(token, '/api/v1/leads'))).toEqual([ids.paCalled, ids.njCallback, ids.paOld].sort());
  });

  it('filters CDR by direction and talk time', async () => {
    const { token, orgId } = await signup('Cdr Filter Org', `cdr-filter-${Date.now()}@test.com`);
    const base = { organization_id: orgId, engine: 'vapi', status: 'completed', customer_number: '+14845551000', created_at: new Date().toISOString() };
    const inbound = randomUUID();
    const shortOut = randomUUID();
    const longOut = randomUUID();
    fake.tables.calls.push(
      { ...base, id: inbound, direction: 'inbound', talk_duration_seconds: 90 },
      { ...base, id: shortOut, direction: 'outbound', talk_duration_seconds: 5 },
      { ...base, id: longOut, direction: 'outbound', talk_duration_seconds: 200 },
    );
    const idsOf = (res: any) => res.json().data.map((c: any) => c.call_id).sort();
    expect(idsOf(await get(token, '/api/v1/cdr?direction=inbound'))).toEqual([inbound]);
    expect(idsOf(await get(token, '/api/v1/cdr?direction=outbound&min_talk_seconds=60'))).toEqual([longOut]);
  });

  it('searches voices by name and DIDs by number/name and inbound set-up', async () => {
    const { token, orgId } = await signup('Voice Did Filter Org', `vd-filter-${Date.now()}@test.com`);
    const now = new Date().toISOString();
    const voiceBase = { organization_id: orgId, provider_key: 'elevenlabs', status: 'active', is_cloned: false, clone_status: 'n/a', gender: 'female', created_at: now, updated_at: now };
    fake.tables.voices.push(
      { ...voiceBase, id: randomUUID(), name: 'Wendy', provider_voice_id: 'n6oEJLRjgYIXGzZnux9J' },
      { ...voiceBase, id: randomUUID(), name: 'Max', provider_voice_id: '5gANMbqELoHeVRrKdeAu' },
    );
    expect((await get(token, '/api/v1/voices?search=wen')).json().data.map((v: any) => v.name)).toEqual(['Wendy']);

    const numBase = { organization_id: orgId, provider_key: 'twilio', status: 'active', capabilities: {}, created_at: now };
    fake.tables.phone_numbers.push(
      { ...numBase, id: randomUUID(), phone_number: '+14845551234', friendly_name: 'Main line', vapi_phone_number_id: 'vapi-1' },
      { ...numBase, id: randomUUID(), phone_number: '+16105559876', friendly_name: 'Backup', vapi_phone_number_id: null },
    );
    const numbersOf = (res: any) => res.json().data.map((n: any) => n.phone_number).sort();
    expect(numbersOf(await get(token, '/api/v1/phone-numbers?search=555-1234'))).toEqual(['+14845551234']);
    expect(numbersOf(await get(token, '/api/v1/phone-numbers?search=backup'))).toEqual(['+16105559876']);
    expect(numbersOf(await get(token, '/api/v1/phone-numbers?inbound=answering'))).toEqual(['+14845551234']);
    expect(numbersOf(await get(token, '/api/v1/phone-numbers?inbound=not_set_up'))).toEqual(['+16105559876']);
    expect(numbersOf(await get(token, '/api/v1/phone-numbers?unassigned=false'))).toHaveLength(2);
  });

  it('bulk-acts on ALL voices matching the filters (not just the ticked ones), and fetches one voice by id', async () => {
    const { token, orgId } = await signup('Voice Bulk Org', `voice-bulk-${Date.now()}@test.com`);
    const other = await signup('Voice Bulk Other', `voice-bulk-other-${Date.now()}@test.com`);
    const now = new Date().toISOString();
    const base = { provider_key: 'cartesia', status: 'active', is_cloned: false, clone_status: 'n/a', gender: 'male', created_at: now, updated_at: now };
    const mine = Array.from({ length: 3 }, (_, i) => ({ ...base, id: randomUUID(), organization_id: orgId, name: `Ray ${i}`, provider_voice_id: `ray-${i}` }));
    const keep = { ...base, id: randomUUID(), organization_id: orgId, name: 'Tina', provider_voice_id: 'tina', gender: 'female' };
    const foreign = { ...base, id: randomUUID(), organization_id: other.orgId, name: 'Ray Foreign', provider_voice_id: 'ray-f' };
    fake.tables.voices.push(...mine, keep, foreign);
    const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload });

    const marked = await post('/api/v1/voices/bulk-update', { filter: { search: 'ray' }, is_cloned: true });
    expect(marked.json().data.affected).toBe(3);
    const cloned = (await get(token, '/api/v1/voices?is_cloned=true')).json().data.map((v: any) => v.name).sort();
    expect(cloned).toEqual(['Ray 0', 'Ray 1', 'Ray 2']);
    expect(fake.tables.voices.find((v: any) => v.id === foreign.id)?.is_cloned).toBe(false);

    const one = await get(token, `/api/v1/voices/${keep.id}`);
    expect(one.json().data.name).toBe('Tina');
    expect((await get(other.token, `/api/v1/voices/${keep.id}`)).statusCode).toBe(404);

    const deleted = await post('/api/v1/voices/bulk-delete', { filter: { gender: 'male' } });
    expect(deleted.json().data.affected).toBe(3);
    expect((await get(token, '/api/v1/voices')).json().data.map((v: any) => v.name)).toEqual(['Tina']);
    expect(fake.tables.voices.some((v: any) => v.id === foreign.id)).toBe(true);
  });

  it('bulk-deletes every DID matching the filters, and only those', async () => {
    const { token, orgId } = await signup('Did Bulk Org', `did-bulk-${Date.now()}@test.com`);
    const now = new Date().toISOString();
    const base = { organization_id: orgId, provider_key: 'twilio', status: 'active', capabilities: {}, created_at: now, vapi_phone_number_id: null, assigned_agent_id: null };
    const a = { ...base, id: randomUUID(), phone_number: '+14845550101', friendly_name: 'PA 1' };
    const b = { ...base, id: randomUUID(), phone_number: '+14845550102', friendly_name: 'PA 2' };
    const c = { ...base, id: randomUUID(), phone_number: '+12125550103', friendly_name: 'NY', provider_key: 'telnyx' };
    fake.tables.phone_numbers.push(a, b, c);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/bulk-actions',
      headers: { authorization: `Bearer ${token}` },
      payload: { filter: { provider_key: 'twilio' }, action: 'delete' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.affected).toBe(2);
    expect((await get(token, '/api/v1/phone-numbers')).json().data.map((n: any) => n.phone_number)).toEqual(['+12125550103']);
  });
});
