import { z } from 'zod';

/** Human-in-the-loop status transitions (spec sections 24/49). 'detected'
 * is only ever the row's initial state (set by
 * services/aggregateAgentImprovements.ts) and 'applied' is only ever set
 * by POST /:id/apply - neither is a valid PATCH target, so a human can
 * never skip the review step or fake an apply through this endpoint. */
export const updateAgentImprovementSchema = z.object({
  status: z.enum(['under_review', 'approved', 'rejected']),
});
export type UpdateAgentImprovementInput = z.infer<typeof updateAgentImprovementSchema>;

export const listAgentImprovementsQuerySchema = z.object({
  status: z.enum(['detected', 'under_review', 'approved', 'rejected', 'applied']).optional(),
});
export type ListAgentImprovementsQuery = z.infer<typeof listAgentImprovementsQuerySchema>;

export const evaluationSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});
export type EvaluationSummaryQuery = z.infer<typeof evaluationSummaryQuerySchema>;
