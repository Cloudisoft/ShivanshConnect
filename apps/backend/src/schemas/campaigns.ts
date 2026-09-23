import { z } from 'zod';
import { CAMPAIGN_STATUSES, BACKGROUND_NOISE_OPTIONS } from '@shivanshconnect/shared';
import { paginationSchema, uuidSchema } from './common.js';

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Must be a time in HH:MM format.');

const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be a valid E.164 phone number (e.g. +14155550123).');

const weekdaySchema = z.number().int().min(1).max(7);

export const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().nullable(),
  timezone: z.string().trim().min(1).max(100).default('America/New_York'),
  calling_window_start: timeSchema.default('09:00'),
  calling_window_end: timeSchema.default('18:00'),
  calling_days: z.array(weekdaySchema).min(1).max(7).default([1, 2, 3, 4, 5]),
  start_date: z.string().date().optional().nullable(),
  end_date: z.string().date().optional().nullable(),
  concurrency_limit: z.number().int().min(1).max(500).default(5),
  calls_per_minute_limit: z.number().int().min(1).max(1000).optional().nullable(),
  phone_number_id: uuidSchema.optional().nullable(),
  transfer_number_e164: e164Schema.optional().nullable(),
  voicemail_detection_enabled: z.boolean().default(true),
  voicemail_message: z.string().trim().max(2000).optional().nullable(),
  leave_voicemail: z.boolean().default(true),
  lead_cooldown_minutes: z.number().int().min(0).max(43200).default(1440),
  background_noise: z.enum(BACKGROUND_NOISE_OPTIONS).optional().nullable(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const updateCampaignSchema = createCampaignSchema.partial();
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

export const listCampaignsQuerySchema = paginationSchema.extend({
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;

const callingRulesOverrideSchema = z.object({
  timezone: z.string().trim().min(1).max(100).optional(),
  calling_window_start: timeSchema.optional(),
  calling_window_end: timeSchema.optional(),
  calling_days: z.array(weekdaySchema).min(1).max(7).optional(),
  lead_cooldown_minutes: z.number().int().min(0).max(43200).optional(),
  voicemail_detection_enabled: z.boolean().optional(),
  voicemail_message: z.string().trim().max(2000).nullable().optional(),
  leave_voicemail: z.boolean().optional(),
  background_noise: z.enum(BACKGROUND_NOISE_OPTIONS).nullable().optional(),
});

const dispositionRulesOverrideSchema = z.object({
  retry_on: z.array(z.string().trim().min(1)).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  retry_delay_minutes: z.number().int().min(1).max(10080).optional(),
});

export const createCampaignVersionSchema = z.object({
  prompt: z.string().trim().max(20000).default(''),
  ai_agent_id: uuidSchema.optional().nullable(),
  voice_id: uuidSchema.optional().nullable(),
  knowledge_base_ids: z.array(uuidSchema).default([]),
  script_id: uuidSchema.optional().nullable(),
  transfer_number_e164: e164Schema.optional().nullable(),
  calling_rules: callingRulesOverrideSchema.default({}),
  disposition_rules: dispositionRulesOverrideSchema.default({}),
});
export type CreateCampaignVersionInput = z.infer<typeof createCampaignVersionSchema>;

export const attachLeadsSchema = z
  .object({
    lead_ids: z.array(uuidSchema).max(20000).optional(),
    lead_list_id: uuidSchema.optional(),
  })
  .refine((v) => Boolean(v.lead_ids?.length) || Boolean(v.lead_list_id), {
    message: 'Provide either lead_ids or a lead_list_id.',
  });
export type AttachLeadsInput = z.infer<typeof attachLeadsSchema>;

export const rotateLeadsSchema = z.object({
  dry_run: z.boolean().default(false),
});
export type RotateLeadsInput = z.infer<typeof rotateLeadsSchema>;

export const removeLeadsSchema = z.object({
  lead_ids: z.array(uuidSchema).min(1).max(20000),
});
export type RemoveLeadsInput = z.infer<typeof removeLeadsSchema>;

export const updateConcurrencySchema = z.object({
  concurrency_limit: z.number().int().min(1).max(500),
});
export type UpdateConcurrencyInput = z.infer<typeof updateConcurrencySchema>;

export const dialingSettingsSchema = z.object({
  default_concurrency: z.number().int().min(1).max(500).optional(),
  max_concurrency: z.number().int().min(1).max(500).optional(),
  calls_per_minute: z.number().int().min(1).max(1000).optional(),
  max_attempts: z.number().int().min(1).max(20).optional(),
  retry_delay_minutes: z.number().int().min(1).max(10080).optional(),
  lead_cooldown_minutes: z.number().int().min(0).max(43200).optional(),
  calling_hours_start: timeSchema.optional(),
  calling_hours_end: timeSchema.optional(),
  voicemail_behavior: z.enum(['leave_message', 'hang_up', 'retry_later']).optional(),
  amd_enabled: z.boolean().optional(),
  failed_call_behavior: z.enum(['retry', 'skip']).optional(),
  busy_behavior: z.enum(['retry', 'skip']).optional(),
  no_answer_behavior: z.enum(['retry', 'skip']).optional(),
});
export type DialingSettingsInput = z.infer<typeof dialingSettingsSchema>;

export const campaignSettingSchema = z.object({
  key: z.string().trim().min(1).max(100),
  value: z.unknown(),
});
export type CampaignSettingInput = z.infer<typeof campaignSettingSchema>;
