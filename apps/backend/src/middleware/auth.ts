import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { loadUserContext } from '../lib/permissions.js';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

/**
 * Verifies the caller's Supabase JWT (server-side, against Supabase Auth -
 * never trusted from the client alone) and attaches the resolved
 * organization_id + permission set to req.user. Any route that needs an
 * authenticated caller registers this as a preHandler.
 */
/** Verified tokens, keyed by SHA-256 of the token (the token itself is
 * never kept). Every API request used to make its own network round trip
 * to Supabase Auth; a page load makes several requests with the same
 * token, so each token is verified once and trusted for up to
 * TOKEN_CACHE_TTL_MS, never past its own `exp`. Account status/role
 * changes are still enforced through loadUserContext on every request. */
const TOKEN_CACHE_TTL_MS = 60_000;
const TOKEN_CACHE_MAX = 5_000;
const verifiedTokens = new Map<string, { userId: string; expiresAt: number }>();

function tokenExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function verifyToken(token: string): Promise<string | null> {
  const key = createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const cached = verifiedTokens.get(key);
  if (cached && cached.expiresAt > now) return cached.userId;

  const { data, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !data?.user) {
    verifiedTokens.delete(key);
    return null;
  }
  const exp = tokenExpiryMs(token);
  const expiresAt = Math.min(now + TOKEN_CACHE_TTL_MS, exp ?? now + TOKEN_CACHE_TTL_MS);
  if (expiresAt > now) {
    if (verifiedTokens.size >= TOKEN_CACHE_MAX) verifiedTokens.clear();
    verifiedTokens.set(key, { userId: data.user.id, expiresAt });
  }
  return data.user.id;
}

/** Sign-out: this token must stop working immediately. */
export function forgetVerifiedToken(token: string): void {
  verifiedTokens.delete(createHash('sha256').update(token).digest('hex'));
}

/** Tests: forget every cached token verification. */
export function clearVerifiedTokenCache(): void {
  verifiedTokens.clear();
}

export async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header.');
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw new UnauthorizedError('Missing bearer token.');
  }

  const userId = await verifyToken(token);
  if (!userId) {
    throw new UnauthorizedError('Your session is invalid or has expired. Please sign in again.');
  }

  const ctx = await loadUserContext(userId);
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
