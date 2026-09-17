import 'fastify';
import type { UserContext } from '../lib/permissions.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserContext;
  }
}
