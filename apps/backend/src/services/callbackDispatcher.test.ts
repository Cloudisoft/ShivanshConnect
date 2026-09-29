import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

vi.mock('../lib/supabase.js', () => ({ getSupabaseAdmin: () => fake.supabase }));
const originateCall = vi.fn();
vi.mock('./callOrigination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./callOrigination.js')>()),
  originateCall: (...args: unknown[]) => originateCall(...args),
  resolveDefaultEngine: async () => 'vapi',
}));

const fake = createFakeSupabase();
const { dispatchCallback, recoverStuckCallbacks, runCallbackDispatchTick } = await import('./callbackDispatcher.js');

const orgId = randomUUID();
const agentId = randomUUID();

function seed(opts: { campaignStatus?: string; campaignLeadStatus?: string; callingDays?: number[]; isDnc?: boolean } = {}) {
  for (const t of ['callbacks', 'campaigns', 'campaign_versions', 'campaign_leads', 'leads', 'calls', 'phone_numbers', 'campaign_phone_numbers', 'ai_agent_versions', 'dnc_entries'] as const) {
    (fake.tables as any)[t].length = 0;
  }
  const leadId = randomUUID();
  fake.tables.leads.push({ id: leadId, organization_id: orgId, phone_normalized: '+14845552222', is_dnc: Boolean(opts.isDnc) });
  const agentVersionId = randomUUID();
  fake.tables.ai_agent_versions.push({ id: agentVersionId, agent_id: agentId, organization_id: orgId, status: 'published' });
  const phoneId = randomUUID();
  fake.tables.phone_numbers.push({ id: phoneId, organization_id: orgId, phone_number: '+14845551111' });
  const campaignId = randomUUID();
  const versionId = randomUUID();
  fake.tables.campaigns.push({ id: campaignId, organization_id: orgId, status: opts.campaignStatus ?? 'paused', current_version_id: versionId, name: 'MVA' });
  fake.tables.campaign_versions.push({
    id: versionId,
    campaign_id: campaignId,
    ai_agent_id: agentId,
    ai_agent_version_id: agentVersionId,
    transfer_number_e164: '+19735550100',
    knowledge_base_ids: [],
    calling_rules: {
      timezone: 'America/New_York',
      calling_days: opts.callingDays ?? [1, 2, 3, 4, 5, 6, 7],
      calling_window_start: '00:00',
      calling_window_end: '23:59',
      voicemail_detection_enabled: true,
      voicemail_message: null,
      leave_voicemail: false,
      background_noise: null,
    },
  });
  fake.tables.campaign_phone_numbers.push({ campaign_id: campaignId, phone_number_id: phoneId, phone_numbers: fake.tables.phone_numbers[0] });
  fake.tables.campaign_leads.push({ id: randomUUID(), campaign_id: campaignId, lead_id: leadId, status: opts.campaignLeadStatus ?? 'completed', attempt_count: 1 });
  const callback = {
    id: randomUUID(),
    organization_id: orgId,
    campaign_id: campaignId,
    lead_id: leadId,
    phone_e164: '+14845552222',
    scheduled_at: new Date(Date.now() - 60_000).toISOString(),
    timezone: 'America/New_York',
    status: 'scheduled',
    assigned_to: 'ai',
    notes: 'Wants a call after work.',
  };
  fake.tables.callbacks.push(callback);
  return { callback, leadId, campaignId };
}

