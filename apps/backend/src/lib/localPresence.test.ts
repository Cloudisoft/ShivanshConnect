import { describe, expect, it } from 'vitest';
import { areaCodeOf, pickCallerNumber } from './localPresence.js';

const pool = [
  { id: 'a', phone_number: '+12035550100' },
  { id: 'b', phone_number: '+16175550100' },
  { id: 'c', phone_number: '+12035550199' },
  { id: 'd', phone_number: '+15595550100' },
];

describe('localPresence', () => {
  it('reads the area code of a +1 number however it is written', () => {
    expect(areaCodeOf('+12035551234')).toBe('203');
    expect(areaCodeOf('12035551234')).toBe('203');
    expect(areaCodeOf('(203) 555-1234')).toBe('203');
    expect(areaCodeOf('+442071234567')).toBeNull();
    expect(areaCodeOf(null)).toBeNull();
  });

  it('calls a 203 lead from a 203 number, rotating among the 203 numbers', () => {
    const cursors = new Map<string, number>();
    const picks = [1, 2, 3].map(() => pickCallerNumber('camp', pool, '+12039991111', cursors)?.id);
    expect(picks).toEqual(['a', 'c', 'a']);
  });

  it('falls back to the normal rotation when no number has the lead\'s area code', () => {
    const cursors = new Map<string, number>();
    const picks = [1, 2, 3, 4, 5].map(() => pickCallerNumber('camp', pool, '+13125550000', cursors)?.id);
    expect(picks).toEqual(['a', 'b', 'c', 'd', 'a']);
  });

  it('keeps the fallback rotation separate from the local matches', () => {
    const cursors = new Map<string, number>();
    expect(pickCallerNumber('camp', pool, '+16175550000', cursors)?.id).toBe('b');
    expect(pickCallerNumber('camp', pool, '+13125550000', cursors)?.id).toBe('a');
    expect(pickCallerNumber('camp', pool, '+13125550000', cursors)?.id).toBe('b');
  });

  it('returns null for an empty pool', () => {
    expect(pickCallerNumber('camp', [], '+12035550000', new Map())).toBeNull();
  });
});
