import { z } from 'zod';
import { emailSchema } from './common.js';

export const saveSmtpSettingsSchema = z.object({
  host: z.string().trim().min(1, 'Host is required.').max(255),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().min(1, 'Username is required.').max(255),
  // Optional on update - omitted means "keep the existing password".
  password: z.string().trim().min(1).max(500).optional(),
  encryption: z.enum(['tls', 'ssl', 'none']).default('tls'),
  from_name: z.string().trim().max(200).default(''),
  from_email: emailSchema,
});

export const testSmtpSettingsSchema = z.object({
  recipient: emailSchema,
});
