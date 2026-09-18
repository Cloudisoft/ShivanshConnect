import { z } from 'zod';

const recipientFilterSchema = z.object({
  campaign_id: z.string().uuid().optional(),
  disposition: z.string().optional(),
});

export const createEmailCampaignSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(500),
    html_body: z.string().trim().min(1),
    plain_text_body: z.string().trim().default(''),
    recipient_lead_list_id: z.string().uuid().nullable().optional(),
    recipient_filter: recipientFilterSchema.nullable().optional(),
    throttle_per_minute: z.coerce.number().int().min(1).max(1000).default(30),
    scheduled_at: z.string().datetime().nullable().optional(),
  })
  .refine((v) => Boolean(v.recipient_lead_list_id) || Boolean(v.recipient_filter), {
    message: 'Either recipient_lead_list_id or recipient_filter must be provided.',
  });

export const updateEmailCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  html_body: z.string().trim().min(1).optional(),
  plain_text_body: z.string().trim().optional(),
  recipient_lead_list_id: z.string().uuid().nullable().optional(),
  recipient_filter: recipientFilterSchema.nullable().optional(),
  throttle_per_minute: z.coerce.number().int().min(1).max(1000).optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
});

export const listEmailCampaignsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
});
