import { z } from 'zod';
import { AGENT_ROLES } from '@shivanshconnect/shared';
import { paginationSchema } from './common.js';

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  role: z.enum(AGENT_ROLES),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    role: z.enum(AGENT_ROLES).optional(),
    status: z.enum(['draft', 'active', 'inactive']).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field to update.' });
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

export const listAgentsQuerySchema = paginationSchema.extend({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['draft', 'active', 'inactive']).optional(),
});
export type ListAgentsQuery = z.infer<typeof listAgentsQuerySchema>;

const personalitySchema = z.object({
  tone: z.string().trim().max(100).nullable().default(null),
  personality_traits: z.array(z.string().trim().max(100)).max(20).default([]),
  behavior_traits: z.array(z.string().trim().max(100)).max(20).default([]),
});

const transferRulesSchema = z.object({
  on_no_match: z.enum(['end_call', 'transfer', 'voicemail']).default('end_call'),
  transfer_to: z.string().trim().max(200).nullable().default(null),
  conditions: z.array(z.string().trim().max(500)).max(20).default([]),
});

const callEndingRulesSchema = z.object({
  max_call_duration_seconds: z.number().int().positive().nullable().default(null),
  end_phrases: z.array(z.string().trim().max(200)).max(20).default([]),
  summarize_before_ending: z.boolean().default(true),
});

export const agentVersionConfigSchema = z.object({
  personality: personalitySchema.optional(),
  language: z.string().trim().min(2).max(20).optional(),
  accent: z.string().trim().max(100).nullable().optional(),
  greeting_template: z.string().trim().max(5000).optional(),
  system_prompt: z.string().trim().max(20000).optional(),
  fallback_behavior: z.string().trim().max(2000).nullable().optional(),
  transfer_rules: transferRulesSchema.optional(),
  call_ending_rules: callEndingRulesSchema.optional(),
  llm_provider: z.string().trim().min(1).max(50).optional(),
  llm_model: z.string().trim().min(1).max(100).optional(),
  llm_temperature: z.number().min(0).max(2).optional(),
  llm_max_tokens: z.number().int().positive().max(32000).optional(),
  // Phase 4: voice_id references voices.id (a uuid FK - see
  // supabase/migrations/00000000000024_voices.sql, which converted this
  // column from Phase 3's bare text).
  voice_id: z.string().uuid().nullable().optional(),
});
export type AgentVersionConfigInput = z.infer<typeof agentVersionConfigSchema>;

export const createAgentVersionSchema = agentVersionConfigSchema;

export const updateAgentVersionSchema = agentVersionConfigSchema.refine(
  (data) => Object.keys(data).length > 0,
  { message: 'Provide at least one field to update.' },
);

export const agentPreviewRequestSchema = z.object({
  message: z.string().trim().max(4000).optional(),
  lead: z
    .object({
      first_name: z.string().trim().max(200).optional(),
      last_name: z.string().trim().max(200).optional(),
      company: z.string().trim().max(200).optional(),
      phone: z.string().trim().max(50).optional(),
      email: z.string().trim().max(200).optional(),
      custom_field: z.record(z.string()).optional(),
    })
    .optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().max(4000) }))
    .max(20)
    .optional(),
});
export type AgentPreviewRequestInput = z.infer<typeof agentPreviewRequestSchema>;

export const knowledgeSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  top_k: z.number().int().min(1).max(20).default(5),
});
export type KnowledgeSearchRequestInput = z.infer<typeof knowledgeSearchRequestSchema>;
