import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { loadUserContext } from '../lib/permissions.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

/**
 * Verifies the caller's Supabase JWT (server-side, against Supabase Auth -
 * never trusted from the client alone) and attaches the resolved
 * organization_id + permission set to req.user. Any route that needs an
 * authenticated caller registers this as a preHandler.
 */
export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header.');
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw new UnauthorizedError('Missing bearer token.');
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new UnauthorizedError('Your session is invalid or has expired. Please sign in again.');
  }

  const ctx = await loadUserContext(data.user.id);
  if (!ctx) {
    throw new UnauthorizedError('No account was found for this session.');
  }
  if (ctx.status !== 'active') {
    throw new ForbiddenError('Your account has been deactivated. Contact your administrator.');
  }

  req.user = ctx;
}

/**
 * Fastify preHandler factory: requires the authenticated caller to hold
 * `permissionKey`. Must run after `authenticate`.
 */
export function requirePermission(permissionKey: string) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    if (!req.user.permissions.includes(permissionKey)) {
      throw new ForbiddenError(`You need the "${permissionKey}" permission to do that.`);
    }
  };
}

/**
 * Defense-in-depth tenant check: asserts a resource's organization_id
 * matches the authenticated caller's organization_id. Called explicitly
 * inside handlers after fetching a resource by id, in addition to (never
 * instead of) filtering the query itself by organization_id and relying
 * on RLS. Returns NotFound-shaped behavior via ForbiddenError since the
 * caller already authenticated; handlers should map a missing resource
 * to 404 before this ever runs on a resource from a different org that
 * genuinely doesn't exist for them.
 */
export function assertSameOrganization(
  resourceOrganizationId: string,
  callerOrganizationId: string,
): void {
  if (resourceOrganizationId !== callerOrganizationId) {
    throw new ForbiddenError('This resource does not belong to your organization.');
  }
}
