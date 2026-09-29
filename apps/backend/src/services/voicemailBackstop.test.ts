import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

vi.mock('../lib/supabase.js', () => ({ getSupabaseAdmin: () => fake.supabase }));

const fake = createFakeSupabase();
const provider = {
  getCall: vi.fn(),
  endCall: vi.fn(),
  say: vi.fn(),
};

vi.mock('../lib/orchestration/resolveProvider.js', () => ({ resolveProviderForCall: async () => provider }));

const { isVoicemailGreeting, handleVoicemailBackstop, checkForVoicemail, resetVoicemailWatches } = await import('./voicemailBackstop.js');

function seedCall(overrides: Record<string, unknown> = {}) {
  const call = {
    id: `call-${Math.random()}`,
    organization_id: 'org-1',
    engine: 'vapi',
    vapi_call_id: 'vapi-1',
    status: 'in_progress',
    direction: 'outbound',
    campaign_id: null as string | null,
    ...overrides,
  };
  fake.tables.calls.push(call);
  return call;
}

describe('voicemailBackstop', () => {
  beforeEach(() => {
    fake.tables.calls.length = 0;
    fake.tables.call_events.length = 0;
    fake.tables.campaigns.length = 0;
    provider.getCall.mockReset();
    provider.endCall.mockReset();
    provider.say.mockReset();
    resetVoicemailWatches();
  });

  it('recognizes voicemail greetings and not ordinary answers', () => {
    for (const text of [
      "Hi, you've reached John. Please leave a message after the tone.",
      'The person you are trying to reach is not available.',
      'Your call has been forwarded to an automated voice messaging system.',
      "Sorry I can't take your call right now.",
      'Please record your message.',
      'The mailbox is full.',
      "I'm not available right now, I'll get back to you.",
      'At the tone, please record your message.',
    ]) {
      expect(isVoicemailGreeting(text)).toBe(true);
    }
    for (const text of ['Hello?', "I'm good, who is this?", 'Yes, this is Alex.', 'Not interested, thanks.', 'Can you call me later?']) {
      expect(isVoicemailGreeting(text)).toBe(false);
    }
  });

  it('marks the call as voicemail and hangs up when no message is configured', async () => {
    const call = seedCall();
    provider.getCall.mockResolvedValue({ status: 'in-progress', raw: {} });
    expect(await handleVoicemailBackstop(fake.supabase as any, call.id)).toBe('ended');
    expect(provider.say).not.toHaveBeenCalled();
    expect(provider.endCall).toHaveBeenCalledWith('vapi-1');
    expect(fake.tables.call_events.some((e: any) => e.call_id === call.id && e.event_type === 'call.amd_detected')).toBe(true);
    expect(fake.tables.calls.find((c: any) => c.id === call.id)?.status).toBe('voicemail');
    // Only real columns are written onto the call (an unknown one made the
    // real database reject the update and the hang-up never happened).
    expect(Object.keys(fake.tables.calls.find((c: any) => c.id === call.id)!)).not.toContain('detected_by');
  });

  it("leaves the campaign's voicemail script, then hangs up", async () => {
    vi.useFakeTimers();
    try {
      fake.tables.campaigns.push({ id: 'camp-1', voicemail_detection_enabled: true, leave_voicemail: true, voicemail_message: 'Please call us back.' });
      const call = seedCall({ campaign_id: 'camp-1' });
      provider.getCall.mockResolvedValue({ status: 'in-progress', raw: {} });
      provider.say.mockResolvedValue(undefined);
      const done = handleVoicemailBackstop(fake.supabase as any, call.id);
      await vi.runAllTimersAsync();
      expect(await done).toBe('ended');
      expect(provider.say).toHaveBeenCalledWith('vapi-1', 'Please call us back.');
      expect(provider.say.mock.invocationCallOrder[0]).toBeLessThan(provider.endCall.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('just hangs up when the campaign has no voicemail script', async () => {
    fake.tables.campaigns.push({ id: 'camp-2', voicemail_detection_enabled: true, leave_voicemail: false, voicemail_message: 'unused' });
    const call = seedCall({ campaign_id: 'camp-2' });
    provider.getCall.mockResolvedValue({ status: 'in-progress', raw: {} });
    expect(await handleVoicemailBackstop(fake.supabase as any, call.id)).toBe('ended');
    expect(provider.say).not.toHaveBeenCalled();
    expect(provider.endCall).toHaveBeenCalledWith('vapi-1');
  });

  it("doesn't leave the script twice when Vapi is already leaving it", async () => {
    fake.tables.campaigns.push({ id: 'camp-3', voicemail_detection_enabled: true, leave_voicemail: true, voicemail_message: 'Hi, this is Ashton from Motor Vehicle Accident Helpline.' });
    const call = seedCall({ campaign_id: 'camp-3' });
    expect(await handleVoicemailBackstop(fake.supabase as any, call.id, ['Hi, this is Ashton from Motor Vehicle Accident Helpline, please call back.'])).toBe('skipped');
    expect(provider.endCall).not.toHaveBeenCalled();
  });

  it('does nothing once Vapi has already ended the call', async () => {
    const call = seedCall();
    provider.getCall.mockResolvedValue({ status: 'ended', raw: {} });
    expect(await handleVoicemailBackstop(fake.supabase as any, call.id)).toBe('skipped');
    expect(provider.endCall).not.toHaveBeenCalled();
  });

  it('only acts on the first lines of the other side, early in the call', async () => {
    vi.useFakeTimers();
    try {
      provider.getCall.mockResolvedValue({ status: 'in-progress', raw: {} });
      // Late in the call - a real conversation mentioning voicemail.
      const late = seedCall();
      checkForVoicemail(fake.supabase as any, late, 'caller', 'I got your voicemail yesterday.', 60);
      // After three ordinary lines.
      const talked = seedCall();
      for (const line of ['Hello?', 'Yes.', 'Go on.']) checkForVoicemail(fake.supabase as any, talked, 'caller', line, 5);
      checkForVoicemail(fake.supabase as any, talked, 'caller', 'Leave a message for my wife.', 20);
      // The AI saying it never counts.
      const aiOnly = seedCall();
      checkForVoicemail(fake.supabase as any, aiOnly, 'ai', 'Please leave a message.', 2);
      await vi.runAllTimersAsync();
      expect(provider.endCall).not.toHaveBeenCalled();

      const vm = seedCall();
      checkForVoicemail(fake.supabase as any, vm, 'caller', 'You have reached the voicemail of Alex.', 4);
      checkForVoicemail(fake.supabase as any, vm, 'caller', 'Please leave a message after the beep.', 7);
      await vi.runAllTimersAsync();
      expect(provider.endCall).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('voicemailBackstop - call already ended by Vapi', () => {
  it('treats "Not Active" as already handled, not an error', async () => {
    provider.endCall.mockReset();
    provider.getCall.mockReset();
    fake.tables.campaigns.push({ id: 'camp-na', voicemail_detection_enabled: true, leave_voicemail: true, voicemail_message: 'Please call us back.' });
    const call = seedCall({ campaign_id: 'camp-na' });
    provider.getCall.mockResolvedValue({ status: 'in-progress', raw: {} });
    provider.say.mockRejectedValue(new Error('Vapi say control message failed (400): {"error":"Call `x` Not Active."}'));
    expect(await handleVoicemailBackstop(fake.supabase as any, call.id)).toBe('skipped');
    expect(provider.endCall).not.toHaveBeenCalled();
    provider.say.mockReset();
  });
});
