/**
 * Phase 10: `WS /api/v1/live-monitor/stream` - the supervisor-facing
 * real-time channel (master spec sections 18/54).
 *
 * Auth: the exact same JWT scheme as every REST route (a Supabase access
 * token, `Authorization: Bearer <token>`), org-scoped from the resolved
 * user context - never a separate/looser WS auth mechanism. Browsers
 * cannot set arbitrary headers on a WebSocket handshake, so the token is
 * also accepted as a `?token=` query parameter (the WHATWG WebSocket API
 * has no other way to attach one) - see readTokenFromRequest() below.
 * Either way, `authenticate()` runs as this route's ordinary Fastify
 * preHandler BEFORE the HTTP connection is upgraded, so an invalid/
 * missing token is rejected with a normal HTTP 401 and the upgrade never
 * happens - not a bespoke WS-level auth message.
 *
 * On connect: sends one `{ type: 'SNAPSHOT', calls: [...] }` message (the
 * caller's org's currently-active calls), then subscribes to
 * ws/liveMonitorBroadcaster.ts for as long as the socket stays open,
 * pushing every subsequent event verbatim. Never polls the DB on an
 * interval - see that module's header comment.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { fetchActiveCallsSnapshot } from '../services/liveMonitorQuery.js';
import { registerLiveMonitorSubscriber } from './liveMonitorBroadcaster.js';
import type { LiveMonitorSnapshot } from '@shivanshconnect/shared';

/** Lets a browser WebSocket client authenticate via `?token=` since it
 * cannot set an Authorization header on the handshake - authenticate()
 * itself only ever reads req.headers.authorization, so this rewrites the
 * header from the query param BEFORE authenticate() runs, when no
 * Authorization header was already sent (a non-browser client, e.g. a
 * test harness, can still use the header directly). */
function hydrateAuthHeaderFromQuery(req: FastifyRequest): void {
  if (req.headers.authorization) return;
  const token = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof token === 'string' && token.length > 0) {
    req.headers.authorization = `Bearer ${token}`;
  }
}

export async function liveMonitorWsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/stream',
    {
      websocket: true,
      preHandler: [
        async (req) => hydrateAuthHeaderFromQuery(req),
        authenticate,
        requirePermission('live_monitor.view'),
      ],
    },
    async (socket, req) => {
      const supabase = getSupabaseAdmin();
      const organizationId = req.user!.organizationId;

      let closed = false;
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          // Socket already gone - the 'close' handler below will run the
          // real cleanup; swallow here rather than throwing inside an
          // event-bus listener.
        }
      };

      try {
        const calls = await fetchActiveCallsSnapshot(supabase, organizationId);
        const snapshot: LiveMonitorSnapshot = { type: 'SNAPSHOT', calls };
        send(snapshot);
      } catch (err) {
        req.log.error({ err }, 'live-monitor: failed to build initial snapshot');
      }

      const unsubscribe = registerLiveMonitorSubscriber(supabase, organizationId, send);

      socket.on('close', () => {
        closed = true;
        unsubscribe();
      });
      socket.on('error', () => {
        closed = true;
        unsubscribe();
      });
    },
  );
}
