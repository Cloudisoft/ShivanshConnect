/**
 * The call engine's vendor name is never shown on the dashboard - it reads
 * "AI orchestration" instead. Server messages, stored error reasons and
 * provider errors can still carry it (the integration itself is unchanged),
 * so text from the server passes through this before it is shown.
 */
export function hideVendorName<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  return text
    .replace(/https?:\/\/[^\s)]*vapi\.ai[^\s)]*/gi, 'the AI orchestration dashboard')
    .replace(/\bvapi\b/gi, 'AI orchestration') as T;
}
