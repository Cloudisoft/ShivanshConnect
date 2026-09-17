import { z } from 'zod';

export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(200).optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
