/**
 * Phase 4: encrypted credential storage helper.
 *
 * No such helper existed in Phases 1-3 (nothing needed to store a
 * provider secret at rest until now), so this is built fresh here - it
 * is the pattern Phase 5 (Twilio/Telnyx), Phase 6 (Vapi) and Phase 13
 * (SMTP) are expected to reuse rather than each rolling their own.
 *
 * AES-256-GCM via Node's built-in `crypto` module (no extra dependency).
 * CREDENTIAL_ENCRYPTION_KEY must be a 32-byte key, provided as either a
 * 64-char hex string or a base64 string that decodes to 32 bytes. Each
 * encryption call generates a fresh random IV; the auth tag is stored
 * alongside the ciphertext so tampering is detected on decrypt.
 *
 * The encrypted envelope ({ iv, authTag, ciphertext }, all base64) is
 * what actually gets stored in voice_provider_credentials.encrypted_
 * credentials - never plaintext, and application code must never select
 * this column back to the frontend (see routes/voiceProviders.ts, which
 * only ever returns a masked preview it derives after decrypting
 * server-side).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended for GCM

export class CredentialEncryptionNotConfiguredError extends Error {
  constructor(message = 'CREDENTIAL_ENCRYPTION_KEY is not configured. Set it in the backend environment to store provider credentials.') {
    super(message);
    this.name = 'CredentialEncryptionNotConfiguredError';
  }
}

export interface EncryptedEnvelope {
  iv: string;
  authTag: string;
  ciphertext: string;
}

function resolveKey(rawKey: string | undefined = process.env.CREDENTIAL_ENCRYPTION_KEY): Buffer {
  if (!rawKey || rawKey.trim().length === 0) {
    throw new CredentialEncryptionNotConfiguredError();
  }
  const trimmed = rawKey.trim();

  // 64 hex chars = 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  // Otherwise expect base64 decoding to exactly 32 bytes.
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === 32) {
    return decoded;
  }

  throw new CredentialEncryptionNotConfiguredError(
    'CREDENTIAL_ENCRYPTION_KEY must be a 32-byte key: either 64 hex characters or base64 that decodes to 32 bytes.',
  );
}

/** Encrypts an arbitrary JSON-serializable credential payload. */
export function encryptCredentials(payload: Record<string, unknown>, key?: string): EncryptedEnvelope {
  const keyBuffer = resolveKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Decrypts an envelope previously produced by encryptCredentials. Throws
 * on any tampering (auth tag mismatch) or malformed envelope. */
export function decryptCredentials<T = Record<string, unknown>>(envelope: EncryptedEnvelope, key?: string): T {
  const keyBuffer = resolveKey(key);
  const iv = Buffer.from(envelope.iv, 'base64');
  const authTag = Buffer.from(envelope.authTag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');

  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/** Masks a secret for display: keeps a short prefix/suffix, replaces the
 * middle with bullets - e.g. "sk-live-abc123xyz" -> "sk-l...3xyz". Never
 * returns enough of the original secret to reconstruct it. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '•'.repeat(Math.max(secret.length, 4));
  return `${secret.slice(0, 4)}${'•'.repeat(6)}${secret.slice(-4)}`;
}
