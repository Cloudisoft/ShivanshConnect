/**
 * Local presence dialing, per request: "if it's 203, the call should go
 * from a 203 number". A campaign dials from a pool of numbers; for each
 * lead the caller ID is a pool number with the lead's own area code when
 * the pool has one, rotating among those matches. With no match the call
 * uses the campaign's normal round-robin rotation.
 */

/** The 3-digit area code of a North American (+1) number, else null. */
export function areaCodeOf(e164: string | null | undefined): string | null {
  const digits = (e164 ?? '').replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length === 10 ? digits : null;
  return national ? national.slice(0, 3) : null;
}

export interface PoolNumber {
  phone_number: string;
  [key: string]: unknown;
}

/** Picks the caller ID for one call. `cursors` holds a round-robin position
 * per key (the campaign, and the campaign + area code). */
export function pickCallerNumber<T extends PoolNumber>(
  campaignId: string,
  pool: T[],
  customerE164: string | null | undefined,
  cursors: Map<string, number>,
): T | null {
  if (pool.length === 0) return null;
  const areaCode = areaCodeOf(customerE164);
  const local = areaCode ? pool.filter((n) => areaCodeOf(n.phone_number) === areaCode) : [];
  const [candidates, key] = local.length > 0 ? [local, `${campaignId}:${areaCode}`] : [pool, campaignId];
  const cursor = cursors.get(key) ?? 0;
  cursors.set(key, cursor + 1);
  return candidates[cursor % candidates.length] ?? null;
}
