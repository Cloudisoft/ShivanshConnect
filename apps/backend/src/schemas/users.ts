import { z } from 'zod';
import { emailSchema, uuidSchema } from './common.js';

export const inviteUserSchema = z.object({
  email: emailSchema,
  role_id: uuidSchema,
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

export const updateUserSchema = z
  .object({
    full_name: z.string().trim().min(1).max(200).optional(),
    avatar_url: z.string().trim().url().nullable().optional(),
    role_id: uuidSchema.optional(),
    status: z.enum(['active', 'inactive']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update.',
  });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().trim().max(200).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
