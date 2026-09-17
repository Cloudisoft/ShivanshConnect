import { z } from 'zod';
import { CALLBACK_STATUSES } from '@shivanshconnect/shared';
import { paginationSchema, uuidSchema } from './common.js';

const e164Schema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be a valid E.164 phone number (e.g. +14155550123).');

export const createCallbackSchema = z.object({
  lead_id: uuidSchema,
  campaign_id: uuidSchema.optional().nullable(),
  phone_e164: e164Schema.optional(),
  scheduled_at: z.string().datetime({ offset: true }),
  timezone: z.string().trim().min(1).max(100).default('America/New_York'),
  reason: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  assigned_to: z.string().trim().max(100).optional().nullable(),
});
export type CreateCallbackInput = z.infer<typeof createCallbackSchema>;

export const updateCallbackSchema = z.object({
  scheduled_at: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  reason: z.string().trim().max(500).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  assigned_to: z.string().trim().max(100).optional().nullable(),
  status: z.enum(CALLBACK_STATUSES).optional(),
});
export type UpdateCallbackInput = z.infer<typeof updateCallbackSchema>;

export const listCallbacksQuerySchema = paginationSchema.extend({
  status: z.enum(CALLBACK_STATUSES).optional(),
  campaign_id: uuidSchema.optional(),
  lead_id: uuidSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export type ListCallbacksQuery = z.infer<typeof listCallbacksQuerySchema>;