describe('callbackDispatcher', () => {
  beforeEach(() => {
    originateCall.mockReset();
    originateCall.mockResolvedValue({ call: { id: 'call-1' } });
  });

  it('places a due callback even when its campaign is paused, with the campaign set-up, and marks it completed', async () => {
    const { callback, leadId, campaignId } = seed({ campaignStatus: 'paused' });

    expect(await runCallbackDispatchTick()).toBe(1);

    expect(originateCall).toHaveBeenCalledTimes(1);
    const params = originateCall.mock.calls[0][0];
    expect(params.leadId).toBe(leadId);
    expect(params.campaignId).toBe(campaignId);
    expect(params.customerNumber).toBe('+14845552222');
    expect(params.transferDestinationOverride).toBe('+19735550100');
    const row = fake.tables.callbacks.find((c: any) => c.id === callback.id)!;
    expect(row.status).toBe('completed');
    expect(row.notes).toContain('Wants a call after work.');
    // The campaign lead was claimed, so the campaign dialer can't also call.
    expect(fake.tables.campaign_leads[0].status).toBe('dialing');
  });

  it('never calls a Do-Not-Call lead', async () => {
    const { callback } = seed({ isDnc: true });
    expect(await dispatchCallback(fake.supabase as any, callback)).toBe('cancelled');
    expect(originateCall).not.toHaveBeenCalled();
  });

  it('waits outside the campaign calling days instead of calling', async () => {
    const { callback } = seed({ callingDays: [] });
    expect(await dispatchCallback(fake.supabase as any, callback)).toBe('waiting');
    expect(originateCall).not.toHaveBeenCalled();
    expect(fake.tables.callbacks.find((c: any) => c.id === callback.id)!.status).toBe('scheduled');
  });

  it('does not double-dial when the campaign dialer is already calling the lead', async () => {
    const { callback } = seed({ campaignLeadStatus: 'dialing' });
    expect(await dispatchCallback(fake.supabase as any, callback)).toBe('placed');
    expect(originateCall).not.toHaveBeenCalled();
    expect(fake.tables.callbacks.find((c: any) => c.id === callback.id)!.status).toBe('completed');
  });

  it('marks the callback failed (and frees the lead for retry) when the call cannot be placed', async () => {
    const { callback } = seed();
    originateCall.mockRejectedValueOnce(new Error('Vapi rejected the call'));
    expect(await dispatchCallback(fake.supabase as any, callback)).toBe('failed');
    expect(fake.tables.callbacks.find((c: any) => c.id === callback.id)!.status).toBe('failed');
    expect(fake.tables.campaign_leads[0].status).toBe('retry_pending');
  });
});

describe('callbackDispatcher - overdue callbacks', () => {
  it('marks a callback more than 3 days overdue as missed instead of calling out of the blue', async () => {
    originateCall.mockReset();
    const { callback } = seed();
    fake.tables.callbacks[0].scheduled_at = new Date(Date.now() - 4 * 24 * 3600_000).toISOString();

    expect(await runCallbackDispatchTick()).toBe(0);

    expect(originateCall).not.toHaveBeenCalled();
    const row = fake.tables.callbacks.find((c: any) => c.id === callback.id)!;
    expect(row.status).toBe('failed');
    expect(row.notes).toContain('Missed');
  });
});

describe('callbackDispatcher - never stuck in "calling"', () => {
  beforeEach(() => {
    originateCall.mockReset();
    originateCall.mockResolvedValue({ call: { id: 'call-1' } });
  });

  it('hands the callback back (scheduled) when something unexpected fails after claiming it', async () => {
    const { callback } = seed();
    // The campaign set-up can't be loaded mid-dispatch.
    fake.tables.campaigns.length = 0;
    fake.tables.calls.length = 0;
    (fake.tables as any).campaigns = new Proxy([], { get: () => { throw new Error('db down'); } });
    const result = await dispatchCallback(fake.supabase as any, callback);
    (fake.tables as any).campaigns = [];
    expect(result).toBe('waiting');
    expect(originateCall).not.toHaveBeenCalled();
    expect(fake.tables.callbacks.find((c: any) => c.id === callback.id)!.status).toBe('scheduled');
  });

  it('recovers callbacks left in "calling" by a restart: done if a call was placed, otherwise rescheduled', async () => {
    const { callback, leadId } = seed();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const placed = { ...callback, id: randomUUID(), status: 'calling', updated_at: old };
    const notPlaced = { ...callback, id: randomUUID(), lead_id: randomUUID(), status: 'calling', updated_at: old };
    const recent = { ...callback, id: randomUUID(), status: 'calling', updated_at: new Date().toISOString() };
    fake.tables.callbacks.push(placed, notPlaced, recent);
    fake.tables.calls.push({ id: 'call-9', organization_id: orgId, lead_id: leadId, created_at: new Date(Date.now() - 19 * 60_000).toISOString() });

    expect(await recoverStuckCallbacks(fake.supabase as any)).toBe(2);
    const status = (id: string) => fake.tables.callbacks.find((c: any) => c.id === id)!.status;
    expect(status(placed.id)).toBe('completed');
    expect(status(notPlaced.id)).toBe('scheduled');
    expect(status(recent.id)).toBe('calling');
  });
});
