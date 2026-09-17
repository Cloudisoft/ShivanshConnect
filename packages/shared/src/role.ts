export const SYSTEM_ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'MANAGER',
  'AGENT',
  'VIEWER',
] as const;

export type SystemRoleName = (typeof SYSTEM_ROLES)[number];

export interface Role {
  id: string;
  organization_id: string | null;
  name: string;
  is_system_role: boolean;
  created_at: string;
}

export interface RoleWithPermissions extends Role {
  permissions: string[];
}
