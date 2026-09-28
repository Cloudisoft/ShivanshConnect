/**
 * Last-seen copies of a few read-only screens (the dashboard) kept in
 * localStorage, so right after sign-in or a reload the page paints the
 * last numbers instantly and refreshes them in the background instead of
 * showing a spinner. Scoped to the signed-in user who saw them - another
 * account on the same browser never reads them - and kept across sign-out
 * so the first screen after the next login is instant too.
 */
const PREFIX = 'sc:q:';

export function readPersisted<T>(key: string, ownerId: string | undefined): T | undefined {
  if (!ownerId) return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { ownerId: string; data: T };
    return parsed.ownerId === ownerId ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writePersisted<T>(key: string, ownerId: string | undefined, data: T): void {
  if (!ownerId) return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ ownerId, data }));
  } catch {
    // storage full/blocked - the page just loads normally
  }
}

export function clearPersisted(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // ignore
  }
}
