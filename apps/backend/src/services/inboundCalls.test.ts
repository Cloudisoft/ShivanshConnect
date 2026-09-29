import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

vi.mock('../lib/supabase.js', () => ({ getSupabaseAdmin: () => fake.supabase }));
const buildInboundAssistant = vi.fn((_config: unknown, opts: Record<string, unknown>) => ({ built: true, ...opts }));
vi.mock('./callOrigination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./callOrigination.js')>()),
  getOrgVapiProvider: async () => ({ buildInboundAssistant }),
  resolveDefaultEngine: async () => 'vapi',
}));

const fake = createFakeSupabase();
const { handleAssistantRequest } = await import('./inboundCalls.js');
const { processToolCalls } = await import('./toolCallHandler.js');

const orgId = randomUUID();
const agentId = randomUUID();
const agentVersionId = randomUUID();
const phoneId = randomUUID();
const campaignId = randomUUID();

function reset() {
  for (const t of Object.keys(fake.tables)) (fake.tables as any)[t].length = 0;
  fake.tables.organizations.push({ id: orgId, name: 'Acme Law', timezone: 'America/New_York' });
  fake.tables.ai_agent_versions.push({
    id: agentVersionId,
    agent_id: agentId,
    organization_id: orgId,
    status: 'published',
    published_at: new Date().toISOString(),
    system_prompt: 'You are {{agent_name}}, a friendly case intake agent.',
    greeting_template: 'Hi, is this {{first_name}}?',
    personality: { tone: 'warm', personality_traits: [], behavior_traits: [] },
    llm_provider: 'openai',
    llm_model: 'gpt-4o-mini',
    llm_temperature: 0.5,
    llm_max_tokens: 300,
    transfer_rules: { on_no_match: 'end_call', transfer_to: null, conditions: [] },
  });
  fake.tables.ai_agents.push({ id: agentId, organization_id: orgId, name: 'Intake' });
  fake.tables.phone_numbers.push({ id: phoneId, organization_id: orgId, phone_number: '+14845551111', vapi_phone_number_id: 'vapi-pn-1', status: 'active' });
  const versionId = randomUUID();
  fake.tables.campaigns.push({ id: campaignId, organization_id: orgId, name: 'MVA (copy)', status: 'running', current_version_id: versionId, updated_at: new Date().toISOString() });
  fake.tables.campaign_versions.push({ id: versionId, campaign_id: campaignId, ai_agent_id: agentId, ai_agent_version_id: agentVersionId, transfer_number_e164: '+19735550100', knowledge_base_ids: [], calling_rules: null });
  fake.tables.campaign_phone_numbers.push({ campaign_id: campaignId, phone_number_id: phoneId, phone_numbers: fake.tables.phone_numbers[0] });
}

function assistantRequest(caller: string) {
  return { type: 'assistant-request', phoneNumber: { id: 'vapi-pn-1' }, customer: { number: caller }, call: { id: `vapi-call-${randomUUID()}`, customer: { number: caller } } };
}

