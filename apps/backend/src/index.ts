import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { getEnv } from './env.js';
import { fail } from './lib/response.js';
import { AppError } from './lib/errors.js';
import { LlmNotConfiguredError, LlmProviderError } from './lib/llm/index.js';
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
import { agentImprovementRoutes } from './routes/agentImprovements.js';
import { scriptRoutes } from './routes/scripts.js';
import { knowledgeBaseRoutes } from './routes/knowledgeBases.js';
import { voiceProviderRoutes } from './routes/voiceProviders.js';
import { voiceRoutes } from './routes/voices.js';
import { voiceStorageRoutes } from './routes/voiceStorage.js';
import { VoiceCloningNotSupportedError, VoiceProviderNotConfiguredError, VoiceProviderError } from './lib/voice/types.js';
import { phoneNumberProviderRoutes } from './routes/phoneNumberProviders.js';
import { phoneNumberRoutes } from './routes/phoneNumbers.js';
import {
  TelephonyProviderError,
  TelephonyProviderNotConfiguredError,
  TelephonyProviderNotSupportedError,
} from './lib/telephony/types.js';
import { StorageNotConfiguredError } from './lib/storage/types.js';
import { CredentialEncryptionNotConfiguredError } from './lib/crypto/credentials.js';
import { vapiRoutes } from './routes/vapi.js';
import { callRoutes } from './routes/calls.js';
import { webhookReceiverRoutes, webhookAdminRoutes } from './routes/webhooks.js';
import { OrchestrationProviderError, OrchestrationProviderNotConfiguredError } from './lib/orchestration/types.js';
import { campaignRoutes } from './routes/campaigns.js';
import { dialingSettingsRoutes, campaignSettingsRoutes } from './routes/dialingSettings.js';
import { startCampaignDispatcher } from './services/campaignDispatcher.js';
import { dispositionRoutes } from './routes/dispositions.js';
import { callbackRoutes } from './routes/callbacks.js';
import { cdrRoutes } from './routes/cdr.js';
import { exportRoutes } from './routes/exports.js';
import { registerTerminalCallHandler } from './lib/callStateMachine.js';
import { handleTerminalCall } from './services/callTerminalHandler.js';
import { liveMonitorWsRoutes } from './ws/liveMonitorRoutes.js';
import { liveMonitorActionRoutes } from './routes/liveMonitor.js';

