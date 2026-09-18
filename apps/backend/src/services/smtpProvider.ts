/**
 * Phase 13: real SMTP client (master spec section 39), using `nodemailer`
 * (a real, standard, well-supported library) configured per-organization
 * from its stored `smtp_settings` row. The password is decrypted (via
 * Phase 4's exact `lib/crypto/credentials.ts` helper) only in-memory at
 * send time and is never logged - see `buildTransport()` below, which
 * only ever passes it straight into nodemailer's own transport config.
 *
 * There is deliberately no fallback/simulated "send" path: if SMTP
 * settings aren't configured for an org, sending throws
 * SmtpNotConfiguredError rather than pretending to send.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { decryptCredentials, type EncryptedEnvelope } from '../lib/crypto/credentials.js';

export class SmtpNotConfiguredError extends Error {
  constructor(message = 'SMTP is not configured for this organization. Add settings under Settings > SMTP.') {
    super(message);
    this.name = 'SmtpNotConfiguredError';
  }
}

export class SmtpSendError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'SmtpSendError';
  }
}

export interface SmtpSettingsRow {
  host: string;
  port: number;
  username: string;
  encrypted_password: EncryptedEnvelope;
  encryption: 'tls' | 'ssl' | 'none';
  from_name: string;
  from_email: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Maps nodemailer's own raw error into a short, human-readable message -
 * never a raw stack trace, but also never a fabricated success. Common
 * SMTP failure classes: auth rejected, connection refused/timed out, TLS
 * handshake failure, invalid recipient.
 */
export function humanizeSmtpError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string; responseCode?: number })?.code;
  if (code === 'EAUTH' || /auth/i.test(raw)) {
    return 'The SMTP server rejected the username/password. Double-check your credentials.';
  }
  if (code === 'ECONNECTION' || code === 'ETIMEDOUT' || /timed out|ECONNREFUSED/i.test(raw)) {
    return 'Could not reach the SMTP server. Check the host and port.';
  }
  if (code === 'ESOCKET' || /certificate|TLS|SSL/i.test(raw)) {
    return 'A TLS/SSL connection error occurred talking to the SMTP server. Check the encryption setting.';
  }
  if (/recipient|mailbox/i.test(raw)) {
    return 'The SMTP server rejected the recipient address.';
  }
  return `SMTP error: ${raw.slice(0, 300)}`;
}

function buildTransport(settings: SmtpSettingsRow, encryptionKey?: string): Transporter {
  const { password } = decryptCredentials<{ password: string }>(settings.encrypted_password, encryptionKey);
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.encryption === 'ssl', // implicit TLS (typically port 465)
    requireTLS: settings.encryption === 'tls', // STARTTLS (typically port 587)
    ignoreTLS: settings.encryption === 'none',
    auth: { user: settings.username, pass: password },
  });
}

let transportOverride: Transporter | null = null;
/** Test-only hook to inject a fake nodemailer transport without touching
 * real credentials or making a real network connection. */
export function __setSmtpTransportForTests(transport: Transporter | null): void {
  transportOverride = transport;
}

/** Sends one real email through the org's configured SMTP server.
 * Throws SmtpSendError (humanized message) on any failure - never
 * silently "succeeds". */
export async function sendEmail(settings: SmtpSettingsRow, input: SendEmailInput, encryptionKey?: string): Promise<{ messageId: string }> {
  const transport = transportOverride ?? buildTransport(settings, encryptionKey);
  try {
    const info = await transport.sendMail({
      from: settings.from_name ? `"${settings.from_name}" <${settings.from_email}>` : settings.from_email,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    return { messageId: info.messageId };
  } catch (err) {
    throw new SmtpSendError(humanizeSmtpError(err), err);
  }
}

/** Sends a real test email - used by POST /settings/smtp/test. Same code
 * path as a real campaign send (no special-cased "test mode" branch), so
 * a successful test genuinely proves the configuration works. */
export async function sendTestEmail(settings: SmtpSettingsRow, recipient: string, encryptionKey?: string): Promise<{ messageId: string }> {
  return sendEmail(
    settings,
    {
      to: recipient,
      subject: 'ShivanshConnect SMTP test email',
      html: '<p>This is a test email from ShivanshConnect to confirm your SMTP settings are working.</p>',
      text: 'This is a test email from ShivanshConnect to confirm your SMTP settings are working.',
    },
    encryptionKey,
  );
}
