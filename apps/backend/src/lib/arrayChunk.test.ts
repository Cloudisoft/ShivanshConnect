import { describe, expect, it } from 'vitest';
import { chunkArray } from './arrayChunk.js';

describe('chunkArray', () => {
  it('splits into fixed-size groups, preserving order', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single chunk when items fit within the size', () => {
    expect(chunkArray([1, 2, 3], 200)).toEqual([[1, 2, 3]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunkArray([], 200)).toEqual([]);
  });

  it('never produces a chunk larger than the requested size - the real guarantee this exists to enforce for Supabase .in() filters', () => {
    const items = Array.from({ length: 987 }, (_, i) => i);
    const chunks = chunkArray(items, 200);
    expect(chunks).toHaveLength(5); // 200*4 + 187
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200);
    expect(chunks.flat()).toEqual(items);
  });
});
