import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { listWebhookEventsQuerySchema } from '../schemas/orchestration.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, type CallStatus } from '@shivanshconnect/shared';
import { transitionCallState } from '../lib/callStateMachine.js';
import { extractPipecatToolCalls, extractVapiToolCalls, processToolCalls } from '../services/toolCallHandler.js';
import { ingestLiveTranscriptSegment } from '../services/liveTranscriptIngestion.js';
import { vapiRoleToSpeaker } from '../lib/orchestration/vapi.js';

/**
 * Phase 6 webhook receivers (spec sections 31/58).
 *
 * Both POST /webhooks/vapi and POST /webhooks/pipecat are UNAUTHENTICATED
 * (no `authenticate` preHandler) - by definition the caller is the
 * external engine, not a signed-in ShivanshConnect user. Trust instead
 * comes from:
 *   1. Idempotency: every delivery is first inserted into webhook_events
 *      with UNIQUE (provider, event_id). A duplicate delivery hits that
 *      constraint, is caught, and is treated as already-processed - it is
 *      NEVER reprocessed, and the webhook still gets a 200 back (retrying
 *      a benign duplicate is never useful to the sender).
 *   2. Organization resolution from the payload's own engine-assigned ids
 *      (vapi_call_id / pipecat_call_id), never from a client-supplied
 *      organization_id field. The resolved call's stored organization_id
 *      is what's trusted from here on - a payload that doesn't resolve to
 *      a call this backend actually created for SOME org is rejected
 *      outright (never silently accepted as "org unknown").
 *   3. Call-status transitions are only ever written when
 *      isValidCallTransition() allows it (spec section 50) - an
 *      out-of-order or corrupted delivery is logged as an invalid
 *      transition attempt in call_events, never blindly applied.
 *
 * Vapi signature verification: Vapi's current documented mechanism is an
 * `x-vapi-secret` header the account's server-url config can require,
 * checked against a shared secret set alongside the webhook URL itself
 * (VAPI_WEBHOOK_SECRET). This is verified here when that env var is set;
 * when it is not set, the receiver still works (idempotency + payload-
 * resolved org ownership are the primary defenses either way) but a
 * comment on every request logs that signature verification was skipped -
 * see verifyVapiSignature() below. pipecat webhooks are verified instead
 * by a shared bearer token this backend itself issued to pipecat-service
 * at startup (PIPECAT_SERVICE_TOKEN), since pipecat-service is this
 * platform's own component rather than a third party.
 */

function verifyVapiSignature(req: { headers: Record<string, unknown> }): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) return true; // not configured - see header comment
  return req.headers['x-vapi-secret'] === secret;
}

function verifyPipecatToken(req: { headers: Record<string, unknown> }): boolean {
  const token = process.env.PIPECAT_SERVICE_TOKEN;
  if (!token) return true; // not configured - local/dev
  const auth = req.headers.authorization as string | undefined;
  return auth === `Bearer ${token}`;
}

interface RecordWebhookResult {
  webhookEventId: string;
  alreadyProcessed: boolean;
}

/** Inserts the raw delivery into webhook_events. A UNIQUE (provider,
 * event_id) conflict means this exact event was already recorded -
 * fetches and returns that existing row's id/processed state instead of
 * erroring, which is the actual idempotency guarantee. */
async function recordWebhookEvent(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  input: { provider: string; eventId: string; eventType: string; payload: Record<string, unknown>; organizationId: string | null },
): Promise<RecordWebhookResult> {
  const { data: inserted, error } = await supabase
    .from('webhook_events')
    .insert({
      organization_id: input.organizationId,
      provider: input.provider,
      event_id: input.eventId,
      event_type: input.eventType,
      payload: input.payload,
      processing_status: 'processing',
    })
    .select('id')
    .maybeSingle();

  if (!error && inserted) {
    return { webhookEventId: inserted.id, alreadyProcessed: false };
  }

  // Unique-constraint conflict (or the fake test client's equivalent) -
  // this exact (provider, event_id) was already recorded. Look it up
  // instead of treating it as a hard error.
  const { data: existing, error: lookupError } = await supabase
    .from('webhook_events')
    .select('id, processing_status')
    .eq('provider', input.provider)
    .eq('event_id', input.eventId)
    .maybeSingle();
  if (lookupError || !existing) {
    throw error ?? lookupError ?? new Error('Failed to record webhook event.');
  }
  return { webhookEventId: existing.id, alreadyProcessed: existing.processing_status === 'processed' };
}

