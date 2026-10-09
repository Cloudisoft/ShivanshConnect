import { NEVER_RESET_OUTCOMES, type LeadResetResult } from '@shivanshconnect/shared';

/** Shown wherever leads can be reset for redial. */
export const RESET_EXCLUSION_NOTE = `Never reset: ${NEVER_RESET_OUTCOMES.join(', ')}, or a lead on a call right now.`;

/** One plain sentence on what a reset did. */
export function describeResetResult(result: Partial<LeadResetResult> & { affected?: number }): string {
  const reset = result.reset ?? result.affected ?? 0;
  const parts = [`${reset} lead(s) reset - they will be dialed again as fresh leads in their campaigns.`];
  if (result.skipped_excluded) parts.push(`${result.skipped_excluded} skipped (Disconnected, Not in Service, DNC or Not Interested).`);
  if (result.skipped_on_call) parts.push(`${result.skipped_on_call} skipped - on a call right now.`);
  return parts.join(' ');
}
