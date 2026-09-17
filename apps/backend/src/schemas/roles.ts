import { z } from 'zod';
import { uuidSchema } from './common.js';

export const createRoleSchema = z.object({
  name: z.string().trim().min(2).max(100),
  permission_keys: z.array(z.string().trim().min(1)).default([]),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    permission_keys: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;

export const roleIdParamSchema = z.object({ id: uuidSchema });
