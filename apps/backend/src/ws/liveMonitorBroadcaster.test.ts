import { describe, expect, it } from 'vitest';
import { callEventBus, type CallTransitionEvent } from '../lib/callStateMachine.js';
import { emitLiveTranscriptSegment } from '../lib/transcriptEventBus.js';
import { registerLiveMonitorSubscriber } from './liveMonitorBroadcaster.js';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import type { LiveMonitorWsEvent } from '@shivanshconnect/shared';

/**
 * Phase 10: the hard cross-org isolation requirement, tested directly
 * against the in-process broadcaster (no real WebSocket needed - see
 * ws/liveMonitorBroadcaster.ts's header comment for why this is the
 * intended way to prove ordering/isolation without spinning up a client).
 */

function baseCall(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: 'call-1',
    organization_id: 'org-A',
    engine: 'vapi',
    status: 'ringing',
    direction: 'outbound',
    customer_number: '+14845551234',
    started_at: null,
    answered_at: null,
    campaign_id: null,
    lead_id: null,
    ai_agent_id: null,
    ai_agent_version_id: null,
    ...overrides,
  };
}

function makeTransition(organizationId: string, from: any, to: any, callOverrides: Record<string, any> = {}): CallTransitionEvent {
  return {
    callId: callOverrides.id ?? 'call-1',
    organizationId,
    from,
    to,
    call: baseCall({ organization_id: organizationId, status: to, ...callOverrides }),
    context: {},
  };
}

describe('registerLiveMonitorSubscriber (Phase 10 org isolation)', () => {
  it('delivers a call-transitioned event only to a subscriber for the SAME organization', async () => {
    const { supabase: rawSupabase } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const eventsForOrgA: LiveMonitorWsEvent[] = [];
    const eventsForOrgB: LiveMonitorWsEvent[] = [];

    const unsubA = registerLiveMonitorSubscriber(supabase, 'org-A', (e) => eventsForOrgA.push(e));
    const unsubB = registerLiveMonitorSubscriber(supabase, 'org-B', (e) => eventsForOrgB.push(e));

    callEventBus.emit('call.transitioned', makeTransition('org-A', 'ringing', 'answered'));
    // Let the async buildLiveMonitorActiveCalls().then(...) callbacks flush.
    await new Promise((r) => setTimeout(r, 0));

    expect(eventsForOrgA).toHaveLength(1);
    expect(eventsForOrgA[0].type).toBe('CALL_CONNECTED');
    expect(eventsForOrgA[0].organization_id).toBe('org-A');
    // org B's subscriber must receive ZERO events from org A's call.
    expect(eventsForOrgB).toHaveLength(0);

    unsubA();
    unsubB();
  });

  it('never leaks a transcript segment event across organizations', () => {
    const { supabase: rawSupabase } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const eventsForOrgA: LiveMonitorWsEvent[] = [];
    const eventsForOrgB: LiveMonitorWsEvent[] = [];

    const unsubA = registerLiveMonitorSubscriber(supabase, 'org-A', (e) => eventsForOrgA.push(e));
    const unsubB = registerLiveMonitorSubscriber(supabase, 'org-B', (e) => eventsForOrgB.push(e));

    emitLiveTranscriptSegment({
      callId: 'call-1',
      organizationId: 'org-A',
      segment: { id: 'seg-1', call_id: 'call-1', segment_index: 0, speaker: 'ai', start_ms: 0, end_ms: null, text: 'Hello John, this is Acme calling.' },
    });

    expect(eventsForOrgA).toHaveLength(1);
    expect(eventsForOrgA[0].type).toBe('TRANSCRIPT_UPDATED');
    expect(eventsForOrgA[0].segment?.text).toBe('Hello John, this is Acme calling.');
    expect(eventsForOrgB).toHaveLength(0);

    unsubA();
    unsubB();
  });

  it('unsubscribe actually stops delivery (no leaked listener across tests/connections)', async () => {
    const { supabase: rawSupabase } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const events: LiveMonitorWsEvent[] = [];
    const unsub = registerLiveMonitorSubscriber(supabase, 'org-A', (e) => events.push(e));
    unsub();

    callEventBus.emit('call.transitioned', makeTransition('org-A', 'ringing', 'answered'));
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(0);
  });

  it('emits CALL_ENDED with call:null on a terminal transition (the call has left the active set)', async () => {
    const { supabase: rawSupabase } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const events: LiveMonitorWsEvent[] = [];
    const unsub = registerLiveMonitorSubscriber(supabase, 'org-A', (e) => events.push(e));

    callEventBus.emit('call.transitioned', makeTransition('org-A', 'in_progress', 'completed'));
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('CALL_ENDED');
    expect(events[0].call).toBeNull();

    unsub();
  });

  it('the full started->ringing->connected->transferring->transferred sequence arrives in order for one org', async () => {
    const { supabase: rawSupabase } = createFakeSupabase();
    const supabase = rawSupabase as any;
    const events: LiveMonitorWsEvent[] = [];
    const unsub = registerLiveMonitorSubscriber(supabase, 'org-A', (e) => events.push(e));

    const transitions: [any, any][] = [
      ['queued', 'dialing'],
      ['dialing', 'ringing'],
      ['ringing', 'in_progress'],
      ['in_progress', 'transferring'],
      ['transferring', 'transferred'],
    ];
    for (const [from, to] of transitions) {
      callEventBus.emit('call.transitioned', makeTransition('org-A', from, to));
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(events.map((e) => e.type)).toEqual(['CALL_STARTED', 'CALL_RINGING', 'CALL_CONNECTED', 'CALL_TRANSFER_STARTED', 'CALL_TRANSFER_CONNECTED']);

    unsub();
  });
});
