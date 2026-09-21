import { z } from 'zod';
import { uuidSchema } from './common.js';
import { LEAD_STATUSES } from '@shivanshconnect/shared';

const leadStatusSchema = z.enum(LEAD_STATUSES as [string, ...string[]]);

export const createLeadSchema = z.object({
  lead_list_id: uuidSchema.nullable().optional(),
  first_name: z.string().trim().max(200).optional(),
  last_name: z.string().trim().max(200).optional(),
  phone: z.string().trim().min(1, 'Phone is required.'),
  email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
  address: z.string().trim().max(300).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(120).nullable().optional(),
  zip: z.string().trim().max(20).nullable().optional(),
  country: z.string().trim().max(2).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;

export const updateLeadSchema = z
  .object({
    lead_list_id: uuidSchema.nullable().optional(),
    first_name: z.string().trim().max(200).optional(),
    last_name: z.string().trim().max(200).optional(),
    phone: z.string().trim().min(1).optional(),
    email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
    address: z.string().trim().max(300).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(120).nullable().optional(),
    zip: z.string().trim().max(20).nullable().optional(),
    country: z.string().trim().max(2).optional(),
    status: leadStatusSchema.optional(),
    next_callback_at: z.string().datetime().nullable().optional(),
    last_disposition: z.string().trim().max(200).nullable().optional(),
    custom_fields: z.record(z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

export const listLeadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  lead_list_id: uuidSchema.optional(),
  status: leadStatusSchema.optional(),
  is_dnc: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  search: z.string().trim().max(200).optional(),
  sort_by: z.enum(['created_at', 'last_called_at', 'attempts', 'last_name', 'next_callback_at']).default('created_at'),
  sort_dir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

export const bulkAddLeadsSchema = z
  .object({
    lead_list_id: uuidSchema.nullable().optional(),
    raw_text: z.string().trim().max(200_000).optional(),
    numbers: z.array(z.string().trim().min(1)).max(5000).optional(),
  })
  .refine((data) => Boolean(data.raw_text?.trim()) || (data.numbers && data.numbers.length > 0), {
    message: 'Provide raw_text or a non-empty numbers array.',
  });
export type BulkAddLeadsInput = z.infer<typeof bulkAddLeadsSchema>;

const leadFilterSchema = z.object({
  lead_list_id: uuidSchema.nullable().optional(),
  status: leadStatusSchema.optional(),
  is_dnc: z.boolean().optional(),
  search: z.string().trim().max(200).optional(),
});

export const leadBulkActionSchema = z
  .object({
    action: z.enum(['delete', 'move_to_list', 'assign_list']),
    lead_ids: z.array(uuidSchema).max(20000).optional(),
    filter: leadFilterSchema.optional(),
    lead_list_id: uuidSchema.optional(),
  })
  .refine((data) => Boolean(data.lead_ids?.length) !== Boolean(data.filter), {
    message: 'Provide exactly one of lead_ids or filter.',
  })
  .refine((data) => data.action === 'delete' || Boolean(data.lead_list_id), {
    message: 'lead_list_id is required for move_to_list / assign_list actions.',
  });
export type LeadBulkActionRequest = z.infer<typeof leadBulkActionSchema>;

// POST /api/v1/leads/export
export const exportLeadsSchema = z.object({
  type: z.enum(['leads_csv', 'leads_xlsx']),
  filters: leadFilterSchema.default({}),
});
export type ExportLeadsInput = z.infer<typeof exportLeadsSchema>;
