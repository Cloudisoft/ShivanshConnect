import { z } from 'zod';

export const createLeadCustomFieldSchema = z.object({
  field_key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_]{0,63}$/, 'Must start with a letter and contain only lowercase letters, numbers and underscores.'),
  field_label: z.string().trim().min(1).max(200),
  field_type: z.enum(['text', 'number', 'date', 'boolean']).default('text'),
});
export type CreateLeadCustomFieldInput = z.infer<typeof createLeadCustomFieldSchema>;
