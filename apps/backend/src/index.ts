import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { getEnv } from './env.js';
import { fail } from './lib/response.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { userRoutes } from './routes/users.js';
import { roleRoutes } from './routes/roles.js';
import { permissionRoutes } from './routes/permissions.js';
import { organizationRoutes } from './routes/organizations.js';
import { auditLogRoutes } from './routes/auditLogs.js';
import { leadListRoutes } from './routes/leadLists.js';
import { leadRoutes } from './routes/leads.js';
import { leadCustomFieldRoutes } from './routes/leadCustomFields.js';
import { dncRoutes } from './routes/dnc.js';
import { importJobRoutes } from './routes/importJobs.js';
import { agentRoutes } from './routes/agents.js';
import { scriptRoutes } from './routes/scripts.js';
import { knowledgeBaseRoutes } from './routes/knowledgeBases.js';

export function buildApp() {
  const env = getEnv();

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
    },
    genReqId: () => randomUUID(),
  });

  app.register(cors, {
    origin: env.FRONTEND_URL,
    credentials: true,
  });

  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  });

  app.get('/health', async () => ({ status: 'ok', service: 'shivanshconnect-backend' }));

  app.register(
    async (api) => {
      api.register(authRoutes, { prefix: '/auth' });
      api.register(meRoutes);
      api.register(userRoutes, { prefix: '/users' });
      api.register(roleRoutes, { prefix: '/roles' });
      api.register(permissionRoutes, { prefix: '/permissions' });
      api.register(organizationRoutes, { prefix: '/organizations' });
      api.register(auditLogRoutes, { prefix: '/audit-logs' });
      api.register(leadListRoutes, { prefix: '/lead-lists' });
      api.register(leadRoutes, { prefix: '/leads' });
      api.register(leadCustomFieldRoutes, { prefix: '/lead-custom-fields' });
      api.register(dncRoutes, { prefix: '/dnc' });
      api.register(importJobRoutes, { prefix: '/import-jobs' });
      api.register(agentRoutes, { prefix: '/agents' });
      api.register(scriptRoutes, { prefix: '/scripts' });
      api.register(knowledgeBaseRoutes, { prefix: '/knowledge-bases' });
    },
    { prefix: '/api/v1' },
  );

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(fail('NOT_FOUND', 'This endpoint does not exist.', { requestId: req.id }));
  });

  // Central error handler: maps known error types to friendly, safe
  // messages. Raw exception details (stack traces, DB error text) never
  // reach the client.
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send(
        fail(error.code, error.message, { details: error.details, requestId: req.id }),
      );
      return;
    }

    if (error instanceof ZodError) {
      reply.status(422).send(
        fail('VALIDATION_ERROR', 'The request contains invalid data.', {
          details: error.flatten(),
          requestId: req.id,
        }),
      );
      return;
    }

    if ((error as any).statusCode === 429) {
      reply
        .status(429)
        .send(fail('RATE_LIMITED', 'Too many requests. Please slow down and try again shortly.', { requestId: req.id }));
      return;
    }

    if ((error as any).validation) {
      // Fastify's own schema validation errors
      reply.status(422).send(
        fail('VALIDATION_ERROR', 'The request contains invalid data.', {
          details: (error as any).validation,
          requestId: req.id,
        }),
      );
      return;
    }

    req.log.error({ err: error }, 'Unhandled error');
    reply
      .status(500)
      .send(fail('INTERNAL_ERROR', 'Something went wrong on our end. Please try again.', { requestId: req.id }));
  });

  return app;
}

async function main() {
  const env = getEnv();
  const app = buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported by tests).
const entrypoint = process.argv[1] ?? '';
if (entrypoint.endsWith('index.ts') || entrypoint.endsWith('index.js')) {
  main();
}
