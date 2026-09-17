/**
 * Splits extracted document text into overlapping chunks sized for
 * embedding (per the task brief: ~500-800 tokens with overlap). Token
 * counts aren't measured exactly (no tokenizer dependency added for
 * this) - a simple, well-documented words-per-token approximation
 * (~0.75 words/token for English) is used instead, which keeps chunks in
 * the right ballpark without pulling in a tokenizer library.
 */

const WORDS_PER_TOKEN = 0.75;
const DEFAULT_TARGET_TOKENS = 650; // midpoint of the 500-800 token target
const DEFAULT_OVERLAP_TOKENS = 80;

export interface ChunkOptions {
  targetTokens?: number;
  overlapTokens?: number;
}

/** Splits `text` into word-count-bounded chunks with a trailing overlap
 * carried into the start of the next chunk, so context isn't lost at
 * chunk boundaries. Returns an empty array for blank input. */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens = options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;
  const targetWords = Math.max(1, Math.round(targetTokens * WORDS_PER_TOKEN));
  const overlapWords = Math.max(0, Math.round(overlapTokens * WORDS_PER_TOKEN));

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(words.length, start + targetWords);
    chunks.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;
    const nextStart = end - overlapWords;
    // Guard against overlap >= targetWords (or any other case that would
    // fail to move forward): always advance at least to the end of the
    // chunk just emitted rather than looping or walking backward.
    start = nextStart > start ? nextStart : end;
  }
  return chunks;
}
