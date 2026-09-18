import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './test/fakeSupabase.js';

/**
 * Phase 13 integration test: SMTP settings save + real test-send (mocked
 * nodemailer transport) -> SMS campaign create -> start -> a real
 * dispatcher tick sends via mocked Twilio HTTP -> messages marked sent ->
 * a simulated Twilio delivery webhook updates status to delivered,
 * replayed identically causes no duplicate -> a DNC lead is skipped ->
 * email campaign create -> start -> dispatcher tick sends via mocked
 * nodemailer transport -> messages marked sent -> a suppressed email is
 * skipped -> cross-org isolation for campaigns/messages/SMTP settings.
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

describe('Phase 13: messaging (SMTP, SMS campaigns, email campaigns)', () => {
  let app: Awaited<ReturnType<typeof import('./index.js').buildApp>>;
  let processSmsCampaign: typeof import('./services/smsDispatcher.js').processSmsCampaign;
  let processEmailCampaign: typeof import('./services/emailDispatcher.js').processEmailCampaign;
  let sentEmails: Array<{ to: string; subject: string }>;

  beforeAll(async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      // Twilio credential check (numbers.manage connect flow).
      if (/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/[^/]+\.json$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      // Twilio single-number import (GET IncomingPhoneNumbers/{Sid}.json).
      if (/\/IncomingPhoneNumbers\/[^/]+\.json$/.test(url) && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sid: 'PNimported', phone_number: '+14845559999', friendly_name: 'SMS number', capabilities: { voice: true, sms: true } }),
        } as unknown as Response;
      }
      // Twilio SMS send.
      if (/\/Messages\.json$/.test(url) && method === 'POST') {
        twilioSmsCounter += 1;
        return { ok: true, status: 200, json: async () => ({ sid: `SM${twilioSmsCounter}`, status: 'queued' }) } as unknown as Response;
      }
      throw new Error(`Unexpected fetch call in test: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    sentEmails = [];
    const { __setSmtpTransportForTests } = await import('./services/smtpProvider.js');
    __setSmtpTransportForTests({
      sendMail: vi.fn(async (opts: any) => {
        sentEmails.push({ to: opts.to, subject: opts.subject });
        return { messageId: `mail-${sentEmails.length}` };
      }),
    } as any);

    const { buildApp } = await import('./index.js');
    app = buildApp();
    await app.ready();
    processSmsCampaign = (await import('./services/smsDispatcher.js')).processSmsCampaign;
    processEmailCampaign = (await import('./services/emailDispatcher.js')).processEmailCampaign;
  });

  async function signup(orgName: string, email: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { organization_name: orgName, full_name: 'Test Person', email, password: 'supersecret123' } });
    expect(res.statusCode).toBe(201);
    return res.json().data.session.access_token as string;
  }

  async function connectTwilio(token: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-number-providers/twilio/credentials',
      headers: { authorization: `Bearer ${token}` },
      payload: { account_sid: 'AC123', auth_token: 'TOKEN' },
    });
    expect(res.statusCode).toBe(200);
    const testRes = await app.inject({ method: 'POST', url: '/api/v1/phone-number-providers/twilio/test-connection', headers: { authorization: `Bearer ${token}` } });
    expect(testRes.statusCode).toBe(200);
  }

  async function importSmsCapableNumber(token: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/phone-numbers/import',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        provider_key: 'twilio',
        provider_number_id: `PN${Math.random()}`,
        phone_number: `+1484555${Math.floor(1000 + Math.random() * 8999)}`,
        friendly_name: 'SMS number',
        capabilities: { voice_inbound: true, voice_outbound: true, sms: true },
      },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  }

  async function addLead(token: string, listId: string, phone: string, opts: { email?: string; first_name?: string } = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: { authorization: `Bearer ${token}` },
      payload: { phone, lead_list_id: listId, first_name: opts.first_name ?? 'Jane', email: opts.email },
    });
    expect(res.statusCode).toBe(201);
    return res.json().data;
  }

  async function createList(token: string) {
    const res = await app.inject({ method: 'POST', url: '/api/v1/lead-lists', headers: { authorization: `Bearer ${token}` }, payload: { name: `List ${Date.now()}-${Math.random()}` } });
    expect(res.statusCode).toBe(201);
    return res.json().data;
  }

  it('SMTP settings: save (password never returned) then a real test-send updates status', async () => {
    const token = await signup('SMTP Org', `smtp-${Date.now()}@test.com`);

    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/v1/settings/smtp',
      headers: { authorization: `Bearer ${token}` },
      payload: { host: 'smtp.example.com', port: 587, username: 'user@example.com', password: 'hunter2', encryption: 'tls', from_name: 'Acme', from_email: 'noreply@acme.com' },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(JSON.stringify(saveRes.json())).not.toContain('hunter2');
    expect(saveRes.json().data.status).toBe('not_configured');

    const testRes = await app.inject({ method: 'POST', url: '/api/v1/settings/smtp/test', headers: { authorization: `Bearer ${token}` }, payload: { recipient: 'someone@example.com' } });
    expect(testRes.statusCode).toBe(200);
    expect(testRes.json().data.success).toBe(true);
    expect(testRes.json().data.settings.status).toBe('connected');
    expect(sentEmails.some((m) => m.to === 'someone@example.com')).toBe(true);
  });

  it('SMS campaign: create -> start -> dispatcher tick sends up to throttle -> delivery webhook -> replay dedup -> DNC lead skipped', async () => {
    const token = await signup('SMS Org', `sms-${Date.now()}@test.com`);
    await connectTwilio(token);
    const phoneNumber = await importSmsCapableNumber(token);
    const list = await createList(token);

    const goodLead = await addLead(token, list.id, '+12015550001', { first_name: 'Alice' });
    await addLead(token, list.id, '+12015550002', { first_name: 'Bob' });

    // Add a DNC entry for a third number BEFORE the lead is created, so
    // the lead is flagged is_dnc at creation time and never gets a
    // materialized message.
    const dncRes = await app.inject({ method: 'POST', url: '/api/v1/dnc', headers: { authorization: `Bearer ${token}` }, payload: { phone: '+12015550003' } });
    expect(dncRes.statusCode).toBe(201);
    await addLead(token, list.id, '+12015550003', { first_name: 'Dnc Lead' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sms-campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'SMS Blast', message_template: 'Hi {{first_name}}, special offer!', phone_number_id: phoneNumber.id, lead_list_id: list.id, throttle_per_minute: 100 },
    });
    expect(createRes.statusCode).toBe(200);
    const campaign = createRes.json().data;

    const startRes = await app.inject({ method: 'POST', url: `/api/v1/sms-campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${token}` } });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().data.status).toBe('sending');

    // Only the 2 non-DNC leads should have been materialized.
    const materialized = fake.tables.sms_messages.filter((m: any) => m.sms_campaign_id === campaign.id);
    expect(materialized).toHaveLength(2);

    const tickResult = await processSmsCampaign(fake.tables.sms_campaigns.find((c: any) => c.id === campaign.id)!);
    expect(tickResult.sent).toBe(2);

    const sentMessage = fake.tables.sms_messages.find((m: any) => m.sms_campaign_id === campaign.id && m.lead_id === goodLead.id)!;
    expect(sentMessage.status).toBe('sent');
    expect(sentMessage.rendered_body).toBe('Hi Alice, special offer!');
    expect(sentMessage.provider_message_id).toBeTruthy();

    // Real Twilio delivery-receipt webhook.
    const webhookPayload = { MessageSid: sentMessage.provider_message_id, MessageStatus: 'delivered' };
    const webhookRes = await app.inject({ method: 'POST', url: '/api/v1/webhooks/twilio-sms', payload: webhookPayload });
    expect(webhookRes.statusCode).toBe(200);
    const afterWebhook = fake.tables.sms_messages.find((m: any) => m.id === sentMessage.id)!;
    expect(afterWebhook.status).toBe('delivered');
    expect(afterWebhook.delivered_at).toBeTruthy();

    // Replaying the identical webhook delivery is deduplicated (no error,
    // no double-processing) via the webhook_events UNIQUE constraint.
    const replayRes = await app.inject({ method: 'POST', url: '/api/v1/webhooks/twilio-sms', payload: webhookPayload });
    expect(replayRes.statusCode).toBe(200);
    expect(replayRes.json().deduplicated).toBe(true);

    const smsEventCount = fake.tables.webhook_events.filter((e: any) => e.provider === 'twilio-sms').length;
    expect(smsEventCount).toBe(1);
  });

  it('dedup: two concurrent materialization calls for the same campaign never double-send a lead (UNIQUE constraint holds)', async () => {
    const token = await signup('Dedup Org', `dedup-${Date.now()}@test.com`);
    await connectTwilio(token);
    const phoneNumber = await importSmsCapableNumber(token);
    const list = await createList(token);
    await addLead(token, list.id, '+12015551111', { first_name: 'Race' });

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/sms-campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Race Campaign', message_template: 'Hi {{first_name}}', phone_number_id: phoneNumber.id, lead_list_id: list.id },
    });
    const campaign = createRes.json().data;

    const { materializeSmsMessages } = await import('./services/smsDispatcher.js');
    const campaignRow = fake.tables.sms_campaigns.find((c: any) => c.id === campaign.id)!;
    // Simulate a race: two concurrent materialization attempts for the
    // same campaign/lead.
    await Promise.all([materializeSmsMessages(fake.supabase as any, campaignRow), materializeSmsMessages(fake.supabase as any, campaignRow)]);

    const rows = fake.tables.sms_messages.filter((m: any) => m.sms_campaign_id === campaign.id);
    expect(rows).toHaveLength(1);
  });

  it('email campaign: create -> start -> dispatcher sends via mocked SMTP transport -> suppressed address skipped -> cross-org isolation', async () => {
    const orgAToken = await signup('Email Org A', `email-a-${Date.now()}@test.com`);
    const orgBToken = await signup('Email Org B', `email-b-${Date.now()}@test.com`);

    await app.inject({
      method: 'POST',
      url: '/api/v1/settings/smtp',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: { host: 'smtp.example.com', port: 587, username: 'user@example.com', password: 'hunter2', encryption: 'tls', from_name: 'Acme', from_email: 'noreply@acme.com' },
    });

    const list = await createList(orgAToken);
    const goodLead = await addLead(orgAToken, list.id, '+12015552001', { email: 'good@example.com', first_name: 'Good' });
    await addLead(orgAToken, list.id, '+12015552002', { email: 'suppressed@example.com', first_name: 'Bad' });

    const suppressRes = await app.inject({ method: 'POST', url: '/api/v1/email-suppressions', headers: { authorization: `Bearer ${orgAToken}` }, payload: { email: 'suppressed@example.com' } }).catch(() => null);
    // The suppression management endpoint is optional API surface for
    // this test - insert directly if no such route exists yet.
    if (!suppressRes || suppressRes.statusCode >= 400) {
      fake.tables.email_suppressions.push({ id: 'sup-1', organization_id: null, email: 'suppressed@example.com', reason: 'manual', source: 'manual', created_at: new Date().toISOString() });
    }

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/email-campaigns',
      headers: { authorization: `Bearer ${orgAToken}` },
      payload: { name: 'Newsletter', subject: 'Hi {{first_name}}', html_body: '<p>Hello {{first_name}}</p>', recipient_lead_list_id: list.id },
    });
    expect(createRes.statusCode).toBe(200);
    const campaign = createRes.json().data;

    const startRes = await app.inject({ method: 'POST', url: `/api/v1/email-campaigns/${campaign.id}/start`, headers: { authorization: `Bearer ${orgAToken}` } });
    expect(startRes.statusCode).toBe(200);

    const materialized = fake.tables.email_messages.filter((m: any) => m.email_campaign_id === campaign.id);
    expect(materialized).toHaveLength(1);
    expect(materialized[0].recipient_email).toBe('good@example.com');

    const tickResult = await processEmailCampaign(fake.tables.email_campaigns.find((c: any) => c.id === campaign.id)!);
    expect(tickResult.sent).toBe(1);

    const sentMessage = fake.tables.email_messages.find((m: any) => m.lead_id === goodLead.id)!;
    expect(sentMessage.status).toBe('sent');
    expect(sentMessage.rendered_subject).toBe('Hi Good');

    // Cross-org isolation: org B cannot see org A's campaign/messages/SMTP settings.
    const crossGetRes = await app.inject({ method: 'GET', url: `/api/v1/email-campaigns/${campaign.id}`, headers: { authorization: `Bearer ${orgBToken}` } });
    expect(crossGetRes.statusCode).toBe(404);

    const crossSmtpRes = await app.inject({ method: 'GET', url: '/api/v1/settings/smtp', headers: { authorization: `Bearer ${orgBToken}` } });
    expect(crossSmtpRes.statusCode).toBe(200);
    expect(crossSmtpRes.json().data).toBeNull();

    const orgAList = await app.inject({ method: 'GET', url: '/api/v1/email-campaigns', headers: { authorization: `Bearer ${orgAToken}` } });
    const orgBList = await app.inject({ method: 'GET', url: '/api/v1/email-campaigns', headers: { authorization: `Bearer ${orgBToken}` } });
    expect(orgAList.json().data.some((c: any) => c.id === campaign.id)).toBe(true);
    expect(orgBList.json().data.some((c: any) => c.id === campaign.id)).toBe(false);
  });
});