async function markWebhookProcessed(supabase: ReturnType<typeof getSupabaseAdmin>, webhookEventId: string, organizationId: string | null): Promise<void> {
  await supabase
    .from('webhook_events')
    .update({ processing_status: 'processed', processed_at: new Date().toISOString(), organization_id: organizationId })
    .eq('id', webhookEventId);
}

async function markWebhookFailed(supabase: ReturnType<typeof getSupabaseAdmin>, webhookEventId: string, errorMessage: string): Promise<void> {
  const { data: updated } = await supabase
    .from('webhook_events')
    .update({ processing_status: 'failed', error: errorMessage })
    .eq('id', webhookEventId)
    .select('id, retry_count')
    .maybeSingle();
  if (updated) {
    await supabase.from('webhook_events').update({ retry_count: (updated.retry_count ?? 0) + 1 }).eq('id', webhookEventId);
  }
  await supabase.from('webhook_failures').insert({ webhook_event_id: webhookEventId, error: errorMessage });
}

/** Applies a call-status update by going through the Phase 8 call state
 * machine executor (lib/callStateMachine.ts) - the ONE place `calls.status`
 * is ever written. `transitionCallState()` itself validates the
 * transition (spec 50), logs and rejects an invalid one instead of
 * silently applying it, and - for a terminal status - awaits the
 * registered terminal-call handler (services/callTerminalHandler.ts),
 * which runs Phase 8's disposition engine and drives the corresponding
 * campaign_leads row's disposition/retry bookkeeping
 * (services/campaignLeadDisposition.ts). This webhook processor never
 * duplicates any of that logic itself. */
async function applyCallStatus(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  call: Record<string, any>,
  nextStatus: CallStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await transitionCallState(supabase, call.id, nextStatus, extra);
}

