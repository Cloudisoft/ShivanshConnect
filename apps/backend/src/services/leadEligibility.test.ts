import { describe, expect, it } from 'vitest';
import {
  computeNextEligibleAt,
  effectiveConcurrency,
  evaluateLeadEligibility,
  isWithinCallingDay,
  isWithinCallingWindow,
} from './leadEligibility.js';

const BASE_CALLING_RULES = {
  timezone: 'UTC',
  calling_window_start: '09:00',
  calling_window_end: '18:00',
  calling_days: [1, 2, 3, 4, 5],
};

function baseInput(overrides: Partial<Parameters<typeof evaluateLeadEligibility>[0]> = {}) {
  return {
    campaignStatus: 'running',
    callingRules: BASE_CALLING_RULES,
    maxAttempts: 3,
    campaignLeadStatus: 'pending' as const,
    attemptCount: 0,
    nextEligibleAt: null,
    isDnc: false,
    hasOtherActiveCall: false,
    // A Wednesday at noon UTC - always inside the base window/days.
    now: new Date('2024-01-03T12:00:00Z'),
    ...overrides,
  };
}

describe('effectiveConcurrency', () => {
  it('is the minimum of campaign, org, and worker-pool capacity', () => {
    expect(effectiveConcurrency({ campaignConcurrencyLimit: 50, orgMaxConcurrency: 25, workerPoolCapacity: 100 })).toBe(25);
    expect(effectiveConcurrency({ campaignConcurrencyLimit: 5, orgMaxConcurrency: 25, workerPoolCapacity: 100 })).toBe(5);
    expect(effectiveConcurrency({ campaignConcurrencyLimit: 50, orgMaxConcurrency: 25, workerPoolCapacity: 10 })).toBe(10);
  });

  it('never returns less than 1', () => {
    expect(effectiveConcurrency({ campaignConcurrencyLimit: 0, orgMaxConcurrency: 0, workerPoolCapacity: 0 })).toBe(1);
  });
});

describe('isWithinCallingDay / isWithinCallingWindow', () => {
  it('accepts a day in the allowed list, rejects one not in it', () => {
    const wednesday = new Date('2024-01-03T12:00:00Z'); // Wed
    const saturday = new Date('2024-01-06T12:00:00Z'); // Sat
    expect(isWithinCallingDay([1, 2, 3, 4, 5], 'UTC', wednesday)).toBe(true);
    expect(isWithinCallingDay([1, 2, 3, 4, 5], 'UTC', saturday)).toBe(false);
  });

  it('accepts a time inside the window, rejects one outside it', () => {
    expect(isWithinCallingWindow('09:00', '18:00', 'UTC', new Date('2024-01-03T12:00:00Z'))).toBe(true);
    expect(isWithinCallingWindow('09:00', '18:00', 'UTC', new Date('2024-01-03T20:00:00Z'))).toBe(false);
    expect(isWithinCallingWindow('09:00', '18:00', 'UTC', new Date('2024-01-03T06:00:00Z'))).toBe(false);
  });

  it('is timezone-aware, not UTC-blind', () => {
    // 20:00 UTC is 12:00 in America/Los_Angeles (PST, UTC-8) - inside a
    // 09:00-18:00 LOCAL window even though it's outside it in UTC.
    const at = new Date('2024-01-03T20:00:00Z');
    expect(isWithinCallingWindow('09:00', '18:00', 'UTC', at)).toBe(false);
    expect(isWithinCallingWindow('09:00', '18:00', 'America/Los_Angeles', at)).toBe(true);
  });
});

describe('evaluateLeadEligibility - every exclusion reason', () => {
  it('is eligible when every condition is satisfied', () => {
    expect(evaluateLeadEligibility(baseInput())).toEqual({ eligible: true, reasonCode: 'eligible', reasonMessage: 'Eligible to dial.' });
  });

  it('excludes when the campaign is not running', () => {
    const result = evaluateLeadEligibility(baseInput({ campaignStatus: 'paused' }));
    expect(result).toMatchObject({ eligible: false, reasonCode: 'campaign_not_running' });
  });

  it('excludes a DNC lead', () => {
    const result = evaluateLeadEligibility(baseInput({ isDnc: true }));
    expect(result).toMatchObject({ eligible: false, reasonCode: 'lead_dnc' });
  });

  it('excludes a lead already in a terminal campaign_leads status', () => {
    for (const status of ['completed', 'skipped', 'dnc', 'failed'] as const) {
      const result = evaluateLeadEligibility(baseInput({ campaignLeadStatus: status }));
      expect(result).toMatchObject({ eligible: false, reasonCode: 'already_terminal' });
    }
  });

  it('excludes a lead currently in flight in this campaign', () => {
    for (const status of ['queued', 'dialing', 'ringing', 'connected', 'in_progress', 'transferring'] as const) {
      const result = evaluateLeadEligibility(baseInput({ campaignLeadStatus: status }));
      expect(result).toMatchObject({ eligible: false, reasonCode: 'lead_already_in_progress' });
    }
  });

  it('excludes a lead with another active call elsewhere', () => {
    const result = evaluateLeadEligibility(baseInput({ hasOtherActiveCall: true }));
    expect(result).toMatchObject({ eligible: false, reasonCode: 'lead_already_in_progress' });
  });

  it('excludes a lead that has exhausted max attempts', () => {
    const result = evaluateLeadEligibility(baseInput({ attemptCount: 3, maxAttempts: 3 }));
    expect(result).toMatchObject({ eligible: false, reasonCode: 'max_attempts_reached' });
  });

  it('excludes a lead still in its cooldown window', () => {
    const future = new Date(baseInput().now.getTime() + 60_000).toISOString();
    const result = evaluateLeadEligibility(baseInput({ nextEligibleAt: future }));
    expect(result).toMatchObject({ eligible: false, reasonCode: 'cooldown_active' });
  });

  it('allows a lead whose cooldown has already passed', () => {
    const past = new Date(baseInput().now.getTime() - 60_000).toISOString();
    const result = evaluateLeadEligibility(baseInput({ nextEligibleAt: past }));
    expect(result).toMatchObject({ eligible: true });
  });

  it('excludes outside the allowed calling days', () => {
    const saturday = new Date('2024-01-06T12:00:00Z');
    const result = evaluateLeadEligibility(baseInput({ now: saturday }));
    expect(result).toMatchObject({ eligible: false, reasonCode: 'outside_calling_days' });
  });

  it('excludes outside the calling window', () => {
    const lateNight = new Date('2024-01-03T23:00:00Z');
    const result = evaluateLeadEligibility(baseInput({ now: lateNight }));
    expect(result).toMatchObject({ eligible: false, reasonCode: 'outside_calling_window' });
  });
});

describe('computeNextEligibleAt (retry/cooldown scheduling)', () => {
  it('adds the larger of retryDelayMinutes and leadCooldownMinutes', () => {
    const now = new Date('2024-01-03T12:00:00Z');
    expect(computeNextEligibleAt(now, 60, 30).toISOString()).toBe(new Date(now.getTime() + 60 * 60_000).toISOString());
    expect(computeNextEligibleAt(now, 15, 1440).toISOString()).toBe(new Date(now.getTime() + 1440 * 60_000).toISOString());
  });
});
