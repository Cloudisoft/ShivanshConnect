import type { AuditAction } from '@shivanshconnect/shared';
import { getSupabaseAdmin } from './supabase.js';

export interface WriteAuditLogInput {
  organizationId: string;
  userId: string | null;
  action: AuditAction | string;
  entityType: string;
  entityId?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * Writes a row to audit_logs. Called from every handler that mutates
 * users, roles, role permissions, or organization settings (per the
 * master spec's required audit events). Failures are logged but never
 * thrown - an audit-log write must not roll back or fail the primary
 * action the user requested, but it must never be silently invisible
 * either.
 */
export async function writeAuditLog(input: WriteAuditLogInput): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from('audit_logs').insert({
    organization_id: input.organizationId,
    user_id: input.userId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    old_value: input.oldValue ?? null,
    new_value: input.newValue ?? null,
    ip_address: input.ipAddress ?? null,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to write audit log', { input, error });
  }
}
