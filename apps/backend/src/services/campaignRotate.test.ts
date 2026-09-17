import { describe, expect, it } from 'vitest';
import { decideRotation } from './campaignRotate.js';

describe('decideRotation - rotate/reuse filter', () => {
  it('excludes leads whose last outcome was a permanent disposition', () => {
    const rows = [
      { id: 'cl1', lead_id: 'l1', status: 'completed' as const, final_disposition: 'transferred' },
      { id: 'cl2', lead_id: 'l2', status: 'dnc' as const, final_disposition: 'dnc' },
      { id: 'cl3', lead_id: 'l3', status: 'completed' as const, final_disposition: 'not-interested' },
      { id: 'cl4', lead_id: 'l4', status: 'completed' as const, final_disposition: 'hung-up' },
      { id: 'cl5', lead_id: 'l5', status: 'completed' as const, final_disposition: 'disconnected' },
      { id: 'cl6', lead_id: 'l6', status: 'completed' as const, final_disposition: null },
    ];
    const decisions = decideRotation(rows);
    expect(decisions.every((d) => !d.include)).toBe(true);
  });

  it('includes never-attempted and retryable-outcome leads', () => {
    const rows = [
      { id: 'cl1', lead_id: 'l1', status: 'pending' as const, final_disposition: null },
      { id: 'cl2', lead_id: 'l2', status: 'retry_pending' as const, final_disposition: 'no-answer' },
      { id: 'cl3', lead_id: 'l3', status: 'failed' as const, final_disposition: 'busy' },
      { id: 'cl4', lead_id: 'l4', status: 'skipped' as const, final_disposition: 'outside_calling_window' },
    ];
    const decisions = decideRotation(rows);
    expect(decisions.every((d) => d.include)).toBe(true);
  });

  it('never rotates a lead currently mid-call', () => {
    const rows = [{ id: 'cl1', lead_id: 'l1', status: 'in_progress' as const, final_disposition: null }];
    const decisions = decideRotation(rows);
    expect(decisions[0].include).toBe(false);
  });

  it('produces exactly one decision per input row, each carrying its lead id', () => {
    const rows = [
      { id: 'cl1', lead_id: 'l1', status: 'pending' as const, final_disposition: null },
      { id: 'cl2', lead_id: 'l2', status: 'completed' as const, final_disposition: 'transferred' },
    ];
    const decisions = decideRotation(rows);
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.leadId)).toEqual(['l1', 'l2']);
  });
});
