import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

vi.mock('../lib/supabase.js', () => ({ getSupabaseAdmin: () => fake.supabase }));

const fake = createFakeSupabase();
const provider = {
  getCall: vi.fn(),
  transferCall: vi.fn(),
};

vi.mock('../lib/orchestration/resolveProvider.js', () => ({ resolveProviderForCall: async () => provider }));

const { announcesTransfer, performAutoTransfer } = await import('./autoTransfer.js');

function seedCall(overrides: Record<string, unknown> = {}) {
  const call = {
    id: `call-${Math.random()}`,
    organization_id: 'org-1',
    engine: 'vapi',
    vapi_call_id: 'vapi-1',
    status: 'in_progress',
    transfer_destination_e164: '+14845559999',
    ...overrides,
  };
  fake.tables.calls.push(call);
  return call;
}

describe('autoTransfer', () => {
  beforeEach(() => {
    fake.tables.calls.length = 0;
    provider.getCall.mockReset();
    provider.transferCall.mockReset();
  });

  it('recognizes the ways the assistant announces a transfer', () => {
    for (const text of [
      'Sure, transferring you now.',
      "Great, I'm transferring you to a specialist.",
      'Let me transfer you over to our team.',
      "I'll transfer you right away.",
      'Connecting you now, one moment.',
      'Transferring the call now.',
      'Okay, I am transferring the call.',
      "Perfect, I'm going to get you connected with a specialist.",
      'Please hold while I put you through.',
    ]) {
      expect(announcesTransfer(text)).toBe(true);
    }
    for (const text of ['Can I get your name?', 'We handle transfers of ownership too.', 'Is this a good time?']) {
      expect(announcesTransfer(text)).toBe(false);
    }
  });

  it('transfers an announced call that is still in progress to its own configured destination', async () => {
    const call = seedCall();
    provider.getCall.mockResolvedValue({ status: 'in-progress', raw: {} });

    expect(await performAutoTransfer(fake.supabase as any, call.id)).toBe('transferred');
    expect(provider.transferCall).toHaveBeenCalledWith('vapi-1', '+14845559999');
    const updated = fake.tables.calls.find((c: any) => c.id === call.id)!;
    expect(updated.status).toBe('transfer_pending');
    expect(updated.transfer_initiated_by).toBe('ai');
  });

  it('does nothing when Vapi is already forwarding the call (the transferCall tool fired)', async () => {
    const call = seedCall();
    provider.getCall.mockResolvedValue({ status: 'forwarding', raw: {} });

    expect(await performAutoTransfer(fake.supabase as any, call.id)).toBe('skipped');
    expect(provider.transferCall).not.toHaveBeenCalled();
  });

  it('does nothing without a transfer destination or once the call is no longer live', async () => {
    const noDestination = seedCall({ transfer_destination_e164: null });
    const alreadyTransferring = seedCall({ status: 'transferring' });

    expect(await performAutoTransfer(fake.supabase as any, noDestination.id)).toBe('skipped');
    expect(await performAutoTransfer(fake.supabase as any, alreadyTransferring.id)).toBe('skipped');
    expect(provider.transferCall).not.toHaveBeenCalled();
  });
});
