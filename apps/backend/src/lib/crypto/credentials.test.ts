import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  CredentialEncryptionNotConfiguredError,
  decryptCredentials,
  encryptCredentials,
  maskSecret,
} from './credentials.js';

const TEST_KEY = randomBytes(32).toString('hex');

describe('credential encryption', () => {
  it('round-trips a credential payload', () => {
    const payload = { api_key: 'sk-elevenlabs-test-123456789' };
    const envelope = encryptCredentials(payload, TEST_KEY);
    expect(envelope.ciphertext).not.toContain('sk-elevenlabs');
    const decrypted = decryptCredentials<typeof payload>(envelope, TEST_KEY);
    expect(decrypted).toEqual(payload);
  });

  it('produces a different ciphertext/iv each time (random IV)', () => {
    const payload = { api_key: 'same-secret' };
    const a = encryptCredentials(payload, TEST_KEY);
    const b = encryptCredentials(payload, TEST_KEY);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('throws when the encryption key is not configured', () => {
    expect(() => encryptCredentials({ a: 1 }, undefined)).toThrow(CredentialEncryptionNotConfiguredError);
  });

  it('throws CredentialEncryptionNotConfiguredError for a malformed key (not 32 bytes)', () => {
    expect(() => encryptCredentials({ a: 1 }, 'too-short')).toThrow(CredentialEncryptionNotConfiguredError);
  });

  it('rejects tampered ciphertext on decrypt (auth tag mismatch)', () => {
    const envelope = encryptCredentials({ api_key: 'secret' }, TEST_KEY);
    const tampered = { ...envelope, ciphertext: Buffer.from('tampered-data').toString('base64') };
    expect(() => decryptCredentials(tampered, TEST_KEY)).toThrow();
  });

  it('accepts a base64-encoded 32-byte key as well as hex', () => {
    const base64Key = randomBytes(32).toString('base64');
    const envelope = encryptCredentials({ x: 'y' }, base64Key);
    expect(decryptCredentials(envelope, base64Key)).toEqual({ x: 'y' });
  });
});

describe('maskSecret', () => {
  it('keeps a short prefix/suffix and hides the middle', () => {
    const masked = maskSecret('sk-live-abc123xyz9999');
    expect(masked.startsWith('sk-l')).toBe(true);
    expect(masked.endsWith('9999')).toBe(true);
    expect(masked).not.toContain('abc123xyz');
  });

  it('fully masks very short secrets rather than leaking them', () => {
    expect(maskSecret('ab')).toBe('••••');
  });
});
