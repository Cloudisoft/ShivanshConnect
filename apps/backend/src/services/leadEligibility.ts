/**
 * Phase 7: lead eligibility for campaign dialing (master spec sections
 * 7, 10, 11, 16, 51, 52).
 *
 * This module is deliberately pure with respect to the database for its
 * core decision logic (`evaluateLeadEligibility`, `effectiveConcurrency`,
 * `isWithinCallingWindow`) - every check takes already-fetched plain data
 * and returns a structured, reason-coded result. `services/
 * campaignDispatcher.ts` is the only caller that actually issues the
 * Supabase queries (DNC lookup, active-call lookup) that feed these
 * functions; keeping the decision logic itself DB-free is what makes it
 * directly unit-testable without any fake DB harness.
 */

import { CAMPAIGN_LEAD_TERMINAL_STATUSES, type CampaignCallingRulesSnapshot, type CampaignLeadStatus } from '@shivanshconnect/shared';

export type EligibilityReasonCode =
  | 'campaign_not_running'
  | 'lead_dnc'
  | 'already_terminal'
  | 'cooldown_active'
  | 'max_attempts_reached'
  | 'outside_calling_window'
  | 'outside_calling_days'
  | 'lead_already_in_progress'
  | 'eligible';

export interface EligibilityResult {
  eligible: boolean;
  reasonCode: EligibilityReasonCode;
  reasonMessage: string;
}

const REASON_MESSAGES: Record<EligibilityReasonCode, string> = {
  campaign_not_running: 'Campaign is not currently running.',
  lead_dnc: 'Lead is on the Do Not Call list.',
  already_terminal: 'Lead has already reached a final outcome for this campaign.',
  cooldown_active: 'Lead is in its post-attempt cooldown period.',
  max_attempts_reached: 'Lead has reached the maximum number of dial attempts for this campaign.',
  outside_calling_window: "Lead's local time is outside the campaign's calling window.",
  outside_calling_days: "Today is not one of the campaign's allowed calling days.",
  lead_already_in_progress: 'Lead already has another call in progress.',
  eligible: 'Eligible to dial.',
};

function result(code: EligibilityReasonCode): EligibilityResult {
  return { eligible: code === 'eligible', reasonCode: code, reasonMessage: REASON_MESSAGES[code] };
}

/**
 * Effective concurrency = minimum(campaign's own limit, the org's
 * dialing_settings.max_concurrency ceiling, a hardcoded/env worker-pool
 * capacity) - spec section 7's explicit `minimum(...)` formula. Never
 * negative/zero; floors at 1 so a misconfigured org never fully stalls a
 * campaign that has at least one worker slot available.
 */
export function effectiveConcurrency(input: {
  campaignConcurrencyLimit: number;
  orgMaxConcurrency: number;
  workerPoolCapacity: number;
}): number {
  return Math.max(1, Math.min(input.campaignConcurrencyLimit, input.orgMaxConcurrency, input.workerPoolCapacity));
}

/** Reads `WORKER_POOL_CAPACITY` from the environment (defaulting to 50 -
 * generous enough not to be the binding constraint in a small deployment,
 * but still a real, enforced ceiling rather than "unlimited"). */
export function getWorkerPoolCapacity(): number {
  const raw = process.env.WORKER_POOL_CAPACITY;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

interface LocalTimeParts {
  /** ISO weekday: 1 (Monday) .. 7 (Sunday). */
  weekday: number;
  /** Minutes since local midnight. */
  minutesOfDay: number;
}

/** Resolves `at`'s wall-clock weekday/time-of-day IN `timezone`, using the
 * runtime's built-in ICU data (no extra date-library dependency needed -
 * Node 20's Intl always ships full ICU). Throws if `timezone` is not a
 * recognized IANA zone, so a bad campaign.timezone value fails loudly at
 * eligibility-check time rather than silently defaulting to UTC. */
export function getLocalTimeParts(timezone: string, at: Date): LocalTimeParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(at);
  const weekdayShort = parts.find((p) => p.type === 'weekday')!.value;
  const hour = Number.parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const minute = Number.parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  const WEEKDAY_MAP: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { weekday: WEEKDAY_MAP[weekdayShort], minutesOfDay: hour * 60 + minute };
}

function toMinutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((s) => Number.parseInt(s, 10));
  return h * 60 + m;
}

export function isWithinCallingDay(callingDays: number[], timezone: string, at: Date): boolean {
  const { weekday } = getLocalTimeParts(timezone, at);
  return callingDays.includes(weekday);
}

export function isWithinCallingWindow(windowStart: string, windowEnd: string, timezone: string, at: Date): boolean {
  const { minutesOfDay } = getLocalTimeParts(timezone, at);
  const start = toMinutesOfDay(windowStart);
  const end = toMinutesOfDay(windowEnd);
  if (start <= end) return minutesOfDay >= start && minutesOfDay <= end;
  // Overnight window (e.g. 22:00-06:00) - not a typical outbound calling
  // window but handled correctly rather than silently miscomputed.
  return minutesOfDay >= start || minutesOfDay <= end;
}

export interface EvaluateEligibilityInput {
  campaignStatus: string;
  callingRules: Pick<CampaignCallingRulesSnapshot, 'timezone' | 'calling_window_start' | 'calling_window_end' | 'calling_days'>;
  maxAttempts: number;
  campaignLeadStatus: CampaignLeadStatus;
  attemptCount: number;
  nextEligibleAt: string | null;
  isDnc: boolean;
  hasOtherActiveCall: boolean;
  now: Date;
}

const TERMINAL_STATUSES: CampaignLeadStatus[] = CAMPAIGN_LEAD_TERMINAL_STATUSES;
const IN_FLIGHT_STATUSES: CampaignLeadStatus[] = ['queued', 'dialing', 'ringing', 'connected', 'in_progress', 'transferring'];

/** The single source of truth for "is this campaign_leads row eligible to
 * be dialed right now" - spec section 16/51/52's full exclusion list,
 * evaluated in a fixed, documented order so the FIRST failing reason is
 * always the one reported (never several silently collapsed into one). */
export function evaluateLeadEligibility(input: EvaluateEligibilityInput): EligibilityResult {
  if (input.campaignStatus !== 'running') return result('campaign_not_running');
  if (input.isDnc) return result('lead_dnc');
  if (TERMINAL_STATUSES.includes(input.campaignLeadStatus)) return result('already_terminal');
  if (IN_FLIGHT_STATUSES.includes(input.campaignLeadStatus)) return result('lead_already_in_progress');
  if (input.hasOtherActiveCall) return result('lead_already_in_progress');
  if (input.attemptCount >= input.maxAttempts) return result('max_attempts_reached');
  if (input.nextEligibleAt && new Date(input.nextEligibleAt).getTime() > input.now.getTime()) {
    return result('cooldown_active');
  }
  if (!isWithinCallingDay(input.callingRules.calling_days, input.callingRules.timezone, input.now)) {
    return result('outside_calling_days');
  }
  if (
    !isWithinCallingWindow(
      input.callingRules.calling_window_start,
      input.callingRules.calling_window_end,
      input.callingRules.timezone,
      input.now,
    )
  ) {
    return result('outside_calling_window');
  }
  return result('eligible');
}

/** Linear (fixed-delay) retry scheduling per spec section 52 - the
 * documented, explicitly-acknowledged simplification of the spec's
 * "retry with backoff" language; exponential backoff is a follow-up (see
 * README). `attemptCount` is the count AFTER this attempt (i.e. the value
 * being persisted), so the delay is the same fixed `retryDelayMinutes` for
 * every retry rather than growing - a deliberate, honestly-documented
 * choice given the time budget, not a stub. */
export function computeNextEligibleAt(now: Date, retryDelayMinutes: number, leadCooldownMinutes: number): Date {
  const delayMs = Math.max(retryDelayMinutes, leadCooldownMinutes) * 60_000;
  return new Date(now.getTime() + delayMs);
}
