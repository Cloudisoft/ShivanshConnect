/**
 * Phase 15 load test: seeding helpers.
 *
 * Everything here writes directly through the real-Postgres-backed
 * `PgSupabaseAdapter` (src/loadtest/pgSupabaseAdapter.ts) - genuine INSERT
 * statements against genuine tables created by the real
 * `supabase/migrations/*.sql` files. This deliberately bypasses the HTTP/
 * auth layer (signup, JWT, `authenticate`/`requirePermission` middleware) -
 * that layer is already covered by hundreds of existing integration tests
 * against `fakeSupabase` (see campaigns.integration.test.ts and friends).
 * What this load test exists to prove is scale/concurrency/correctness of
 * the DISPATCH pipeline itself (services/campaignDispatcher.ts,
 * leadEligibility.ts, callStateMachine.ts, dispositionEngine.ts,
 * campaignLeadDisposition.ts) against a REAL Postgres instance, so seeding
 * goes straight to the tables those modules read - the exact same shapes
 * `campaigns.integration.test.ts`'s own 1000-lead synthetic-batch test
 * already establishes as an accepted, documented pattern in this codebase
 * (see that test's "Insert 1000 leads + campaign_leads rows directly"
 * comment).
 */
import { randomUUID } from 'node:crypto';
import { encryptCredentials } from '../lib/crypto/credentials.js';
import type { PgSupabaseAdapter } from './pgSupabaseAdapter.js';

export interface SeededOrgBasics {
  organizationId: string;
  agentId: string;
  agentVersionId: string;
  phoneNumberId: string;
}

/** Creates one organization with everything a campaign needs to actually
 * dial through the (mocked-at-fetch) Vapi engine: a published agent
 * version, a BYON phone number (no external telephony credentials
 * needed), and connected Vapi credentials (a real AES-256-GCM envelope via
 * the real encryptCredentials() helper - never a plaintext shortcut). */
export async function seedOrgBasics(adapter: PgSupabaseAdapter, orgName: string): Promise<SeededOrgBasics> {
  const supabase = adapter.supabase;
  const organizationId = randomUUID();
  const slug = `${orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${organizationId.slice(0, 8)}`;
  const { error: orgErr } = await supabase.from('organizations').insert({ id: organizationId, name: orgName, slug });
  if (orgErr) throw new Error(`seedOrgBasics: organizations insert failed: ${orgErr.message}`);

  const agentId = randomUUID();
  await supabase.from('ai_agents').insert({ id: agentId, organization_id: organizationId, name: 'Load Test Agent', role: 'sales_agent', status: 'active' });

  const agentVersionId = randomUUID();
  await supabase.from('ai_agent_versions').insert({
    id: agentVersionId,
    agent_id: agentId,
    organization_id: organizationId,
    version_number: 1,
    system_prompt: 'You are a helpful sales agent running a load test.',
    greeting_template: 'Hi there, this is a load test call.',
    // These jsonb columns default to '{}' at the DB level (see
    // supabase/migrations/00000000000018_ai_agent_versions.sql) - the real
    // POST /agents/:id/versions route always fills in the full shape via
    // its zod schema defaults before insert (schemas/agents.ts), which
    // this direct-SQL seed path bypasses (see this file's header for why).
    // buildAssistantConfig()/toVapiAssistantPayload() in
    // lib/orchestration/vapi.ts assume the full shape is always present,
    // so it must be seeded here explicitly rather than left at '{}'.
    personality: { tone: null, personality_traits: [], behavior_traits: [] },
    transfer_rules: { on_no_match: 'end_call', transfer_to: null, conditions: [] },
    call_ending_rules: { max_call_duration_seconds: null, end_phrases: [], summarize_before_ending: true },
    status: 'published',
    published_at: new Date().toISOString(),
  });
  await supabase.from('ai_agents').update({ current_version_id: agentVersionId }).eq('id', agentId);

  const phoneNumberId = randomUUID();
  await supabase.from('phone_numbers').insert({
    id: phoneNumberId,
    organization_id: organizationId,
    provider_key: 'byon',
    phone_number: `+1484555${String(1000 + Math.floor(Math.random() * 8999)).padStart(4, '0')}`,
    capabilities: { voice_inbound: true, voice_outbound: true, sms: false },
    status: 'active',
    sip_trunk_metadata: { host: 'sip.loadtest.example.com', username: 'trunk-user', password: 'trunk-secret' },
  });

  const envelope = encryptCredentials({ api_key: 'sk-vapi-loadtest' }, process.env.CREDENTIAL_ENCRYPTION_KEY);
  await supabase.from('vapi_credentials').insert({ id: randomUUID(), organization_id: organizationId, encrypted_credentials: envelope as any, status: 'connected' });

  // Without this row, services/leadEligibility.ts's effectiveConcurrency()
  // falls back to its hardcoded default org ceiling of 25 - a real
  // production safety net, but one that would silently cap this load
  // test's 250/500-concurrency tiers at 25 and invalidate the whole
  // measurement. A real org running a genuine high-volume campaign would
  // configure this the same way (Settings > Dialing).
  await supabase.from('dialing_settings').insert({
    id: randomUUID(),
    organization_id: organizationId,
    is_default: true,
    max_concurrency: 1000,
    calls_per_minute: 1_000_000,
  });

  return { organizationId, agentId, agentVersionId, phoneNumberId };
}

