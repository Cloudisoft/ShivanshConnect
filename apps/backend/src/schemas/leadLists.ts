import { z } from 'zod';
import { paginationSchema, uuidSchema } from './common.js';

export const createLeadListSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
});
export type CreateLeadListInput = z.infer<typeof createLeadListSchema>;

export const updateLeadListSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateLeadListInput = z.infer<typeof updateLeadListSchema>;

export const listLeadListsQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
});
export type ListLeadListsQuery = z.infer<typeof listLeadListsQuerySchema>;

// POST /api/v1/lead-lists/:id/export
export const exportLeadListSchema = z.object({
  type: z.enum(['leads_csv', 'leads_xlsx']),
});
export type ExportLeadListInput = z.infer<typeof exportLeadListSchema>;

// POST /api/v1/lead-lists/bulk-delete
export const bulkDeleteLeadListsSchema = z.object({
  lead_list_ids: z.array(uuidSchema).min(1).max(500),
});
export type BulkDeleteLeadListsInput = z.infer<typeof bulkDeleteLeadListsSchema>;
