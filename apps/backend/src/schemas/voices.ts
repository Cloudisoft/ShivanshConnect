import { z } from 'zod';
import { VOICE_PROVIDER_KEYS } from '@shivanshconnect/shared';
import { paginationSchema } from './common.js';

export const voiceProviderKeySchema = z.enum(VOICE_PROVIDER_KEYS);

export const saveProviderCredentialsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('api_key'), api_key: z.string().trim().min(1).max(500) }),
  z.object({
    kind: z.literal('endpoint'),
    endpoint_url: z.string().trim().url().max(1000),
    api_key: z.string().trim().min(1).max(500),
  }),
]);
export type SaveProviderCredentialsInput = z.infer<typeof saveProviderCredentialsSchema>;

export const listVoicesQuerySchema = paginationSchema.extend({
  provider_key: voiceProviderKeySchema.optional(),
  language: z.string().trim().max(20).optional(),
  gender: z.enum(['male', 'female', 'neutral', 'unknown']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
export type ListVoicesQuery = z.infer<typeof listVoicesQuerySchema>;

export const previewVoiceSchema = z.object({
  sample_text: z.string().trim().min(1).max(1000).default('Hello, this is a preview of my voice.'),
});
export type PreviewVoiceInput = z.infer<typeof previewVoiceSchema>;

export const cloneVoiceMetadataSchema = z.object({
  provider_key: voiceProviderKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  language: z.string().trim().max(20).optional(),
  accent: z.string().trim().max(100).optional(),
  gender: z.enum(['male', 'female', 'neutral', 'unknown']).optional(),
  consent_confirmed: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you have consent to clone this voice.' }),
  }),
});
export type CloneVoiceMetadataInput = z.infer<typeof cloneVoiceMetadataSchema>;