export interface SeededCampaign {
  campaignId: string;
  versionId: string;
}

/** Creates a published, running-ready campaign version with a wide-open
 * calling window (every day, all day) so eligibility never rejects a lead
 * on calling-window/day grounds - the load test is about dispatch-pipeline
 * throughput/correctness/concurrency, not calendar-window edge cases
 * (those already have dedicated unit coverage in leadEligibility.test.ts).
 * `maxAttempts`/`retryDelayMinutes` are deliberately small so a realistic
 * fraction of simulated no-answer outcomes actually re-enter
 * `retry_pending` and get re-dispatched within the test's own run, without
 * waiting on real wall-clock minutes. */
export async function seedCampaign(
  adapter: PgSupabaseAdapter,
  basics: SeededOrgBasics,
  opts: { name: string; concurrencyLimit: number; maxAttempts: number; retryDelayMinutes: number },
): Promise<SeededCampaign> {
  const supabase = adapter.supabase;
  const campaignId = randomUUID();
  await supabase.from('campaigns').insert({
    id: campaignId,
    organization_id: basics.organizationId,
    name: opts.name,
    status: 'running',
    timezone: 'UTC',
    calling_window_start: '00:00',
    calling_window_end: '23:59',
    calling_days: [1, 2, 3, 4, 5, 6, 7],
    concurrency_limit: opts.concurrencyLimit,
    phone_number_id: basics.phoneNumberId,
    transfer_number_e164: '+14845550099',
    lead_cooldown_minutes: 0,
  });

  const versionId = randomUUID();
  await supabase.from('campaign_versions').insert({
    id: versionId,
    campaign_id: campaignId,
    organization_id: basics.organizationId,
    version_number: 1,
    prompt: 'Hi {{first_name}}, this is a load test call.',
    ai_agent_id: basics.agentId,
    ai_agent_version_id: basics.agentVersionId,
    transfer_number_e164: '+14845550099',
    calling_rules: {
      timezone: 'UTC',
      calling_window_start: '00:00',
      calling_window_end: '23:59',
      calling_days: [1, 2, 3, 4, 5, 6, 7],
      lead_cooldown_minutes: 0,
      voicemail_detection_enabled: true,
      leave_voicemail: true,
    },
    disposition_rules: { max_attempts: opts.maxAttempts, retry_delay_minutes: opts.retryDelayMinutes },
    status: 'published',
    published_at: new Date().toISOString(),
  });
  await supabase.from('campaigns').update({ current_version_id: versionId }).eq('id', campaignId);

  return { campaignId, versionId };
}

/** Bulk-inserts `count` synthetic leads (shared, reusable across every
 * campaign/tier in the run - a lead is a person, independent of which
 * campaign is currently dialing them) via real multi-row INSERTs, batched
 * (BATCH_SIZE rows per statement) to stay well under Postgres's own
 * per-statement parameter ceiling while remaining a handful of real round
 * trips rather than 10,000 separate ones - this is seeding, not the
 * dispatcher's own query path (that path's actual LIMIT-bounded batching is
 * covered by its own dedicated test - see dispatchBatching.loadtest.test.ts). */
export async function seedLeads(adapter: PgSupabaseAdapter, organizationId: string, count: number): Promise<string[]> {
  const supabase = adapter.supabase;
  const BATCH_SIZE = 500;
  const leadIds: string[] = [];
  for (let start = 0; start < count; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, count);
    const rows = [];
    for (let i = start; i < end; i += 1) {
      const id = randomUUID();
      leadIds.push(id);
      const phone = `+1202555${String(1000 + i).padStart(5, '0')}`;
      rows.push({
        id,
        organization_id: organizationId,
        first_name: 'Load',
        last_name: `Test${i}`,
        phone_original: phone,
        phone_normalized: phone,
        status: 'NEW',
      });
    }
    const { error } = await supabase.from('leads').insert(rows);
    if (error) throw new Error(`seedLeads batch [${start},${end}) failed: ${error.message}`);
  }
  return leadIds;
}

/** Attaches every lead in `leadIds` to `campaignId` as a fresh, untouched
 * `campaign_leads` row (status='pending', attempt_count=0) - a fresh wave
 * of 10,000 leads for one concurrency tier's own isolated run. */
export async function attachLeadsToCampaign(adapter: PgSupabaseAdapter, organizationId: string, campaignId: string, leadIds: string[]): Promise<void> {
  const supabase = adapter.supabase;
  const BATCH_SIZE = 500;
  for (let start = 0; start < leadIds.length; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, leadIds.length);
    const rows = leadIds.slice(start, end).map((leadId) => ({
      id: randomUUID(),
      campaign_id: campaignId,
      organization_id: organizationId,
      lead_id: leadId,
      status: 'pending',
      attempt_count: 0,
    }));
    const { error } = await supabase.from('campaign_leads').insert(rows);
    if (error) throw new Error(`attachLeadsToCampaign batch [${start},${end}) failed: ${error.message}`);
  }
}
