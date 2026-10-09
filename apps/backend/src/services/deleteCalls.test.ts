import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFakeSupabase } from '../test/fakeSupabase.js';

const fake = createFakeSupabase();
vi.mock('../lib/supabase.js', () => ({ getSupabaseAdmin: () => fake.supabase, getSupabaseAnon: () => fake.supabase }));

const { deleteCalls, callIdsMatchingFilters } = await import('./deleteCalls.js');

function addCall(orgId: string, status: string, extra: Record<string, unknown> = {}): string {
  const id = randomUUID();
  fake.tables.calls.push({ id, organization_id: orgId, status, direction: 'outbound', created_at: new Date().toISOString(), ...extra });
  return id;
}

describe('deleteCalls', () => {
  it('deletes ended calls, skips live ones, and never touches another organization', async () => {
    const org = randomUUID();
    const other = randomUUID();
    const ended = addCall(org, 'completed');
    const noAnswer = addCall(org, 'failed');
    const live = addCall(org, 'in_progress');
    const transferring = addCall(org, 'transferring');
    const foreign = addCall(other, 'completed');

    const result = await deleteCalls(fake.supabase as any, org, [ended, noAnswer, live, transferring, foreign, ended]);

    expect(result).toEqual({ deleted: 2, skipped_live: 2, not_found: 1 });
    const left = new Set(fake.tables.calls.map((c) => c.id));
    expect(left.has(ended)).toBe(false);
    expect(left.has(noAnswer)).toBe(false);
    expect(left.has(live)).toBe(true);
    expect(left.has(transferring)).toBe(true);
    expect(left.has(foreign)).toBe(true);
  });

  it('finds every call matching the filters, only in the organization', async () => {
    const org = randomUUID();
    const a = addCall(org, 'completed', { direction: 'inbound' });
    addCall(org, 'completed', { direction: 'outbound' });
    addCall(randomUUID(), 'completed', { direction: 'inbound' });

    expect(await callIdsMatchingFilters(fake.supabase as any, org, { direction: 'inbound' })).toEqual([a]);
  });
});
