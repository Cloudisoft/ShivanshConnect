import { z } from 'zod';
import { paginationSchema, uuidSchema } from './common.js';

// GET /cdr
export const listCdrQuerySchema = paginationSchema.extend({
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional(),
  campaign_id: uuidSchema.optional(),
  ai_agent_id: uuidSchema.optional(),
  disposition: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().min(1).max(64).optional(),
  lead_id: uuidSchema.optional(),
  status: z.string().trim().min(1).max(50).optional(),
});
export type ListCdrQuery = z.infer<typeof listCdrQuerySchema>;

// GET /cdr/search-transcript
export const searchTranscriptQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(500),
});
export type SearchTranscriptQuery = z.infer<typeof searchTranscriptQuerySchema>;

// POST /cdr/export
export const createExportSchema = z.object({
  type: z.enum(['cdr_csv', 'cdr_xlsx']),
  filters: listCdrQuerySchema.omit({ page: true, page_size: true }).default({}),
});
export type CreateExportInput = z.infer<typeof createExportSchema>;

// GET /exports
export const listExportsQuerySchema = paginationSchema.extend({
  type: z
    .enum([
      'cdr_csv',
      'cdr_xlsx',
      'leads_csv',
      'leads_xlsx',
      'sms_messages_csv',
      'sms_messages_xlsx',
      'email_messages_csv',
      'email_messages_xlsx',
    ])
    .optional(),
});