export function buildApp() {
  const env = getEnv();

  // Phase 8: the call state machine's terminal-transition handler (Phase
  // 8's disposition engine + campaign_leads update) is a plain function
  // reference, re-registered on every buildApp() call - idempotent
  // (registerTerminalCallHandler just replaces the stored reference), and
  // must be wired here (not only in main()) so the test suite, which
  // builds the app directly via app.inject() and never calls main(),
  // exercises the exact same terminal-transition pipeline production does.
  registerTerminalCallHandler(handleTerminalCall);

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

  // Phase 10: WebSocket support (Live Monitor's real-time stream). See
  // ws/liveMonitorRoutes.ts's header comment for the auth/upgrade model.
  app.register(websocket);

  app.get('/health', async () => ({ status: 'ok', service: 'shivanshconnect-backend' }));

  // Unauthenticated - serves locally-stored voice-preview audio bytes.
  // See routes/voiceStorage.ts's header comment for the trust model.
  app.register(voiceStorageRoutes);

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
      api.register(agentImprovementRoutes, { prefix: '/agent-improvements' });
      api.register(scriptRoutes, { prefix: '/scripts' });
      api.register(knowledgeBaseRoutes, { prefix: '/knowledge-bases' });
      api.register(voiceProviderRoutes, { prefix: '/voice-providers' });
      api.register(voiceRoutes, { prefix: '/voices' });
      api.register(phoneNumberProviderRoutes, { prefix: '/phone-number-providers' });
      api.register(phoneNumberRoutes, { prefix: '/phone-numbers' });
      api.register(vapiRoutes, { prefix: '/vapi' });
      api.register(callRoutes, { prefix: '/calls' });
      api.register(campaignRoutes, { prefix: '/campaigns' });
      // Per-campaign settings overrides share the /campaigns/:id prefix
      // but are a separate plugin registration so their own preHandler
      // hook doesn't collide with campaignRoutes's.
      api.register(campaignSettingsRoutes, { prefix: '/campaigns' });
      api.register(dialingSettingsRoutes, { prefix: '/dialing-settings' });
      api.register(dispositionRoutes, { prefix: '/dispositions' });
      api.register(callbackRoutes, { prefix: '/callbacks' });
      api.register(cdrRoutes, { prefix: '/cdr' });
      api.register(exportRoutes, { prefix: '/exports' });
      // Unauthenticated webhook receivers (external engines) vs the
      // authenticated admin log/replay routes are deliberately two
      // separate Fastify plugin registrations under the same prefix so
      // neither accidentally inherits the other's preHandler hooks.
      api.register(webhookReceiverRoutes, { prefix: '/webhooks' });
      api.register(webhookAdminRoutes, { prefix: '/webhook-events' });
      // Phase 10: Live Monitor - the WS stream and the listen/whisper/
      // barge/transfer/end supervisor action routes are two separate
      // plugin registrations under the same prefix (same pattern as the
      // webhook receiver/admin split above) since the WS route's
      // `websocket: true` option only applies to itself.
      api.register(liveMonitorWsRoutes, { prefix: '/live-monitor' });
      api.register(liveMonitorActionRoutes, { prefix: '/calls' });
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

    // LLM provider not configured (no OPENAI_API_KEY) is a client-actionable
    // 422 with the exact honest message the route set - never a 500, and
    // never fabricated output. A genuine provider-side failure (network
    // error, non-2xx from OpenAI) is a 502 - it's not the caller's fault,
    // but it's not "something went wrong on our end" either.
    if (error instanceof LlmNotConfiguredError) {
      reply.status(422).send(fail('LLM_NOT_CONFIGURED', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof LlmProviderError) {
      reply.status(502).send(fail('LLM_PROVIDER_ERROR', error.message, { requestId: req.id }));
      return;
    }

    // Same honesty rule as the LLM adapter, for voice providers: no
    // credentials/endpoint configured is a client-actionable 422, a
    // genuine provider-side failure is a 502 - never fabricated.
    if (error instanceof VoiceProviderNotConfiguredError) {
      reply.status(422).send(fail('VOICE_PROVIDER_NOT_CONFIGURED', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof VoiceCloningNotSupportedError) {
      reply.status(422).send(fail('VOICE_CLONING_NOT_SUPPORTED', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof VoiceProviderError) {
      reply.status(502).send(fail('VOICE_PROVIDER_ERROR', error.message, { requestId: req.id }));
      return;
    }

    // Same honesty rule, for telephony number providers: no credentials
    // configured is a client-actionable 422, a provider genuinely not
    // supporting a method (BYON's connect/disconnect/listNumbers/
    // getNumberStatus) is also a 422, and a real provider-side failure is
    // a 502 - never fabricated numbers.
    if (error instanceof TelephonyProviderNotConfiguredError) {
      reply.status(422).send(fail('TELEPHONY_PROVIDER_NOT_CONFIGURED', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof TelephonyProviderNotSupportedError) {
      reply.status(422).send(fail('TELEPHONY_PROVIDER_NOT_SUPPORTED', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof TelephonyProviderError) {
      reply.status(502).send(fail('TELEPHONY_PROVIDER_ERROR', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof StorageNotConfiguredError) {
      reply.status(422).send(fail('STORAGE_NOT_CONFIGURED', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof CredentialEncryptionNotConfiguredError) {
      reply.status(422).send(fail('CREDENTIAL_ENCRYPTION_NOT_CONFIGURED', error.message, { requestId: req.id }));
      return;
    }

    // Same honesty rule, for call orchestration engines (Vapi/pipecat):
    // no credentials/service configured is a client-actionable 422, a
    // genuine engine-side failure is a 502 - never a simulated call.
    if (error instanceof OrchestrationProviderNotConfiguredError) {
      reply.status(422).send(fail('ORCHESTRATION_PROVIDER_NOT_CONFIGURED', error.message, { requestId: req.id }));
      return;
    }
    if (error instanceof OrchestrationProviderError) {
      reply.status(502).send(fail('ORCHESTRATION_PROVIDER_ERROR', error.message, { requestId: req.id }));
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
    // Phase 7: starts the in-process campaign dispatch loop (see
    // services/campaignDispatcher.ts's header comment for exactly why
    // this is a setInterval loop today and how it maps onto a real
    // BullMQ repeatable job once Phase 15 wires up Redis). Deliberately
    // NOT started by buildApp() itself so the test suite (which imports
    // buildApp() directly via app.inject(), never main()) never has a
    // background timer running against its fake Supabase client.
    startCampaignDispatcher();
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
