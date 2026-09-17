import { describe, expect, it } from 'vitest';
import { chunkText } from './chunking.js';

describe('chunkText', () => {
  it('returns an empty array for blank input', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   ')).toEqual([]);
  });

  it('returns a single chunk for short text', () => {
    const chunks = chunkText('hello world, this is a short document.');
    expect(chunks).toHaveLength(1);
  });

  it('splits long text into multiple overlapping chunks', () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
    const chunks = chunkText(words, { targetTokens: 650, overlapTokens: 80 });
    expect(chunks.length).toBeGreaterThan(1);

    // Every chunk after the first should share some trailing words with
    // the end of the previous chunk (the overlap).
    for (let i = 1; i < chunks.length; i += 1) {
      const prevWords = chunks[i - 1].split(' ');
      const currWords = chunks[i].split(' ');
      const overlapCandidate = prevWords[prevWords.length - 1];
      expect(currWords).toContain(overlapCandidate);
    }
  });

  it('covers the whole input without gaps', () => {
    const words = Array.from({ length: 500 }, (_, i) => `w${i}`);
    const chunks = chunkText(words.join(' '), { targetTokens: 100, overlapTokens: 10 });
    const rejoined = new Set(chunks.join(' ').split(' '));
    for (const w of words) expect(rejoined.has(w)).toBe(true);
  });

  it('never infinite-loops when overlap >= target', () => {
    const words = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkText(words, { targetTokens: 10, overlapTokens: 50 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(1000);
  });
});
