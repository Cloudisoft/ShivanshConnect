import type { Organization } from './organization.js';
import type { User } from './user.js';
import type { RoleSummary } from './user.js';

/** Shape returned by GET /api/v1/me - what the frontend uses to gate UI. */
export interface MeResponse {
  user: User;
  organization: Organization;
  roles: RoleSummary[];
  permissions: string[];
}
