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
  direction: z.enum(['inbound', 'outbound']).optional(),
  /** Only calls whose talk time is at least this many seconds. */
  min_talk_seconds: z.coerce.number().int().min(1).max(86_400).optional(),
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
  filters: listCdrQuerySchema
    .omit({ page: true, page_size: true })
    .extend({
      /** Export only these calls (rows ticked in the CDR list). */
      call_ids: z.array(uuidSchema).min(1).max(5000).optional(),
    })
    .default({}),
});
export type CreateExportInput = z.infer<typeof createExportSchema>;

// POST /cdr/delete - the ticked calls, or every call matching the filters.
export const deleteCallsSchema = z
  .object({
    call_ids: z.array(uuidSchema).min(1).max(5000).optional(),
    filters: listCdrQuerySchema.omit({ page: true, page_size: true }).optional(),
  })
  .refine((v) => Boolean(v.call_ids) !== Boolean(v.filters), { message: 'Send either call_ids or filters.' });
export type DeleteCallsInput = z.infer<typeof deleteCallsSchema>;

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
