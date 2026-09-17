import { describe, expect, it } from 'vitest';
import { resolveLeadIds } from './leads.js';

/**
 * Unit test for the "select all matching filter" bulk-action pattern:
 * resolveLeadIds must page through matches in bounded batches (never
 * loading every lead row into memory) and must return literal ids when
 * the caller already supplied them.
 */

function makeFakeSupabase(allRows: { id: string; organization_id: string; status?: string }[]) {
  return {
    from: (_table: string) => {
      const filters: Record<string, unknown> = {};
      const query: any = {
        eq(field: string, value: unknown) {
          filters[field] = value;
          return query;
        },
        or() {
          return query;
        },
        select() {
          return query;
        },
        order() {
          return query;
        },
        range(from: number, to: number) {
          let rows = allRows.filter((r) =>
            Object.entries(filters).every(([f, v]) => (r as any)[f] === v),
          );
          rows = rows.slice(from, to + 1);
          return Promise.resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
        },
      };
      return query;
    },
  };
}

describe('resolveLeadIds', () => {
  it('returns the explicit id array unchanged when one is provided', async () => {
    const ids = await resolveLeadIds({} as any, 'org1', { lead_ids: ['a', 'b', 'c'] });
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('resolves every id matching a filter, across pages, without the caller enumerating them', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `lead-${i}`, organization_id: 'org1', status: 'NEW' }));
    const fake = makeFakeSupabase(rows);

    const ids = await resolveLeadIds(fake as any, 'org1', { filter: { status: 'NEW' } });
    expect(ids).toHaveLength(2500);
    expect(new Set(ids).size).toBe(2500);
  });

  it('never returns leads belonging to another organization', async () => {
    const rows = [
      { id: 'a', organization_id: 'org1' },
      { id: 'b', organization_id: 'org2' },
    ];
    const fake = makeFakeSupabase(rows);
    const ids = await resolveLeadIds(fake as any, 'org1', { filter: {} });
    expect(ids).toEqual(['a']);
  });
});
