export type OrganizationStatus = 'active' | 'suspended' | 'trial';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  status: OrganizationStatus;
  created_at: string;
  updated_at: string;
}

export interface OrganizationSettings {
  id: string;
  organization_id: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
