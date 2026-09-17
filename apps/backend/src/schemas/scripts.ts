import { z } from 'zod';
import { paginationSchema } from './common.js';

export const createScriptSchema = z.object({
  name: z.string().trim().min(1).max(200),
  content: z.string().trim().max(50000).default(''),
  agent_id: z.string().uuid().nullable().optional(),
  source: z.enum(['editor', 'upload', 'template']).default('editor'),
  template_key: z.string().trim().max(100).optional(),
});
export type CreateScriptInput = z.infer<typeof createScriptSchema>;

export const updateScriptSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().max(50000).optional(),
    agent_id: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateScriptInput = z.infer<typeof updateScriptSchema>;

export const listScriptsQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  agent_id: z.string().uuid().optional(),
});
export type ListScriptsQuery = z.infer<typeof listScriptsQuerySchema>;
