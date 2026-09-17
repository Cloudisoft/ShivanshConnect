import { z } from 'zod';
import { SYSTEM_DISPOSITION_CODES } from '@shivanshconnect/shared';
import { paginationSchema, uuidSchema } from './common.js';

export const createDispositionSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Z0-9_]+$/, 'Code must be uppercase letters, digits and underscores only.')
    .refine((code) => !(SYSTEM_DISPOSITION_CODES as readonly string[]).includes(code), 'This code is reserved for a system disposition.'),
  name: z.string().trim().min(1).max(100),
});
export type CreateDispositionInput = z.infer<typeof createDispositionSchema>;

export const updateDispositionSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type UpdateDispositionInput = z.infer<typeof updateDispositionSchema>;

export const listDispositionsQuerySchema = paginationSchema.extend({});
export type ListDispositionsQuery = z.infer<typeof listDispositionsQuerySchema>;

// PATCH /api/v1/calls/:id/disposition - manual supervisor override.
export const overrideCallDispositionSchema = z.object({
  disposition_id: uuidSchema,
  reason: z.string().trim().max(2000).optional().nullable(),
});
export type OverrideCallDispositionInput = z.infer<typeof overrideCallDispositionSchema>;
