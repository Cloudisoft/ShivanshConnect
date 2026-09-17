export type UserStatus = 'active' | 'inactive';

export interface User {
  id: string;
  organization_id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface UserWithRoles extends User {
  roles: RoleSummary[];
}

export interface RoleSummary {
  id: string;
  name: string;
  is_system_role: boolean;
}

export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface UserInvitation {
  id: string;
  organization_id: string;
  email: string;
  role_id: string;
  invited_by: string;
  token: string;
  status: InvitationStatus;
  expires_at: string;
  created_at: string;
}
