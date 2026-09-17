import { useEffect, useState } from 'react';

/** Re-renders every `intervalMs` with the current time - the one bit of
 * "polling" this module legitimately needs, since it drives a purely
 * client-side ticking duration display (Active calls table's Duration
 * column), never a data fetch. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
