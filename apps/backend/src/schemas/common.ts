import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
});

export const uuidSchema = z.string().uuid('Must be a valid identifier.');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password is too long.');

export const emailSchema = z.string().trim().toLowerCase().email('Must be a valid email address.');
