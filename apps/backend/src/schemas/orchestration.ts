import { z } from 'zod';
import { CALL_ENGINES } from '@shivanshconnect/shared';
import { paginationSchema, uuidSchema } from './common.js';

export const callEngineSchema = z.enum(CALL_ENGINES);

// POST /vapi/credentials
export const vapiCredentialsSchema = z.object({
  api_key: z.string().trim().min(1).max(500),
});
export type VapiCredentialsInput = z.infer<typeof vapiCredentialsSchema>;

// POST /calls
export const createCallSchema = z.object({
  agent_id: uuidSchema,
  lead_id: uuidSchema.optional(),
  // Required when lead_id is not supplied - one or the other resolves the
  // customer number, checked in the route handler.
  customer_number: z.string().trim().min(1).max(32).optional(),
  phone_number_id: uuidSchema,
  engine: callEngineSchema.optional(),
});
export type CreateCallInput = z.infer<typeof createCallSchema>;

export const listCallsQuerySchema = paginationSchema.extend({
  status: z.string().optional(),
  engine: callEngineSchema.optional(),
  ai_agent_id: uuidSchema.optional(),
});
export type ListCallsQuery = z.infer<typeof listCallsQuerySchema>;

export const listWebhookEventsQuerySchema = paginationSchema.extend({
  provider: z.enum(['vapi', 'pipecat', 'twilio', 'telnyx']).optional(),
  processing_status: z.enum(['pending', 'processing', 'processed', 'failed']).optional(),
});
export type ListWebhookEventsQuery = z.infer<typeof listWebhookEventsQuerySchema>;
