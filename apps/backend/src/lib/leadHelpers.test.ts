import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: mocks.from }),
}));

import {
  findDncMatches,
  findExistingLeadPhones,
  flagExistingLeadsAsDnc,
  isOnDncList,
} from './leadHelpers.js';

function makeQuery(result: { data: any; error: any }) {
  const query: any = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.update = vi.fn(() => query);
  query.then = (resolve: any) => resolve(result);
  return query;
}

describe('isOnDncList', () => {
  beforeEach(() => { mocks.from.mockReset(); });

  it('is true for an org-scoped DNC match', async () => {
    mocks.from.mockImplementation(() =>
      makeQuery({ data: [{ id: '1', organization_id: 'org1' }], error: null }),
    );
    expect(await isOnDncList({ from: mocks.from } as any, 'org1', '+14845551234')).toBe(true);
  });

  it('is true for a global (organization_id null) DNC match', async () => {
    mocks.from.mockImplementation(() => makeQuery({ data: [{ id: '1', organization_id: null }], error: null }));
    expect(await isOnDncList({ from: mocks.from } as any, 'org1', '+14845551234')).toBe(true);
  });

  it('is false when the DNC entry belongs to a different org', async () => {
    mocks.from.mockImplementation(() =>
      makeQuery({ data: [{ id: '1', organization_id: 'org2' }], error: null }),
    );
    expect(await isOnDncList({ from: mocks.from } as any, 'org1', '+14845551234')).toBe(false);
  });

  it('is false when there is no matching row', async () => {
    mocks.from.mockImplementation(() => makeQuery({ data: [], error: null }));
    expect(await isOnDncList({ from: mocks.from } as any, 'org1', '+14845551234')).toBe(false);
  });
});

describe('findDncMatches', () => {
  beforeEach(() => { mocks.from.mockReset(); });

  it('returns only the phones that are actually suppressed for this org', async () => {
    mocks.from.mockImplementation(() =>
      makeQuery({
        data: [
          { phone_normalized: '+14845551111', organization_id: 'org1' },
          { phone_normalized: '+14845552222', organization_id: 'org2' },
          { phone_normalized: '+14845553333', organization_id: null },
        ],
        error: null,
      }),
    );
    const matches = await findDncMatches({ from: mocks.from } as any, 'org1', ['+14845551111', '+14845552222', '+14845553333']);
    expect(matches.has('+14845551111')).toBe(true);
    expect(matches.has('+14845552222')).toBe(false);
    expect(matches.has('+14845553333')).toBe(true);
  });

  it('returns an empty set without querying for an empty input', async () => {
    const matches = await findDncMatches({ from: mocks.from } as any, 'org1', []);
    expect(matches.size).toBe(0);
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe('findExistingLeadPhones', () => {
  beforeEach(() => { mocks.from.mockReset(); });

  it('returns the set of phones already present for the org', async () => {
    mocks.from.mockImplementation(() =>
      makeQuery({ data: [{ phone_normalized: '+14845551111' }], error: null }),
    );
    const existing = await findExistingLeadPhones({ from: mocks.from } as any, 'org1', ['+14845551111', '+14845552222']);
    expect(existing.has('+14845551111')).toBe(true);
    expect(existing.has('+14845552222')).toBe(false);
  });
});

describe('flagExistingLeadsAsDnc', () => {
  beforeEach(() => { mocks.from.mockReset(); });

  it('flags matching leads and returns how many were affected', async () => {
    mocks.from.mockImplementation(() => makeQuery({ data: [{ id: 'lead1' }, { id: 'lead2' }], error: null }));
    const count = await flagExistingLeadsAsDnc({ from: mocks.from } as any, 'org1', '+14845551234', 'Caller requested');
    expect(count).toBe(2);
  });
});