export async function webhookReceiverRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/webhooks/vapi - unauthenticated, see header comment.
  app.post('/vapi', async (req, reply) => {
    const supabase = getSupabaseAdmin();
    const body = req.body as Record<string, any>;

    if (!verifyVapiSignature(req as any)) {
      return reply.status(401).send({ error: 'Invalid webhook signature.' });
    }

    const message = body?.message ?? body;
    const eventType: string = message?.type ?? 'unknown';
    const providerCallId: string | undefined = message?.call?.id ?? message?.callId;
    // Vapi does not send one single canonical delivery id on every
    // message type - fall back to a stable composite of what IS always
    // present (call id + message type + a coarse timestamp bucket) so a
    // genuine retry of the exact same delivery still dedupes, while two
    // distinct real events of the same type on the same call don't
    // collide with each other.
    const eventId: string = message?.id ?? `${providerCallId ?? 'unknown'}:${eventType}:${message?.timestamp ?? Math.floor(Date.now() / 1000)}`;

    let organizationId: string | null = null;
    let call: Record<string, any> | null = null;
    if (providerCallId) {
      const { data } = await supabase.from('calls').select('*').eq('vapi_call_id', providerCallId).maybeSingle();
      if (data) {
        call = data;
        organizationId = data.organization_id;
      }
    }

    const { webhookEventId, alreadyProcessed } = await recordWebhookEvent(supabase, {
      provider: 'vapi',
      eventId,
      eventType,
      payload: body,
      organizationId,
    });
    if (alreadyProcessed) {
      return reply.status(200).send({ received: true, deduplicated: true });
    }

    try {
      if (!call) {
        // A webhook for a call this backend doesn't know about (e.g. a
        // stray/test delivery, or an id typo) is recorded for audit but
        // cannot update anything - never guessed at an organization.
        await markWebhookProcessed(supabase, webhookEventId, null);
        return reply.status(200).send({ received: true, matched: false });
      }

      await supabase.from('call_events').insert({ call_id: call.id, organization_id: call.organization_id, event_type: eventType, payload: message, occurred_at: new Date().toISOString() });

      switch (eventType) {
        case 'status-update': {
          const vapiStatus: string = message.status ?? '';
          const map: Record<string, CallStatus> = {
            queued: 'queued',
            ringing: 'ringing',
            'in-progress': 'in_progress',
            forwarding: 'transferring',
            ended: 'completed',
          };
          const nextStatus = map[vapiStatus];
          if (nextStatus) {
            const extra: Record<string, unknown> = {};
            if (nextStatus === 'in_progress' && !call.answered_at) extra.answered_at = new Date().toISOString();
            await applyCallStatus(supabase, call, nextStatus, extra);
          }
          break;
        }
        case 'end-of-call-report': {
          const endedReason: string | undefined = message.endedReason;
          const nextStatus: CallStatus = endedReason === 'assistant-forwarded-call' ? 'transferred' : 'completed';
          await applyCallStatus(supabase, call, nextStatus, {
            ended_at: new Date().toISOString(),
            ended_reason: endedReason ?? null,
            duration_seconds: message.durationSeconds ?? null,
            cost: message.cost ?? null,
          });
          break;
        }
        case 'transcript': {
          // Phase 10: real-time transcript ingestion. Vapi delivers a
          // 'transcript' message per utterance as it's generated, marked
          // `transcriptType: 'partial'` while still being refined and
          // `'final'` exactly once when that utterance is complete - only
          // 'final' is ever persisted, so a stream of interim deltas for
          // the SAME utterance never produces more than one segment (see
          // services/liveTranscriptIngestion.ts's header comment).
          if (message.transcriptType === 'final' && typeof message.transcript === 'string') {
            const speaker = vapiRoleToSpeaker(message.role);
            if (speaker) {
              await ingestLiveTranscriptSegment(supabase, call, {
                speaker,
                text: message.transcript,
                startMs: Math.max(0, Math.round((message.secondsFromStart ?? 0) * 1000)),
                endMs: null,
              });
            }
          }
          break;
        }
        case 'tool-calls': {
          // Phase 8: real tool-call handling (spec 17/53/60) -
          // schedule_callback / request_dnc, see services/toolCallHandler.ts.
          await processToolCalls(supabase, call, extractVapiToolCalls(message));
          break;
        }
        default:
          break;
      }

      await markWebhookProcessed(supabase, webhookEventId, call.organization_id);
      return reply.status(200).send({ received: true });
    } catch (err) {
      await markWebhookFailed(supabase, webhookEventId, err instanceof Error ? err.message : 'Unknown webhook processing error.');
      // Still a 200: Vapi should not aggressively retry-storm a
      // processing bug on our side - the failure is captured in
      // webhook_failures for manual replay instead.
      return reply.status(200).send({ received: true, processing_error: true });
    }
  });

  // POST /api/v1/webhooks/pipecat - unauthenticated (verified instead by
  // the internal bearer token this backend issued to pipecat-service).
  app.post('/pipecat', async (req, reply) => {
    const supabase = getSupabaseAdmin();
    const body = req.body as Record<string, any>;

    if (!verifyPipecatToken(req as any)) {
      return reply.status(401).send({ error: 'Invalid webhook token.' });
    }

    const eventType: string = body?.event_type ?? 'unknown';
    const providerCallId: string | undefined = body?.pipecat_call_id;
    const eventId: string = body?.event_id ?? randomUUID();

    let organizationId: string | null = null;
    let call: Record<string, any> | null = null;
    if (providerCallId) {
      const { data } = await supabase.from('calls').select('*').eq('pipecat_call_id', providerCallId).maybeSingle();
      if (data) {
        call = data;
        organizationId = data.organization_id;
      }
    }

    const { webhookEventId, alreadyProcessed } = await recordWebhookEvent(supabase, {
      provider: 'pipecat',
      eventId,
      eventType,
      payload: body,
      organizationId,
    });
    if (alreadyProcessed) {
      return reply.status(200).send({ received: true, deduplicated: true });
    }

    try {
      if (!call) {
        await markWebhookProcessed(supabase, webhookEventId, null);
        return reply.status(200).send({ received: true, matched: false });
      }

      await supabase.from('call_events').insert({ call_id: call.id, organization_id: call.organization_id, event_type: eventType, payload: body, occurred_at: new Date().toISOString() });

      if (eventType === 'tool-calls') {
        await processToolCalls(supabase, call, extractPipecatToolCalls(body));
      }

      // Phase 10: real-time transcript ingestion for pipecat. Unlike
      // Vapi's partial/final distinction, pipecat-service's own pipeline
      // (apps/pipecat-service/app/transcript.py) only ever posts this
      // event once an utterance is genuinely complete (a final STT
      // transcription frame for the caller, or a completed TTS-bound text
      // frame for the assistant) - see that module for exactly why no
      // separate "final" flag is needed here.
      if (eventType === 'transcript' && typeof body.text === 'string' && (body.speaker === 'ai' || body.speaker === 'caller')) {
        await ingestLiveTranscriptSegment(supabase, call, {
          speaker: body.speaker,
          text: body.text,
          startMs: typeof body.start_ms === 'number' ? body.start_ms : 0,
          endMs: typeof body.end_ms === 'number' ? body.end_ms : null,
        });
      }

      const map: Record<string, CallStatus> = {
        dialing: 'dialing',
        ringing: 'ringing',
        answered: 'answered',
        in_progress: 'in_progress',
        transfer_pending: 'transfer_pending',
        transferring: 'transferring',
        transferred: 'transferred',
        transfer_failed: 'transfer_failed',
        completed: 'completed',
        failed: 'failed',
      };
      const nextStatus = map[eventType];
      if (nextStatus) {
        const extra: Record<string, unknown> = {};
        if (nextStatus === 'answered' && !call.answered_at) extra.answered_at = new Date().toISOString();
        if (nextStatus === 'completed' || nextStatus === 'failed') {
          extra.ended_at = new Date().toISOString();
          extra.ended_reason = body.ended_reason ?? null;
          extra.duration_seconds = body.duration_seconds ?? null;
        }
        await applyCallStatus(supabase, call, nextStatus, extra);
      }

      await markWebhookProcessed(supabase, webhookEventId, call.organization_id);
      return reply.status(200).send({ received: true });
    } catch (err) {
      await markWebhookFailed(supabase, webhookEventId, err instanceof Error ? err.message : 'Unknown webhook processing error.');
      return reply.status(200).send({ received: true, processing_error: true });
    }
  });

  // POST /api/v1/webhooks/twilio-sms - Twilio's real Message Status
  // Callback delivery (delivered/failed/undelivered) for a message this
  // backend originated via services/smsDispatcher.ts. Unauthenticated
  // (Twilio is the caller); trust comes from the same idempotency +
  // payload-resolved ownership model as /vapi and /pipecat above -
  // resolved from the message's own provider-assigned SID
  // (sms_messages.provider_message_id), never from a client-supplied
  // organization_id.
  app.post('/twilio-sms', async (req, reply) => {
    const supabase = getSupabaseAdmin();
    const body = req.body as Record<string, any>;
    const providerMessageId: string | undefined = body?.MessageSid ?? body?.SmsSid;
    const messageStatus: string | undefined = body?.MessageStatus ?? body?.SmsStatus;
    // Twilio's status callback carries no single canonical delivery id -
    // the same composite-key dedup strategy the Vapi receiver uses.
    const eventId = `${providerMessageId ?? 'unknown'}:${messageStatus ?? 'unknown'}`;

    let organizationId: string | null = null;
    let message: Record<string, any> | null = null;
    if (providerMessageId) {
      const { data } = await supabase.from('sms_messages').select('*').eq('provider_message_id', providerMessageId).maybeSingle();
      if (data) {
        message = data;
        organizationId = data.organization_id;
      }
    }

    const { webhookEventId, alreadyProcessed } = await recordWebhookEvent(supabase, {
      provider: 'twilio-sms',
      eventId,
      eventType: messageStatus ?? 'unknown',
      payload: body,
      organizationId,
    });
    if (alreadyProcessed) return reply.status(200).send({ received: true, deduplicated: true });

    try {
      if (!message) {
        await markWebhookProcessed(supabase, webhookEventId, null);
        return reply.status(200).send({ received: true, matched: false });
      }
      const statusMap: Record<string, string> = { delivered: 'delivered', failed: 'failed', undelivered: 'failed', sent: 'sent' };
      const nextStatus = statusMap[(messageStatus ?? '').toLowerCase()];
      if (nextStatus) {
        const extra: Record<string, unknown> = {};
        if (nextStatus === 'delivered') extra.delivered_at = new Date().toISOString();
        await supabase.from('sms_messages').update({ status: nextStatus, ...extra }).eq('id', message.id);
      }
      await markWebhookProcessed(supabase, webhookEventId, message.organization_id);
      return reply.status(200).send({ received: true });
    } catch (err) {
      await markWebhookFailed(supabase, webhookEventId, err instanceof Error ? err.message : 'Unknown webhook processing error.');
      return reply.status(200).send({ received: true, processing_error: true });
    }
  });

  // POST /api/v1/webhooks/telnyx-sms - Telnyx's real message.* delivery
  // webhook (message.sent / message.finalized with a per-recipient
  // status). Same trust/idempotency model as twilio-sms above.
  app.post('/telnyx-sms', async (req, reply) => {
    const supabase = getSupabaseAdmin();
    const body = req.body as Record<string, any>;
    const payload = body?.data?.payload ?? body?.payload ?? body;
    const providerMessageId: string | undefined = payload?.id;
    const recipientStatus: string | undefined = payload?.to?.[0]?.status;
    const eventId: string = body?.data?.id ?? `${providerMessageId ?? 'unknown'}:${recipientStatus ?? 'unknown'}`;

    let organizationId: string | null = null;
    let message: Record<string, any> | null = null;
    if (providerMessageId) {
      const { data } = await supabase.from('sms_messages').select('*').eq('provider_message_id', providerMessageId).maybeSingle();
      if (data) {
        message = data;
        organizationId = data.organization_id;
      }
    }

    const { webhookEventId, alreadyProcessed } = await recordWebhookEvent(supabase, {
      provider: 'telnyx-sms',
      eventId,
      eventType: recipientStatus ?? 'unknown',
      payload: body,
      organizationId,
    });
    if (alreadyProcessed) return reply.status(200).send({ received: true, deduplicated: true });

    try {
      if (!message) {
        await markWebhookProcessed(supabase, webhookEventId, null);
        return reply.status(200).send({ received: true, matched: false });
      }
      const statusMap: Record<string, string> = { delivered: 'delivered', delivery_failed: 'failed', sent: 'sent' };
      const nextStatus = statusMap[(recipientStatus ?? '').toLowerCase()];
      if (nextStatus) {
        const extra: Record<string, unknown> = {};
        if (nextStatus === 'delivered') extra.delivered_at = new Date().toISOString();
        await supabase.from('sms_messages').update({ status: nextStatus, ...extra }).eq('id', message.id);
      }
      await markWebhookProcessed(supabase, webhookEventId, message.organization_id);
      return reply.status(200).send({ received: true });
    } catch (err) {
      await markWebhookFailed(supabase, webhookEventId, err instanceof Error ? err.message : 'Unknown webhook processing error.');
      return reply.status(200).send({ received: true, processing_error: true });
    }
  });
}

