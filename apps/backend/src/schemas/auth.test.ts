import { describe, expect, it } from 'vitest';
import { loginSchema, signupSchema } from './auth.js';
import { updateUserSchema } from './users.js';
import { createRoleSchema } from './roles.js';

describe('signupSchema', () => {
  it('accepts a valid signup payload', () => {
    const result = signupSchema.safeParse({
      organization_name: 'Acme Inc',
      full_name: 'Jane Doe',
      email: 'JANE@Example.com',
      password: 'supersecret123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('jane@example.com');
      expect(result.data.timezone).toBe('UTC');
    }
  });

  it('rejects a short password', () => {
    const result = signupSchema.safeParse({
      organization_name: 'Acme Inc',
      full_name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing organization name', () => {
    const result = signupSchema.safeParse({
      full_name: 'Jane Doe',
      email: 'jane@example.com',
      password: 'supersecret123',
    });
    expect(result.success).toBe(false);
  });
});

describe('loginSchema', () => {
  it('rejects an invalid email', () => {
    const result = loginSchema.safeParse({ email: 'not-an-email', password: 'x' });
    expect(result.success).toBe(false);
  });
});

describe('updateUserSchema', () => {
  it('requires at least one field', () => {
    const result = updateUserSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts a status-only update', () => {
    const result = updateUserSchema.safeParse({ status: 'inactive' });
    expect(result.success).toBe(true);
  });
});

describe('createRoleSchema', () => {
  it('defaults permission_keys to an empty array', () => {
    const result = createRoleSchema.safeParse({ name: 'Custom Role' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.permission_keys).toEqual([]);
  });

  it('rejects a name that is too short', () => {
    const result = createRoleSchema.safeParse({ name: 'A' });
    expect(result.success).toBe(false);
  });
});
