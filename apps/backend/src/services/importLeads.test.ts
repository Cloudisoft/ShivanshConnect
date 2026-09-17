import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));

vi.mock('../lib/supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: mocks.from }),
}));

import { inferColumnMapping, validateRows } from './importLeads.js';

describe('inferColumnMapping', () => {
  it('maps common header aliases to lead fields', () => {
    const mapping = inferColumnMapping(
      ['First Name', 'Last Name', 'Phone Number', 'E-mail', 'Company Name'],
      [],
    );
    expect(mapping['First Name']).toBe('first_name');
    expect(mapping['Last Name']).toBe('last_name');
    expect(mapping['Phone Number']).toBe('phone');
    expect(mapping['E-mail']).toBe('email');
    expect(mapping['Company Name']).toBe('company');
  });

  it('maps a header to a known org custom field', () => {
    const mapping = inferColumnMapping(
      ['Lead Source'],
      [{ field_key: 'lead_source', field_label: 'Lead Source' }],
    );
    expect(mapping['Lead Source']).toBe('custom:lead_source');
  });

  it('leaves unrecognized headers unmapped', () => {
    const mapping = inferColumnMapping(['Some Random Column'], []);
    expect(mapping['Some Random Column']).toBeUndefined();
  });
});

function makeSelectQuery(data: any[]) {
  const query: any = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.in = vi.fn(() => query);
  query.then = (resolve: any) => resolve({ data, error: null });
  return query;
}

describe('validateRows', () => {
  beforeEach(() => { mocks.from.mockReset(); });

  it('classifies invalid / duplicate-in-file / DNC / valid rows correctly', async () => {
    mocks.from.mockImplementation((table: string) => {
      if (table === 'leads') return makeSelectQuery([{ phone_normalized: '+14845550001' }]); // pre-existing
      if (table === 'dnc_entries') {
        return makeSelectQuery([{ phone_normalized: '+14845559999', organization_id: 'org1' }]);
      }
      throw new Error(`unexpected table ${table}`);
    });

    const rows = [
      { name: 'A', phone: '484-555-0002' }, // valid
      { name: 'B', phone: '484-555-0002' }, // duplicate within file
      { name: 'C', phone: '484-555-0001' }, // duplicate of existing lead
      { name: 'D', phone: '12345' }, // invalid
      { name: 'E', phone: '484-555-9999' }, // DNC
    ];
    const mapping = { phone: 'phone', name: 'first_name' };

    const outcomes = await validateRows('org1', rows, mapping);
    expect(outcomes.map((o) => o.result)).toEqual(['valid', 'duplicate', 'duplicate', 'invalid', 'dnc']);
    expect(outcomes[0].phone_normalized).toBe('+14845550002');
    expect(outcomes[0].mapped).toMatchObject({ phone_normalized: '+14845550002', first_name: 'A' });
    expect(outcomes[3].error_message).toBeTruthy();
  });

  it('flags a row with a missing phone value as invalid without normalizing', async () => {
    mocks.from.mockImplementation(() => makeSelectQuery([]));
    const outcomes = await validateRows('org1', [{ phone: '' }], { phone: 'phone' });
    expect(outcomes[0].result).toBe('invalid');
    expect(outcomes[0].mapped).toBeNull();
  });
});
