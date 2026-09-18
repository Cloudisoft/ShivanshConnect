import { z } from 'zod';
import { emailSchema } from './common.js';

export const createEmailSuppressionSchema = z.object({
  email: emailSchema,
  reason: z.string().trim().max(500).optional(),
});

export const listEmailSuppressionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
});
