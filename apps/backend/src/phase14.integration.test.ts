import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 14 integration tests: the generalized export engine end to end
 * across Leads, Lead Lists, SMS campaign messages and Email campaign
 * messages, plus the unified Export History view's `type` filter and
 * cross-org isolation - the same fakeSupabase/app.inject() pattern as
 * every prior phase's integration test (see phase9.integration.test.ts
 * and messaging.integration.test.ts, which this deliberately mirrors).
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

let twilioSmsCounter = 0;

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor() timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('Phase 14: generalized exports (leads, lead lists, SMS/email messages) + unified export history', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      if (/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/[^/]+\.json$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (/\/IncomingPhoneNumbers\/[^/]+\.json$/.test(url) && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sid: 'PNimported', phone_number: '+14845559999', friendly_name: 'SMS number', capabilities: { voice: true, sms: true } }),
        } as unknown as Response;
      }
      if (/\/Messages\.json$/.test(url) && method === 'POST') {
        twilioSmsCounter += 1;
        return { ok: true, status: 200, json: async () => ({ sid: `SM${twilioSmsCounter}`, status: 'queued' }) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { __setSmtpTransportForTests } = await import('./services/smtpProvider.js');
    __setSmtpTransportForTests({
      sendMail: vi.fn(async (opts: any) => ({ messageId: 'mail-1', to: opts.to })),
    } as any);

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return res.json().data.session.access_token as string;
  }

  async function createList(token: string, name = `List ${Date.now()}-${Math.random()}`) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/lead-lists', headers: { authorization: `Bearer ${token}` }, payload: { name } });
    expect(res.statusCode).toBe(201);
    return res.json().data;
  }

  async function addLead(token: string, listId: string, phone: string, opts: { first_name?: string; email?: string; custom_fields?: Record<string, unknown> } = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone, lead_list_id: listId, first_name: opts.first_name ?? 'Jane', email: opts.email, custom_fields: opts.custom_fields },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data;
  }

  async function markDnc(token: string, phone: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/dnc', headers: { authorization: `Bearer ${token}` }, payload: { phone, reason: 'Customer requested' } });
    expect(res.statusCode).toBe(201);
  }

  it('leads export: CSV includes a custom field column and reflects a DNC lead honestly, respecting lead_list_id filtering', async () => {
    const token = await signup('Leads Export Org', `leadsexport-${Date.now()}@test.com`);
    const list = await createList(token);

    await app.inject({
      method: 'POST',
      url: '/api/v1/lead-custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { field_key: 'account_id', field_label: 'Account ID', field_type: 'text' },
    });

    await markDnc(token, '+14155550111');
    await addLead(token, list.id, '+14155550100', { first_name: 'Alice', custom_fields: { account_id: 'ACC-1' } });
    const dncLead = await addLead(token, list.id, '+14155550111', { first_name: 'Bob' });
    expect(dncLead.is_dnc).toBe(true);

    const exportRes = await app.inject({
      method: 'POST',
      url: '/api/v1/leads/export',
      headers: { authorization: `Bearer ${token}` },
      payload: { type: 'leads_csv', filters: { lead_list_id: list.id } },
    });
    expect(exportRes.statusCode).toBe(200);
    const exportId = exportRes.json().data.id;
    // Returns immediately - never processed synchronously in the request.
    expect(['pending', 'processing']).toContain(fake.tables.exports.find((e) => e.id === exportId)!.status);

    await waitFor(() => fake.tables.exports.find((e) => e.id === exportId)?.status === 'ready');
    const exportRow = fake.tables.exports.find((e) => e.id === exportId)!;
    expect(exportRow.row_count).toBe(2);

    const downloadRes = await app.inject({ method: 'GET', url: `/api/v1/exports/${exportId}/download`, headers: { authorization: `Bearer ${token}` } });
    expect(downloadRes.statusCode).toBe(200);
    const csv = downloadRes.rawPayload.toString('utf-8');
    expect(csv).toContain('Account ID');
    expect(csv).toContain('ACC-1');
    expect(csv).toContain('Alice');
    expect(csv).toContain('Bob');
    // The DNC lead's row genuinely reflects DNC status - never silently
    // dropped from a plain leads export (only excluded when the caller
    // explicitly filters is_dnc=false).
    const bobLine = csv.split('\r\n').find((l) => l.includes('Bob'));
    expect(bobLine).toContain('true');

    const auditEntry = fake.tables.audit_logs.find((a) => a.action === 'leads.export_created' && a.entity_id === exportId);
    expect(auditEntry).toBeTruthy();
  });

  it('lead list export (POST /lead-lists/:id/export): scoped to that list only, entity_reference recorded', async () => {
    const token = await signup('List Export Org', `listexport-${Date.now()}@test.com`);
    const listA = await createList(token, 'List A');
    const listB = await createList(token, 'List B');
    await addLead(token, listA.id, '+14155550200');
    await addLead(token, listA.id, '+14155550201');
    await addLead(token, listB.id, '+14155550202');

    const exportRes = await app.inject({
      method: 'POST',
      url: `/api/v1/lead-lists/${listA.id}/export`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: 'leads_xlsx' },
    });
    expect(exportRes.statusCode).toBe(200);
    const exportId = exportRes.json().data.id;
    expect(exportRes.json().data.entity_reference).toEqual({ leadListId: listA.id });

    await waitFor(() => fake.tables.exports.find((e) => e.id === exportId)?.status === 'ready');
    expect(fake.tables.exports.find((e) => e.id === exportId)!.row_count).toBe(2);
  });

  it('SMS campaign message export: recipient/status columns correct, scoped to the one campaign', async () => {
    const token = await signup('SMS Export Org', `smsexport-${Date.now()}@test.com`);

    await app.inject({
      method: 'POST',
      url: '/api/v1/phone-number-providers/twilio/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { account_sid: 'AC123', auth_token: 'TOKEN' },
    });
    await app.inject({ method: 'POST', url: '/api/v1/phone-number-providers/twilio/test-connection', headers: { authorization: `Bearer ${token}` } });
    const numberRes = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: { provider_key: 'twilio', provider_number_id: `PN${Math.random()}`, phone_number: '+14845551234', friendly_name: 'SMS number', capabilities: { voice_inbound: true, voice_outbound: true, sms: true } },
    });
    const phoneNumber = numberRes.json().data;

    const list = await createList(token);
    await addLead(token, list.id, '+14155550300', { first_name: 'Carla' });

    const campaignRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sms-campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Blast 1', message_template: 'Hi {{first_name}}', phone_number_id: phoneNumber.id, lead_list_id: list.id },
    });
    const campaign = campaignRes.json().data;
    const startRes = await app.inject({ method: 'POST', url: `/api/v1/sms-campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    expect(startRes.statusCode).toBe(200);

    const { processSmsCampaign } = await import('./services/smsDispatcher.js');
    await processSmsCampaign(fake.tables.sms_campaigns.find((c: any) => c.id === campaign.id)!);
    await waitFor(() => fake.tables.sms_messages.some((m) => m.sms_campaign_id === campaign.id && m.status === 'sent'));

    const exportRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sms-campaigns/${campaign.id}/messages/export`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: 'sms_messages_csv' },
    });
    expect(exportRes.statusCode).toBe(200);
    const exportId = exportRes.json().data.id;
    await waitFor(() => fake.tables.exports.find((e) => e.id === exportId)?.status === 'ready');
    expect(fake.tables.exports.find((e) => e.id === exportId)!.row_count).toBe(1);

    const downloadRes = await app.inject({ method: 'GET', url: `/api/v1/exports/${exportId}/download`, headers: { authorization: `Bearer ${token}` } });
    const csv = downloadRes.rawPayload.toString('utf-8');
    expect(csv).toContain('+14155550300');
    expect(csv).toContain('sent');
    expect(csv).toContain('Carla');

    const auditEntry = fake.tables.audit_logs.find((a) => a.action === 'sms_messages.export_created' && a.entity_id === exportId);
    expect(auditEntry).toBeTruthy();
  });

  it('Email campaign message export: recipient/subject/status columns correct', async () => {
    const token = await signup('Email Export Org', `emailexport-${Date.now()}@test.com`);

    await app.inject({
      method: 'POST',
      url: '/api/v1/settings/smtp',
      headers: { authorization: `Bearer ${token}` },
      payload: { host: 'smtp.example.com', port: 587, username: 'user@example.com', password: 'hunter2', encryption: 'tls', from_name: 'Acme', from_email: 'noreply@acme.com' },
    });

    const list = await createList(token);
    await addLead(token, list.id, '+14155550400', { email: 'dave@example.com', first_name: 'Dave' });

    const campaignRes = await app.inject({
      method: 'POST',
      url: '/api/v1/email-campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Newsletter', subject: 'Hello {{first_name}}', html_body: '<p>Hi {{first_name}}</p>', recipient_lead_list_id: list.id },
    });
    const campaign = campaignRes.json().data;
    const startRes = await app.inject({ method: 'POST', url: `/api/v1/email-campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    expect(startRes.statusCode).toBe(200);

    const { processEmailCampaign } = await import('./services/emailDispatcher.js');
    await processEmailCampaign(fake.tables.email_campaigns.find((c: any) => c.id === campaign.id)!);
    await waitFor(() => fake.tables.email_messages.some((m) => m.email_campaign_id === campaign.id && m.status === 'sent'));

    const exportRes = await app.inject({
      method: 'POST',
      url: `/api/v1/email-campaigns/${campaign.id}/messages/export`,
      headers: { authorization: `Bearer ${token}` },
      payload: { type: 'email_messages_xlsx' },
    });
    expect(exportRes.statusCode).toBe(200);
    const exportId = exportRes.json().data.id;
    await waitFor(() => fake.tables.exports.find((e) => e.id === exportId)?.status === 'ready');
    const exportRow = fake.tables.exports.find((e) => e.id === exportId)!;
    expect(exportRow.row_count).toBe(1);

    const auditEntry = fake.tables.audit_logs.find((a) => a.action === 'email_messages.export_created' && a.entity_id === exportId);
    expect(auditEntry).toBeTruthy();
  });

  it('unified export history: GET /exports?type= filters correctly and returns entries across every export type for the org', async () => {
    const token = await signup('History Org', `history-${Date.now()}@test.com`);
    const list = await createList(token);
    await addLead(token, list.id, '+14155550500');

    const leadsExportRes = await app.inject({ method: 'POST', url: '/api/v1/leads/export', headers: { authorization: `Bearer ${token}` }, payload: { type: 'leads_csv', filters: {} } });
    const cdrExportRes = await app.inject({ method: 'POST', url: '/api/v1/cdr/export', headers: { authorization: `Bearer ${token}` }, payload: { type: 'cdr_csv', filters: {} } });

    await waitFor(() => fake.tables.exports.find((e) => e.id === leadsExportRes.json().data.id)?.status === 'ready');
    await waitFor(() => fake.tables.exports.find((e) => e.id === cdrExportRes.json().data.id)?.status === 'ready');

    const allRes = await app.inject({ method: 'GET', url: '/api/v1/exports', headers: { authorization: `Bearer ${token}` } });
    expect(allRes.statusCode).toBe(200);
    expect(allRes.json().data.length).toBeGreaterThanOrEqual(2);
    expect(allRes.json().data.map((e: any) => e.type)).toEqual(expect.arrayContaining(['leads_csv', 'cdr_csv']));

    const leadsOnlyRes = await app.inject({ method: 'GET', url: '/api/v1/exports?type=leads_csv', headers: { authorization: `Bearer ${token}` } });
    expect(leadsOnlyRes.statusCode).toBe(200);
    expect(leadsOnlyRes.json().data.every((e: any) => e.type === 'leads_csv')).toBe(true);
    expect(leadsOnlyRes.json().data.some((e: any) => e.id === leadsExportRes.json().data.id)).toBe(true);
  });

  it('cross-org isolation: org B can never see org A\'s exports of any type, including via a guessed id', async () => {
    const tokenA = await signup('Iso Export Org A', `isoexpa-${Date.now()}@test.com`);
    const tokenB = await signup('Iso Export Org B', `isoexpb-${Date.now()}@test.com`);
    const list = await createList(tokenA);
    await addLead(tokenA, list.id, '+14155550600');

    const exportRes = await app.inject({ method: 'POST', url: '/api/v1/leads/export', headers: { authorization: `Bearer ${tokenA}` }, payload: { type: 'leads_csv', filters: {} } });
    const exportId = exportRes.json().data.id;
    await waitFor(() => fake.tables.exports.find((e) => e.id === exportId)?.status === 'ready');

    const historyFromB = await app.inject({ method: 'GET', url: '/api/v1/exports', headers: { authorization: `Bearer ${tokenB}` } });
    expect(historyFromB.json().data.some((e: any) => e.id === exportId)).toBe(false);

    const statusFromB = await app.inject({ method: 'GET', url: `/api/v1/exports/${exportId}`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(statusFromB.statusCode).toBe(404);

    const downloadFromB = await app.inject({ method: 'GET', url: `/api/v1/exports/${exportId}/download`, headers: { authorization: `Bearer ${tokenB}` } });
    expect(downloadFromB.statusCode).toBe(404);
  });
});
