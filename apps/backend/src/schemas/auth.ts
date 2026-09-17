import { z } from 'zod';
import { emailSchema, passwordSchema } from './common.js';

export const signupSchema = z.object({
  organization_name: z.string().trim().min(2, 'Organization name is too short.').max(200),
  full_name: z.string().trim().min(1, 'Full name is required.').max(200),
  email: emailSchema,
  password: passwordSchema,
  timezone: z.string().trim().min(1).max(100).default('UTC'),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required.'),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
});
export type PasswordResetRequestInput = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  access_token: z.string().min(1, 'Reset link is invalid or expired.'),
  refresh_token: z.string().min(1, 'Reset link is invalid or expired.'),
  new_password: passwordSchema,
});
export type PasswordResetConfirmInput = z.infer<typeof passwordResetConfirmSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().uuid('Invitation link is invalid.'),
  full_name: z.string().trim().min(1, 'Full name is required.').max(200),
  password: passwordSchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
