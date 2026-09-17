export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

/** Known audit actions used by Phase 1 handlers. Not an exhaustive enum -
 * future phases may write additional free-form actions. */
export const AUDIT_ACTIONS = {
  USER_INVITED: 'user.invited',
  USER_INVITATION_REVOKED: 'user.invitation_revoked',
  USER_INVITATION_ACCEPTED: 'user.invitation_accepted',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  USER_UPDATED: 'user.updated',
  ORGANIZATION_SETTINGS_CHANGED: 'organization.settings_changed',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  ROLE_PERMISSIONS_CHANGED: 'role.permissions_changed',

  LEAD_LIST_CREATED: 'lead_list.created',
  LEAD_LIST_UPDATED: 'lead_list.updated',
  LEAD_LIST_DELETED: 'lead_list.deleted',
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_DELETED: 'lead.deleted',
  LEAD_BULK_ACTION: 'lead.bulk_action',
  DNC_ENTRY_ADDED: 'dnc.entry_added',
  DNC_ENTRY_REMOVED: 'dnc.entry_removed',
  IMPORT_JOB_CREATED: 'import_job.created',
  IMPORT_JOB_COMMITTED: 'import_job.committed',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
