import { z } from 'zod';

export const createSmsCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200),
  message_template: z.string().trim().min(1).max(1600),
  phone_number_id: z.string().uuid(),
  lead_list_id: z.string().uuid().nullable().optional(),
  throttle_per_minute: z.coerce.number().int().min(1).max(1000).default(30),
  scheduled_at: z.string().datetime().nullable().optional(),
});

export const updateSmsCampaignSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  message_template: z.string().trim().min(1).max(1600).optional(),
  phone_number_id: z.string().uuid().optional(),
  lead_list_id: z.string().uuid().nullable().optional(),
  throttle_per_minute: z.coerce.number().int().min(1).max(1000).optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
});

export const listSmsCampaignsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().optional(),
});

export const listMessagesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(50),
  status: z.string().optional(),
});
