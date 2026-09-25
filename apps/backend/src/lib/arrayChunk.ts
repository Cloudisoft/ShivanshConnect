/** Splits `items` into fixed-size groups, preserving order. Used to keep
 * Supabase `.in(column, [...])` filters under PostgREST's real URL/
 * header-size limit - a real production incident (HeadersOverflowError,
 * a 17000+ character request URL from an unbatched .in() call against a
 * large lead list) is exactly what this exists to prevent everywhere
 * such a filter is built from a caller-supplied or DB-fetched id list. */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