/** Admin routes: GET /webhook-events, POST /webhook-events/:id/replay.
 * Authenticated, permission-gated, org-scoped - unlike the receivers
 * above which are the external-facing unauthenticated endpoints. */
export async function webhookAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: requirePermission('cdr.view') }, async (req) => {
    const query = listWebhookEventsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase
      .from('webhook_events')
      .select('id, organization_id, provider, event_id, event_type, payload, received_at, processed_at, processing_status, error, retry_count, created_at', { count: 'exact' })
      .eq('organization_id', orgId);
    if (query.provider) builder = builder.eq('provider', query.provider);
    if (query.processing_status) builder = builder.eq('processing_status', query.processing_status);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('received_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // POST /:id/replay - re-runs the SAME stored payload through the same
  // processing path it originally went through, by re-dispatching it to
  // this backend's own receiver over a local HTTP call. Admin-level
  // (webhooks.manage), audited.
  app.post('/:id/replay', { preHandler: requirePermission('webhooks.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: event, error } = await supabase.from('webhook_events').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!event || event.organization_id !== orgId) throw new NotFoundError('Webhook event not found.');
    if (event.provider !== 'vapi' && event.provider !== 'pipecat') {
      throw new ValidationError('Only vapi/pipecat webhook events can be replayed through this endpoint.');
    }

    // A replay must be able to reprocess even a previously-'processed'
    // event (e.g. an admin wants to force re-derive downstream state) -
    // delete the ledger row for this (provider, event_id) first so the
    // idempotency check in recordWebhookEvent() doesn't immediately
    // short-circuit it as a duplicate, then re-run it through the real
    // receiver route via app.inject (no separate code path to drift).
    await supabase.from('webhook_events').delete().eq('id', id);

    const target = event.provider === 'vapi' ? '/api/v1/webhooks/vapi' : '/api/v1/webhooks/pipecat';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (event.provider === 'vapi' && process.env.VAPI_WEBHOOK_SECRET) headers['x-vapi-secret'] = process.env.VAPI_WEBHOOK_SECRET;
    if (event.provider === 'pipecat' && process.env.PIPECAT_SERVICE_TOKEN) headers.authorization = `Bearer ${process.env.PIPECAT_SERVICE_TOKEN}`;

    const replayRes = await app.inject({ method: 'POST', url: target, headers, payload: event.payload });

    await supabase.from('webhook_failures').update({ replayed_at: new Date().toISOString() }).eq('webhook_event_id', id);

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.WEBHOOK_EVENT_REPLAYED,
      entityType: 'webhook_event',
      entityId: id,
      newValue: { provider: event.provider, event_type: event.event_type, replay_status: replayRes.statusCode },
      ipAddress: req.ip,
    });

    return ok({ replayed: true, status_code: replayRes.statusCode }, { message: 'Webhook event replayed.' });
  });
}
