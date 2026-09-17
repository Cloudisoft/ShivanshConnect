import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(async (): Promise<{ error: { message: string } | null }> => ({ error: null })),
  from: vi.fn(),
}));

vi.mock('./supabase.js', () => ({
  getSupabaseAdmin: () => ({ from: mocks.from }),
}));

import { writeAuditLog } from './audit.js';

describe('writeAuditLog', () => {
  beforeEach(() => {
    mocks.insert.mockReset().mockResolvedValue({ error: null });
    mocks.from.mockReset().mockImplementation((table: string) => {
      expect(table).toBe('audit_logs');
      return { insert: mocks.insert };
    });
  });

  it('inserts a row shaped for the audit_logs table', async () => {
    await writeAuditLog({
      organizationId: 'org1',
      userId: 'user1',
      action: 'user.role_changed',
      entityType: 'user',
      entityId: 'user2',
      oldValue: { role_id: 'r1' },
      newValue: { role_id: 'r2' },
      ipAddress: '1.2.3.4',
    });

    expect(mocks.insert).toHaveBeenCalledWith({
      organization_id: 'org1',
      user_id: 'user1',
      action: 'user.role_changed',
      entity_type: 'user',
      entity_id: 'user2',
      old_value: { role_id: 'r1' },
      new_value: { role_id: 'r2' },
      ip_address: '1.2.3.4',
    });
  });

  it('does not throw when the insert fails (audit logging must never break the primary action)', async () => {
    mocks.insert.mockResolvedValue({ error: { message: 'boom' } });

    await expect(
      writeAuditLog({
        organizationId: 'org1',
        userId: null,
        action: 'user.deactivated',
        entityType: 'user',
      }),
    ).resolves.toBeUndefined();
  });
});
