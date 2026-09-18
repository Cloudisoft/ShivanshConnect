/**
 * Phase 13: SMTP settings, SMS campaigns/messages, email campaigns/
 * messages (master spec sections 38, 39, 40, 41). See
 * supabase/migrations/00000000000045-47 for the schema these mirror.
 */

export const SMTP_ENCRYPTIONS = ['tls', 'ssl', 'none'] as const;
export type SmtpEncryption = (typeof SMTP_ENCRYPTIONS)[number];

export const SMTP_STATUSES = ['not_configured', 'connected', 'error'] as const;
export type SmtpStatus = (typeof SMTP_STATUSES)[number];

export interface SmtpSettings {
  id: string;
  organization_id: string;
  host: string;
  port: number;
  username: string;
  encryption: SmtpEncryption;
  from_name: string;
  from_email: string;
  status: SmtpStatus;
  last_tested_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Never includes the password - masked username-only preview, mirroring
 * voice_provider_credentials/phone_number_provider_credentials's exact
 * "never return the secret" pattern. */
export type SmtpSettingsPublic = SmtpSettings;

export const MESSAGING_CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'paused', 'completed', 'cancelled', 'failed'] as const;
export type MessagingCampaignStatus = (typeof MESSAGING_CAMPAIGN_STATUSES)[number];

export const SMS_MESSAGE_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'replied'] as const;
export type SmsMessageStatus = (typeof SMS_MESSAGE_STATUSES)[number];

/** 'delivered'/'bounced'/'replied' are schema-valid but never written by
 * this build - see services/emailDispatcher.ts's header comment for why
 * raw SMTP cannot honestly report them. */
export const EMAIL_MESSAGE_STATUSES = ['queued', 'sent', 'failed', 'delivered', 'bounced', 'replied'] as const;
export type EmailMessageStatus = (typeof EMAIL_MESSAGE_STATUSES)[number];

/** Statuses this build's email dispatcher can ever honestly reach. */
export const EMAIL_MESSAGE_REACHABLE_STATUSES = ['queued', 'sent', 'failed'] as const;

export interface SmsCampaign {
  id: string;
  organization_id: string;
  name: string;
  message_template: string;
  phone_number_id: string;
  lead_list_id: string | null;
  status: MessagingCampaignStatus;
  throttle_per_minute: number;
  scheduled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmsMessage {
  id: string;
  sms_campaign_id: string;
  organization_id: string;
  lead_id: string;
  phone_e164: string;
  rendered_body: string;
  status: SmsMessageStatus;
  provider_message_id: string | null;
  error: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface EmailCampaign {
  id: string;
  organization_id: string;
  name: string;
  subject: string;
  html_body: string;
  plain_text_body: string;
  recipient_lead_list_id: string | null;
  recipient_filter: Record<string, unknown> | null;
  status: MessagingCampaignStatus;
  throttle_per_minute: number;
  scheduled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailMessage {
  id: string;
  email_campaign_id: string;
  organization_id: string;
  lead_id: string;
  recipient_email: string;
  rendered_subject: string;
  rendered_html: string;
  status: EmailMessageStatus;
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface MessagingCounts {
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  replied: number;
  total: number;
}
