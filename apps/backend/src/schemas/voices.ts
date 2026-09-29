import { z } from 'zod';
import { VOICE_PROVIDER_KEYS } from '@shivanshconnect/shared';
import { paginationSchema, uuidSchema } from './common.js';

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
  is_cloned: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(100).optional(),
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

/** "Select all matching" - the same filters GET /voices takes. */
export const voiceFilterSchema = z.object({
  provider_key: voiceProviderKeySchema.optional(),
  language: z.string().trim().max(20).optional(),
  gender: z.enum(['male', 'female', 'neutral', 'unknown']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  is_cloned: z.boolean().optional(),
  search: z.string().trim().max(100).optional(),
});

const voiceSelectionSchema = {
  voice_ids: z.array(uuidSchema).min(1).max(500).optional(),
  filter: voiceFilterSchema.optional(),
};
const oneSelection = (d: { voice_ids?: string[]; filter?: unknown }) => Boolean(d.voice_ids?.length) !== Boolean(d.filter);
const oneSelectionMessage = { message: 'Provide exactly one of voice_ids or filter.' };

export const bulkDeleteVoicesSchema = z.object(voiceSelectionSchema).refine(oneSelection, oneSelectionMessage);
export type BulkDeleteVoicesInput = z.infer<typeof bulkDeleteVoicesSchema>;

export const bulkUpdateVoicesSchema = z.object({ ...voiceSelectionSchema, is_cloned: z.boolean() }).refine(oneSelection, oneSelectionMessage);
export type BulkUpdateVoicesInput = z.infer<typeof bulkUpdateVoicesSchema>;

export const importVoicesByIdSchema = z.object({
  provider_key: voiceProviderKeySchema,
  voices: z
    .array(
      z.object({
        provider_voice_id: z.string().trim().min(1).max(200),
        name: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(100),
  /** Mark every voice in this import as a cloned voice. */
  is_cloned: z.boolean().optional(),
});
export type ImportVoicesByIdInput = z.infer<typeof importVoicesByIdSchema>;

export const updateVoiceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    is_cloned: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.is_cloned !== undefined, { message: 'Nothing to update.' });
export type UpdateVoiceInput = z.infer<typeof updateVoiceSchema>;
