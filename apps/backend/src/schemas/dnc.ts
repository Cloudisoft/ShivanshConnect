import { z } from 'zod';
import { paginationSchema } from './common.js';

export const createDncEntrySchema = z.object({
  phone: z.string().trim().min(1, 'Phone is required.'),
  reason: z.string().trim().max(500).nullable().optional(),
  source: z.enum(['manual', 'caller_request', 'import']).default('manual'),
});
export type CreateDncEntryInput = z.infer<typeof createDncEntrySchema>;

export const listDncQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
});
export type ListDncQuery = z.infer<typeof listDncQuerySchema>;
