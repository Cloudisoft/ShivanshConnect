import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import { _resetTerminalCallHandlerForTests, callEventBus, registerTerminalCallHandler, transitionCallState } from './callStateMachine.js';

function seedCall(fake: ReturnType<typeof createFakeSupabase>, overrides: Record<string, any> = {}) {
  const id = randomUUID();
  const call = {
    id,
    organization_id: 'org-1',
    engine: 'vapi',
    vapi_call_id: `vapi_${id}`,
    pipecat_call_id: null,
    ai_agent_id: 'agent-1',
    ai_agent_version_id: 'version-1',
    campaign_id: null,
    lead_id: null,
    phone_number_id: 'phone-1',
    direction: 'outbound',
    customer_number: '+14155550100',
    status: 'queued',
    started_at: null,
    answered_at: null,
    ended_at: null,
    duration_seconds: null,
    talk_duration_seconds: null,
    ended_reason: null,
    transfer_destination_e164: null,
    transfer_status: null,
    cost: null,
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
  fake.tables.calls.push(call);
  return call;
}

describe('lib/callStateMachine.ts - transitionCallState()', () => {
  afterEach(() => {
    _resetTerminalCallHandlerForTests();
    callEventBus.removeAllListeners();
  });

  it('applies a valid transition, persists it, and logs a call_events row', async () => {
    const fake = createFakeSupabase();
    const call = seedCall(fake);

    const result = await transitionCallState(fake.supabase as any, call.id, 'dialing');
    expect(result.applied).toBe(true);
    expect(result.call!.status).toBe('dialing');

    const persisted = fake.tables.calls.find((c) => c.id === call.id)!;
    expect(persisted.status).toBe('dialing');

    const events = fake.tables.call_events.filter((e) => e.call_id === call.id);
    expect(events.some((e) => e.event_type === 'call.transitioned.dialing')).toBe(true);
  });

  it('rejects and LOGS an invalid transition instead of silently applying it', async () => {
    const fake = createFakeSupabase();
    const call = seedCall(fake, { status: 'queued' });

    const result = await transitionCallState(fake.supabase as any, call.id, 'completed');
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('invalid_transition');

    // Never applied - the row is untouched.
    const persisted = fake.tables.calls.find((c) => c.id === call.id)!;
    expect(persisted.status).toBe('queued');

    const events = fake.tables.call_events.filter((e) => e.call_id === call.id);
    expect(events.some((e) => e.event_type === 'call.invalid_transition_rejected')).toBe(true);
  });

  it('treats a repeated identical status as a no-op (never re-applies, never re-emits)', async () => {
    const fake = createFakeSupabase();
    const call = seedCall(fake, { status: 'in_progress' });

    let emitted = 0;
    callEventBus.on('call.transitioned', () => emitted += 1);

    const result = await transitionCallState(fake.supabase as any, call.id, 'in_progress');
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('noop_same_status');
    expect(emitted).toBe(0);
  });

  it('emits call.transitioned and call.terminal, and awaits the registered terminal handler, only for a terminal status', async () => {
    const fake = createFakeSupabase();
    const call = seedCall(fake, { status: 'in_progress' });

    let transitionedCount = 0;
    let terminalCount = 0;
    callEventBus.on('call.transitioned', () => transitionedCount += 1);
    callEventBus.on('call.terminal', () => terminalCount += 1);

    let handlerAwaited = false;
    registerTerminalCallHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      handlerAwaited = true;
    });

    const result = await transitionCallState(fake.supabase as any, call.id, 'completed');
    expect(result.applied).toBe(true);
    expect(transitionedCount).toBe(1);
    expect(terminalCount).toBe(1);
    // The handler is AWAITED before transitionCallState resolves.
    expect(handlerAwaited).toBe(true);
  });

  it('does not invoke the terminal handler for a non-terminal transition', async () => {
    const fake = createFakeSupabase();
    const call = seedCall(fake, { status: 'queued' });

    let called = false;
    registerTerminalCallHandler(async () => { called = true; });

    await transitionCallState(fake.supabase as any, call.id, 'dialing');
    expect(called).toBe(false);
  });

  it('returns call_not_found for a nonexistent call id instead of throwing', async () => {
    const fake = createFakeSupabase();
    const result = await transitionCallState(fake.supabase as any, randomUUID(), 'dialing');
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('call_not_found');
  });
});
