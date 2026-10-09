import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';
import { resetBlocker, resetLeads } from './resetLeads.js';

function seed() {
  const fake = createFakeSupabase();
  const t = fake.tables as any;
  const lead = (id: string, last_disposition: string | null, extra: Record<string, unknown> = {}) =>
    t.leads.push({ id, organization_id: 'org-1', status: 'CONNECTED', is_dnc: false, last_disposition, ...extra });
  lead('vm', 'Voicemail');
  lead('connected', 'Call Connected');
  lead('noanswer', 'No Answer', { status: 'NO_ANSWER' });
  lead('disconnected', 'Disconnected');
  lead('notinservice', 'Not in Service');
  lead('notinterested', 'Not Interested');
  lead('dnc', 'Hung Up', { is_dnc: true });
  lead('oncall', 'Voicemail');
  lead('otherorg', 'Voicemail', { organization_id: 'org-2' });
  for (const id of ['vm', 'connected', 'noanswer', 'disconnected', 'notinservice', 'notinterested', 'dnc', 'oncall', 'otherorg']) {
    t.campaign_leads.push({ id: `cl-${id}`, campaign_id: 'camp-1', lead_id: id, status: 'completed', attempt_count: 2, next_eligible_at: '2026-10-07T00:00:00Z', final_disposition: 'X' });
  }
  t.calls.push({ id: 'call-1', lead_id: 'oncall', status: 'in_progress', organization_id: 'org-1' });
  return fake;
}

describe('resetLeads', () => {
  it('never resets Disconnected, Not in Service, Not Interested or DNC leads', () => {
    const base = { id: 'x', status: 'CONNECTED', is_dnc: false };
    expect(resetBlocker({ ...base, last_disposition: 'Voicemail' })).toBeNull();
    expect(resetBlocker({ ...base, last_disposition: 'Call Connected' })).toBeNull();
    expect(resetBlocker({ ...base, last_disposition: null })).toBeNull();
    expect(resetBlocker({ ...base, last_disposition: 'Disconnected' })).toBe('excluded_outcome');
    expect(resetBlocker({ ...base, last_disposition: 'Not in Service' })).toBe('excluded_outcome');
    expect(resetBlocker({ ...base, last_disposition: 'Not Interested' })).toBe('excluded_outcome');
    expect(resetBlocker({ ...base, last_disposition: 'DNC' })).toBe('excluded_outcome');
    expect(resetBlocker({ ...base, is_dnc: true, last_disposition: 'Voicemail' })).toBe('dnc');
  });

  it('makes allowed leads fresh in their campaigns and skips the rest', async () => {
    const fake = seed();
    const t = fake.tables as any;
    const ids = ['vm', 'connected', 'noanswer', 'disconnected', 'notinservice', 'notinterested', 'dnc', 'oncall', 'otherorg'];
    const result = await resetLeads(fake.supabase as any, 'org-1', ids);
    expect(result).toEqual({ reset: 3, skipped_excluded: 4, skipped_on_call: 1, campaign_entries_reset: 3 });

    const cl = (id: string) => t.campaign_leads.find((r: any) => r.lead_id === id);
    for (const id of ['vm', 'connected', 'noanswer']) {
      expect(cl(id)).toMatchObject({ status: 'pending', attempt_count: 0, next_eligible_at: null, final_disposition: null });
      expect(t.leads.find((l: any) => l.id === id).status).toBe('NEW');
      // Their last outcome stays on record.
      expect(t.leads.find((l: any) => l.id === id).last_disposition).not.toBeNull();
    }
    for (const id of ['disconnected', 'notinservice', 'notinterested', 'dnc', 'oncall', 'otherorg']) {
      expect(cl(id)).toMatchObject({ status: 'completed', attempt_count: 2 });
    }
  });

  it('leaves a lead mid-call in a campaign untouched', async () => {
    const fake = seed();
    const t = fake.tables as any;
    t.campaign_leads.find((r: any) => r.lead_id === 'vm').status = 'dialing';
    const result = await resetLeads(fake.supabase as any, 'org-1', ['vm']);
    expect(result.campaign_entries_reset).toBe(0);
    expect(t.campaign_leads.find((r: any) => r.lead_id === 'vm').status).toBe('dialing');
  });
});
