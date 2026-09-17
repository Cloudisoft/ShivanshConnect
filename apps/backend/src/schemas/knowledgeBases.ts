import { z } from 'zod';

export const createKnowledgeBaseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  agent_id: z.string().uuid().nullable().optional(),
});
export type CreateKnowledgeBaseInput = z.infer<typeof createKnowledgeBaseSchema>;
