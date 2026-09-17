/**
 * Phase 10: short-lived, scoped tokens for pipecat-service's supervisor
 * WebSocket endpoints (audio-tap for listen/barge, control for whisper -
 * see apps/pipecat-service/app/supervisor.py). pipecat-service has no
 * per-org credential store of its own (see lib/orchestration/pipecat.ts's
 * header comment on why) - the only secret it already shares with this
 * backend is PIPECAT_SERVICE_TOKEN (the same bearer token used to
 * authenticate Node -> pipecat-service REST calls and pipecat-service ->
 * Node webhook deliveries). Reusing THAT as an HMAC key here, rather than
 * minting yet another shared secret, keeps this to a single credential to
 * rotate and means a browser client is only ever handed a signed,
 * expiring, call-and-action-scoped token - never the raw bearer token
 * itself.
 *
 * Token shape: `${base64url(payload_json)}.${base64url(hmac_sha256)}`.
 * Verified byte-for-byte the same way in
 * apps/pipecat-service/app/supervisor_auth.py - keep the two in sync if
 * this ever changes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SupervisorTokenAction = 'listen' | 'whisper' | 'barge';

export interface SupervisorTokenPayload {
  pipecat_call_id: string;
  action: SupervisorTokenAction;
  organization_id: string;
  exp: number; // unix seconds
}

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function requireSecret(): string {
  const secret = process.env.PIPECAT_SERVICE_TOKEN;
  if (!secret) {
    throw new Error('PIPECAT_SERVICE_TOKEN must be set to mint pipecat-service supervisor tokens.');
  }
  return secret;
}

/** Mints a token valid for `ttlSeconds` (default 5 minutes - long enough
 * for a supervisor to open the audio connection, short enough that a
 * leaked URL stops working quickly). */
export function signSupervisorToken(payload: Omit<SupervisorTokenPayload, 'exp'>, ttlSeconds = 300): string {
  const secret = requireSecret();
  const full: SupervisorTokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(full)));
  const sig = createHmac('sha256', secret).update(payloadB64).digest();
  return `${payloadB64}.${base64url(sig)}`;
}

/** Verifies a token this module minted - used only by tests here (the
 * real verification for an inbound WS connection happens on the Python
 * side, see this file's header comment). Exported so a unit test can
 * assert round-trip correctness and tamper-rejection without spinning up
 * pipecat-service. */
export function verifySupervisorToken(token: string): SupervisorTokenPayload | null {
  const secret = requireSecret();
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  const expectedSig = base64url(createHmac('sha256', secret).update(payloadB64).digest());
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as SupervisorTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
