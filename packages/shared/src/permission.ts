/**
 * Full permission catalog from the master spec. Most modules referenced here
 * (campaigns, leads, live_monitor, voices, numbers, messaging, analytics...)
 * are NOT built in Phase 1 — the permission keys are seeded now so future
 * phases can attach real enforcement without another migration.
 */
export const PERMISSIONS = [
  { key: 'dashboard.view', category: 'dashboard', description: 'View the dashboard' },

  { key: 'campaigns.view', category: 'campaigns', description: 'View campaigns' },
  { key: 'campaigns.create', category: 'campaigns', description: 'Create campaigns' },
  { key: 'campaigns.edit', category: 'campaigns', description: 'Edit campaigns' },
  { key: 'campaigns.start', category: 'campaigns', description: 'Start campaigns' },
  { key: 'campaigns.pause', category: 'campaigns', description: 'Pause campaigns' },
  { key: 'campaigns.delete', category: 'campaigns', description: 'Delete campaigns' },

  { key: 'leads.view', category: 'leads', description: 'View leads' },
  { key: 'leads.create', category: 'leads', description: 'Create leads' },
  { key: 'leads.edit', category: 'leads', description: 'Edit leads' },
  { key: 'leads.delete', category: 'leads', description: 'Delete leads' },
  { key: 'leads.import', category: 'leads', description: 'Import leads' },

  { key: 'live_monitor.view', category: 'live_monitor', description: 'View live monitor' },
  { key: 'live_monitor.listen', category: 'live_monitor', description: 'Listen to live calls' },
  { key: 'live_monitor.barge', category: 'live_monitor', description: 'Barge into live calls' },
  { key: 'live_monitor.whisper', category: 'live_monitor', description: 'Whisper to agents on live calls' },

  { key: 'cdr.view', category: 'cdr', description: 'View call detail records' },
  { key: 'cdr.export', category: 'cdr', description: 'Export call detail records' },

  { key: 'agents.manage', category: 'agents', description: 'Manage AI agents' },
  { key: 'voices.manage', category: 'voices', description: 'Manage voices' },
  { key: 'numbers.manage', category: 'numbers', description: 'Manage phone numbers (DIDs)' },

  { key: 'users.manage', category: 'users', description: 'Manage organization users' },
  { key: 'settings.manage', category: 'settings', description: 'Manage organization settings' },
  { key: 'messaging.manage', category: 'messaging', description: 'Manage messaging' },
  { key: 'analytics.view', category: 'analytics', description: 'View analytics' },
  { key: 'roles.manage', category: 'roles', description: 'Manage roles and permissions' },
  { key: 'audit.view', category: 'audit', description: 'View audit logs' },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]['key'];

export interface Permission {
  id: string;
  key: string;
  description: string;
  category: string;
}
