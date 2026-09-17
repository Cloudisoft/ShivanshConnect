import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import { buildCdrRows, fetchCdrCallsPage } from './cdrQuery.js';

/** Seeds a minimal but realistic set of rows across every table
 * buildCdrRows() joins against, for one organization plus one call each
 * in a different org (for the cross-org isolation assertion). */
function seed() {
  const { supabase, tables } = createFakeSupabase();
  const orgId = randomUUID();
  const otherOrgId = randomUUID();

  const agentId = randomUUID();
  tables.ai_agents.push({ id: agentId, organization_id: orgId, name: 'Sales Agent' });
  const agentVersionId = randomUUID();
  const voiceId = randomUUID();
  tables.voices.push({ id: voiceId, organization_id: orgId, name: 'Aria', provider_key: 'elevenlabs', provider_voice_id: 'v1' });
  tables.ai_agent_versions.push({ id: agentVersionId, organization_id: orgId, ai_agent_id: agentId, voice_id: voiceId });

  const campaignId = randomUUID();
  tables.campaigns.push({ id: campaignId, organization_id: orgId, name: 'Spring Outreach' });

  const leadId = randomUUID();
  tables.leads.push({ id: leadId, organization_id: orgId, first_name: 'Jane', last_name: 'Doe', phone_normalized: '+15005550002' });

  const phoneNumberId = randomUUID();
  tables.phone_numbers.push({ id: phoneNumberId, organization_id: orgId, phone_number: '+15005550001' });

  const connectedDispositionId = tables.dispositions.find((d) => d.code === 'CALL_CONNECTED')!.id;

  const call1 = {
    id: randomUUID(),
    organization_id: orgId,
    engine: 'vapi',
    vapi_call_id: 'vapi-1',
    ai_agent_id: agentId,
    ai_agent_version_id: agentVersionId,
    campaign_id: campaignId,
    lead_id: leadId,
    phone_number_id: phoneNumberId,
    direction: 'outbound',
    customer_number: '+15005550002',
    status: 'completed',
    duration_seconds: 120,
    cost: 0.5,
    created_at: new Date('2026-01-01T10:00:00.000Z').toISOString(),
  };
  tables.calls.push(call1);
  tables.call_dispositions.push({ id: randomUUID(), call_id: call1.id, organization_id: orgId, disposition_id: connectedDispositionId, disposition_source: 'engine' });
  tables.call_transcripts.push({ id: randomUUID(), call_id: call1.id, organization_id: orgId, status: 'ready', full_text: 'hi' });
  tables.call_recordings.push({ id: randomUUID(), call_id: call1.id, organization_id: orgId, status: 'ready' });

  const call2 = { ...call1, id: randomUUID(), vapi_call_id: 'vapi-2', status: 'failed', duration_seconds: 0, created_at: new Date('2026-01-02T10:00:00.000Z').toISOString() };
  tables.calls.push(call2);

  // A call in a completely different org - must never appear in orgId's results.
  const otherCall = { ...call1, id: randomUUID(), organization_id: otherOrgId, vapi_call_id: 'vapi-other' };
  tables.calls.push(otherCall);

  return { supabase, tables, orgId, otherOrgId, campaignId, call1, call2, otherCall };
}

describe('cdrQuery.fetchCdrCallsPage / buildCdrRows', () => {
  it('scopes results to the given organization only (cross-org isolation)', async () => {
    const { supabase, orgId } = seed();
    const { calls, count } = await fetchCdrCallsPage(supabase as any, orgId, {}, 1, 20);
    expect(count).toBe(2);
    expect(calls.every((c) => c.organization_id === orgId)).toBe(true);
  });

  it('filters by status', async () => {
    const { supabase, orgId } = seed();
    const { calls } = await fetchCdrCallsPage(supabase as any, orgId, { status: 'failed' }, 1, 20);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('failed');
  });

  it('filters by campaign_id', async () => {
    const { supabase, orgId, campaignId } = seed();
    const { calls } = await fetchCdrCallsPage(supabase as any, orgId, { campaign_id: campaignId }, 1, 20);
    expect(calls).toHaveLength(2);
  });

  it('filters by disposition code, resolving it to the matching call ids first', async () => {
    const { supabase, orgId, call1 } = seed();
    const { calls } = await fetchCdrCallsPage(supabase as any, orgId, { disposition: 'CALL_CONNECTED' }, 1, 20);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(call1.id);
  });

  it('returns an empty page (not an error, not everything) for a disposition filter that matches nothing', async () => {
    const { supabase, orgId } = seed();
    const { calls, count } = await fetchCdrCallsPage(supabase as any, orgId, { disposition: 'NOT_A_REAL_CODE' }, 1, 20);
    expect(calls).toEqual([]);
    expect(count).toBe(0);
  });

  it('paginates with real page/page_size range semantics', async () => {
    const { supabase, orgId } = seed();
    const page1 = await fetchCdrCallsPage(supabase as any, orgId, {}, 1, 1);
    const page2 = await fetchCdrCallsPage(supabase as any, orgId, {}, 2, 1);
    expect(page1.calls).toHaveLength(1);
    expect(page2.calls).toHaveLength(1);
    expect(page1.calls[0].id).not.toBe(page2.calls[0].id);
  });

  it('buildCdrRows joins campaign/lead/agent/voice/phone/disposition/artifact-existence for every row, batched (no per-row query dependency)', async () => {
    const { supabase, orgId, call1, call2 } = seed();
    const rows = await buildCdrRows(supabase as any, orgId, [call1, call2]);
    expect(rows).toHaveLength(2);

    const row1 = rows.find((r) => r.call_id === call1.id)!;
    expect(row1.campaign_name).toBe('Spring Outreach');
    expect(row1.lead_name).toBe('Jane Doe');
    expect(row1.ai_agent_name).toBe('Sales Agent');
    expect(row1.voice_name).toBe('Aria');
    expect(row1.caller_number).toBe('+15005550001');
    expect(row1.disposition_code).toBe('CALL_CONNECTED');
    expect(row1.has_transcript).toBe(true);
    expect(row1.has_recording).toBe(true);
    expect(row1.has_summary).toBe(false);

    const row2 = rows.find((r) => r.call_id === call2.id)!;
    expect(row2.has_transcript).toBe(false);
    expect(row2.disposition_code).toBeNull();
  });

  it('never returns a row for a call belonging to a different organization even when its id is passed directly', async () => {
    const { supabase, otherOrgId, otherCall } = seed();
    const rows = await buildCdrRows(supabase as any, otherOrgId, [otherCall]);
    expect(rows).toHaveLength(1);
    expect(rows[0].call_id).toBe(otherCall.id);
  });
});