describe('inbound calls', () => {
  beforeEach(() => {
    reset();
    buildInboundAssistant.mockClear();
  });

  it('greets a returning caller by name, on behalf of the campaign that called them, and records the inbound call', async () => {
    const leadId = randomUUID();
    fake.tables.leads.push({ id: leadId, organization_id: orgId, first_name: 'Priya', last_name: 'Shah', phone_normalized: '+14845552222', email: null, custom_fields: {}, updated_at: new Date().toISOString() });
    fake.tables.calls.push({ id: randomUUID(), organization_id: orgId, lead_id: leadId, campaign_id: campaignId, direction: 'outbound', created_at: new Date(Date.now() - 3600_000).toISOString() });

    const response = await handleAssistantRequest(fake.supabase as any, assistantRequest('+14845552222'));

    expect(response.error).toBeUndefined();
    const opts = buildInboundAssistant.mock.calls[0][1] as Record<string, any>;
    expect(opts.firstMessage).toBe('Hi Priya, thanks for calling back! This is your assistant from MVA. How can I help you today?');
    expect(opts.systemPrompt).toContain('INBOUND CALL');
    expect(opts.systemPrompt).toContain('about MVA');
    expect(opts.systemPrompt).toContain('save_caller_details');
    expect(opts.systemPrompt).toContain('Current date and time');
    expect(opts.transferDestinationE164).toBe('+19735550100');
    const inbound = fake.tables.calls.find((c: any) => c.direction === 'inbound')!;
    expect(inbound.lead_id).toBe(leadId);
    expect(inbound.campaign_id).toBe(campaignId);
    expect(inbound.status).toBe('answered');
  });

  it('answers an unknown caller on behalf of the campaign dialing from that number, and asks who they are', async () => {
    const response = await handleAssistantRequest(fake.supabase as any, assistantRequest('+14845553333'));
    expect(response.error).toBeUndefined();
    const opts = buildInboundAssistant.mock.calls[0][1] as Record<string, any>;
    expect(opts.firstMessage).toBe("Hi, thanks for calling MVA! This is your assistant. May I ask who I'm speaking with?");
    expect(opts.systemPrompt).toContain("don't have this caller on file");
  });

  it('saves an unknown caller as a new lead when they give their details', async () => {
    await handleAssistantRequest(fake.supabase as any, assistantRequest('+14845553333'));
    const call = fake.tables.calls.find((c: any) => c.direction === 'inbound')!;

    const result = await processToolCalls(fake.supabase as any, call, [
      { id: 'tc-1', name: 'save_caller_details', arguments: { first_name: 'Sam', last_name: 'Lee', email: 'Sam@Example.com', purpose: 'Rear-ended last week' } },
    ]);

    expect(result.results[0]).toEqual({ toolCallId: 'tc-1', result: 'Saved.' });
    const lead = fake.tables.leads.find((l: any) => l.phone_normalized === '+14845553333')!;
    expect(lead.first_name).toBe('Sam');
    expect(lead.email).toBe('sam@example.com');
    expect(lead.custom_fields.purpose).toBe('Rear-ended last week');
    expect(fake.tables.calls.find((c: any) => c.id === call.id)!.lead_id).toBe(lead.id);
  });

  it('falls back (error -> the number\'s fallback destination) for a number that is not ours', async () => {
    const response = await handleAssistantRequest(fake.supabase as any, { ...assistantRequest('+14845552222'), phoneNumber: { id: 'unknown' } });
    expect(response.error).toBeTruthy();
    expect(buildInboundAssistant).not.toHaveBeenCalled();
  });
});

describe('schedule_callback tool', () => {
  beforeEach(reset);

  it('schedules a callback from an inbound caller we did not know yet, and tells the model it worked', async () => {
    await handleAssistantRequest(fake.supabase as any, assistantRequest('+14845554444'));
    const call = fake.tables.calls.find((c: any) => c.direction === 'inbound')!;
    const when = new Date(Date.now() + 24 * 3600_000).toISOString();

    const result = await processToolCalls(fake.supabase as any, call, [{ id: 'tc-2', name: 'schedule_callback', arguments: { scheduled_at: when, reason: 'Busy at work' } }]);

    expect(result.results[0].result).toContain('Callback scheduled');
    const callback = fake.tables.callbacks[0];
    expect(callback.phone_e164).toBe('+14845554444');
    expect(callback.assigned_to).toBe('ai');
    expect(callback.source_call_id).toBe(call.id);
  });

  it('tells the model when the time is in the past instead of silently dropping it', async () => {
    await handleAssistantRequest(fake.supabase as any, assistantRequest('+14845554444'));
    const call = fake.tables.calls.find((c: any) => c.direction === 'inbound')!;
    const result = await processToolCalls(fake.supabase as any, call, [{ id: 'tc-3', name: 'schedule_callback', arguments: { scheduled_at: '2020-01-01T10:00:00Z' } }]);
    expect(result.results[0].result).toContain('Not scheduled');
    expect(fake.tables.callbacks).toHaveLength(0);
  });
});
