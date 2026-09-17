/**
 * Email sending abstraction. Phase 1 ships a console-log implementation
 * only - the real SMTP-backed implementation is Phase 13 per the master
 * spec's phase plan. Callers depend on this interface, not on any
 * concrete transport, so swapping in SMTP later is a one-line change in
 * `getEmailService()` and nothing else in the codebase.
 */
export interface EmailService {
  sendInvitationEmail(input: {
    to: string;
    organizationName: string;
    inviteUrl: string;
    invitedByName: string;
  }): Promise<void>;

  sendPasswordResetEmail(input: { to: string; resetUrl: string }): Promise<void>;
}

class ConsoleEmailService implements EmailService {
  async sendInvitationEmail(input: {
    to: string;
    organizationName: string;
    inviteUrl: string;
    invitedByName: string;
  }): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      `[email:stub] Invitation for ${input.to} to join "${input.organizationName}" ` +
        `(invited by ${input.invitedByName}): ${input.inviteUrl}`,
    );
  }

  async sendPasswordResetEmail(input: { to: string; resetUrl: string }): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`[email:stub] Password reset for ${input.to}: ${input.resetUrl}`);
  }
}

let service: EmailService | null = null;

export function getEmailService(): EmailService {
  if (!service) service = new ConsoleEmailService();
  return service;
}
