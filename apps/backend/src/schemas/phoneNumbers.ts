import { z } from 'zod';
import { TELEPHONY_PROVIDER_KEYS } from '@shivanshconnect/shared';
import { paginationSchema, uuidSchema } from './common.js';

export const telephonyProviderKeySchema = z.enum(TELEPHONY_PROVIDER_KEYS);

// POST /phone-number-providers/:key/credentials - shape depends on which
// provider key is in the URL, checked in the route handler (mirrors
// voiceProviders.ts's kind-vs-provider cross-check).
export const twilioCredentialsSchema = z.object({
  account_sid: z.string().trim().min(1).max(200),
  auth_token: z.string().trim().min(1).max(200),
});
export type TwilioCredentialsInput = z.infer<typeof twilioCredentialsSchema>;

export const telnyxCredentialsSchema = z.object({
  api_key: z.string().trim().min(1).max(500),
});
export type TelnyxCredentialsInput = z.infer<typeof telnyxCredentialsSchema>;

export const capabilitiesSchema = z.object({
  voice_inbound: z.boolean(),
  voice_outbound: z.boolean(),
  sms: z.boolean(),
});
export type CapabilitiesInput = z.infer<typeof capabilitiesSchema>;

// POST /phone-numbers/import
export const importPhoneNumberSchema = z.discriminatedUnion('provider_key', [
  z.object({
    provider_key: z.literal('byon'),
    phone_number: z.string().trim().min(1).max(32),
    friendly_name: z.string().trim().max(200).optional(),
    capabilities: capabilitiesSchema,
    sip_trunk_metadata: z
      .object({
        host: z.string().trim().min(1).max(255),
        username: z.string().trim().min(1).max(255),
        password: z.string().trim().min(1).max(500),
      })
      .optional(),
  }),
  z.object({
    provider_key: z.literal('twilio'),
    provider_number_id: z.string().trim().min(1).max(100),
  }),
  z.object({
    provider_key: z.literal('telnyx'),
    provider_number_id: z.string().trim().min(1).max(100),
  }),
]);
export type ImportPhoneNumberInput = z.infer<typeof importPhoneNumberSchema>;

// GET /phone-numbers/available/:providerKey
export const searchAvailableNumbersQuerySchema = z.object({
  country: z
    .string()
    .trim()
    .length(2)
    .transform((v) => v.toUpperCase()),
  area_code: z.string().trim().max(10).optional(),
  contains: z.string().trim().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type SearchAvailableNumbersQuery = z.infer<typeof searchAvailableNumbersQuerySchema>;

// POST /phone-numbers/purchase/:providerKey
export const purchaseNumberSchema = z.object({
  phone_number: z.string().trim().min(1).max(32),
});
export type PurchaseNumberInput = z.infer<typeof purchaseNumberSchema>;

export const listPhoneNumbersQuerySchema = paginationSchema.extend({
  provider_key: telephonyProviderKeySchema.optional(),
  status: z.enum(['active', 'inactive', 'releasing']).optional(),
  assigned_agent_id: uuidSchema.optional(),
  unassigned: z.coerce.boolean().optional(),
});
export type ListPhoneNumbersQuery = z.infer<typeof listPhoneNumbersQuerySchema>;

export const updatePhoneNumberSchema = z
  .object({
    friendly_name: z.string().trim().max(200).nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    assigned_agent_id: uuidSchema.nullable().optional(),
    assigned_campaign_id: uuidSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided.' });
export type UpdatePhoneNumberInput = z.infer<typeof updatePhoneNumberSchema>;
