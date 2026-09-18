import { afterEach, describe, expect, it, vi } from 'vitest';
import { encryptCredentials } from '../lib/crypto/credentials.js';
import { __setSmtpTransportForTests, humanizeSmtpError, sendEmail, sendTestEmail, SmtpSendError, type SmtpSettingsRow } from './smtpProvider.js';

const TEST_KEY = '0'.repeat(64);

function settingsRow(): SmtpSettingsRow {
  return {
    host: 'smtp.example.com',
    port: 587,
    username: 'user@example.com',
    encrypted_password: encryptCredentials({ password: 'hunter2' }, TEST_KEY),
    encryption: 'tls',
    from_name: 'Acme',
    from_email: 'noreply@acme.com',
  };
}

describe('smtpProvider', () => {
  afterEach(() => __setSmtpTransportForTests(null));

  it('sendEmail succeeds via a mocked nodemailer transport and never logs the decrypted password', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'msg-1' });
    __setSmtpTransportForTests({ sendMail } as any);

    const result = await sendEmail(settingsRow(), { to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>' }, TEST_KEY);

    expect(result).toEqual({ messageId: 'msg-1' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: '"Acme" <noreply@acme.com>', to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>' }),
    );
    // Never passes the plaintext password to sendMail's own args.
    expect(JSON.stringify(sendMail.mock.calls[0][0])).not.toContain('hunter2');
  });

  it('sendEmail throws SmtpSendError with a humanized message on a real nodemailer auth failure', async () => {
    const authError = Object.assign(new Error('Invalid login: 535 Authentication failed'), { code: 'EAUTH' });
    const sendMail = vi.fn().mockRejectedValue(authError);
    __setSmtpTransportForTests({ sendMail } as any);

    await expect(sendEmail(settingsRow(), { to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>' }, TEST_KEY)).rejects.toBeInstanceOf(SmtpSendError);
    try {
      await sendEmail(settingsRow(), { to: 'a@b.com', subject: 'Hi', html: '<p>hi</p>' }, TEST_KEY);
    } catch (err) {
      expect((err as Error).message).toMatch(/rejected the username\/password/i);
    }
  });

  it('sendTestEmail sends through the exact same code path as a real send (no special-cased test mode)', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'test-1' });
    __setSmtpTransportForTests({ sendMail } as any);
    const result = await sendTestEmail(settingsRow(), 'someone@example.com', TEST_KEY);
    expect(result).toEqual({ messageId: 'test-1' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'someone@example.com' }));
  });

  it('humanizeSmtpError maps connection/timeout errors to a readable message', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(humanizeSmtpError(err)).toMatch(/could not reach the smtp server/i);
  });
});
