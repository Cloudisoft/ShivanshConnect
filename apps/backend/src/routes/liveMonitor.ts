/**
 * Phase 10: Live Monitor supervisor actions (master spec sections 18/19).
 *
 *   POST /calls/:id/listen   - live_monitor.listen
 *   POST /calls/:id/whisper  - live_monitor.whisper
 *   POST /calls/:id/barge    - live_monitor.barge
 *   POST /calls/:id/transfer - live_monitor.barge (supervisor transfer is
 *                              a supervisor-tier action; reuses the same
 *                              permission tier as barge/whisper rather
 *                              than a brand new key, since the Phase 1
 *                              catalog seeded only listen/barge/whisper
 *                              for this module - see permission.ts)
 *   POST /calls/:id/end      - live_monitor.barge (same reasoning)
 *
 * Every handler: (1) requires the stated permission, (2) loads the call
 * and asserts it belongs to the caller's own organization (never trusts
 * :id alone - the single biggest privilege-escalation vector this module
 * has to close, per the task brief), (3) writes an audit log entry naming
 * exactly who did what to which call and when.
 *
 * VAPI vs PIPECAT - how listen/whisper/barge actually differ and why:
 *
 * Vapi is a managed engine we do not run - the only real-time hooks it
 * exposes are `call.monitor.listenUrl` (a read-only WSS PCM stream) and
 * `call.monitor.controlUrl` (an HTTP endpoint accepting control messages,
 * of which 'say' and 'transfer-call' are the two this codebase uses).
 * There is no distinct "whisper to the human agent only" primitive in
 * Vapi's public API, because there IS no human agent on a separate leg -
 * the "agent" on a Vapi call is Vapi's own AI. So here:
 *   - listen  -> returns the real listenUrl verbatim.
 *   - whisper -> posts a real 'say' control message (VapiProvider.say()) -
 *     text becomes real synthesized speech IN the live call, audible to
 *     the caller (Vapi has no way to make it inaudible). This is the
 *     closest real, honest equivalent to whisper Vapi's API offers -
 *     never fabricated as something quieter than it is.
 *   - barge   -> the "honest composition" the task brief calls for: the
 *     supervisor's /listen channel plus the same 'say' mechanism used
 *     simultaneously. No separate Vapi API call exists for "barge" as its
 *     own primitive - this route documents that explicitly rather than
 *     inventing one.
 *
 * pipecat is OUR OWN pipeline (apps/pipecat-service) - real three-way
 * audio mixing is genuinely implementable there, so:
 *   - listen  -> a real supervisor audio-tap WebSocket
 *     (apps/pipecat-service/app/supervisor.py) that mirrors live call
 *     audio frames to the connected client - not a stub.
 *   - whisper -> a real control-channel WS message
 *     (`whisper_audio`/`whisper_text`) a custom pipecat FrameProcessor
 *     injects into the pipeline's outbound leg only, never reaching the
 *     transport the caller hears (see pipeline.py's SupervisorAudioNode).
 *   - barge   -> a control-channel WS session (`barge_start`/audio
 *     frames/`barge_end`) that mixes the supervisor's live mic audio into
 *     BOTH legs (the caller hears it, the supervisor hears the AI+caller
 *     mix) - real frame-level mixing, not a no-op.
 * In every pipecat case, this Node route's job is only to mint a
 * short-lived, call-and-action-scoped token (lib/pipecatSupervisorToken.ts)
 * and hand back the pipecat-service WS URL - the browser client connects
 * DIRECTLY to pipecat-service for the actual audio, exactly the same
 * shape as Vapi's own listenUrl being a direct-to-Vapi WSS URL.
 */
import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { whisperCallSchema, bargeCallSchema, supervisorTransferCallSchema } from '../schemas/liveMonitor.js';
import { resolveProviderForCall } from '../lib/orchestration/resolveProvider.js';
import { VapiProvider } from '../lib/orchestration/vapi.js';
import { OrchestrationProviderError, OrchestrationProviderNotConfiguredError } from '../lib/orchestration/types.js';
import { signSupervisorToken, type SupervisorTokenAction } from '../lib/pipecatSupervisorToken.js';
import { transitionCallState } from '../lib/callStateMachine.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

async function loadOwnCall(supabase: ReturnType<typeof getSupabaseAdmin>, id: string, orgId: string): Promise<Record<string, any>> {
  uuidSchema.parse(id);
  const { data: call, error } = await supabase.from('calls').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  // A call that exists but belongs to a different organization is
  // treated identically to one that doesn't exist at all - never leaks
  // its existence to a caller from another org.
  if (!call || call.organization_id !== orgId) throw new NotFoundError('Call not found.');
  return call;
}

function pipecatWsUrl(pipecatCallId: string, action: SupervisorTokenAction): { ws_url: string; token: string } {
  const base = process.env.PIPECAT_SERVICE_URL;
  if (!base) {
    throw new OrchestrationProviderNotConfiguredError('The pipecat self-hosted engine is not configured (PIPECAT_SERVICE_URL is unset).');
  }
  const wsBase = base.trim().replace(/\/$/, '').replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return { ws_url: `${wsBase}/supervisor/${encodeURIComponent(pipecatCallId)}/${action}`, token: '' };
}

export async function liveMonitorActionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // POST /api/v1/calls/:id/listen
  app.post('/:id/listen', { preHandler: requirePermission('live_monitor.listen') }, async (req) => {
    const { id } = req.params as { id: string };
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const call = await loadOwnCall(supabase, id, orgId);

    let result: { engine: 'vapi' | 'pipecat'; ws_url: string; token?: string; supports_whisper_barge: boolean };
    if (call.engine === 'vapi') {
      if (!call.vapi_call_id) throw new ValidationError('This call has no Vapi call id yet.');
      const provider = (await resolveProviderForCall(supabase, call)) as VapiProvider;
      const urls = await provider.getLiveMonitorUrls(call.vapi_call_id);
      if (!urls.listenUrl) throw new ValidationError('This call has no active listen URL - it may have already ended.');
      result = { engine: 'vapi', ws_url: urls.listenUrl, supports_whisper_barge: urls.supportsWhisperBarge };
    } else {
      if (!call.pipecat_call_id) throw new ValidationError('This call has no pipecat call id yet.');
      const { ws_url } = pipecatWsUrl(call.pipecat_call_id, 'listen');
      const token = signSupervisorToken({ pipecat_call_id: call.pipecat_call_id, action: 'listen', organization_id: orgId });
      result = { engine: 'pipecat', ws_url, token, supports_whisper_barge: true };
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CALL_LISTEN_STARTED,
      entityType: 'call',
      entityId: id,
      newValue: { engine: call.engine },
      ipAddress: req.ip,
    });

    return ok(result, { message: 'Listen channel ready.' });
  });

  // POST /api/v1/calls/:id/whisper
  app.post('/:id/whisper', { preHandler: requirePermission('live_monitor.whisper') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = whisperCallSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const call = await loadOwnCall(supabase, id, orgId);

    let result: Record<string, unknown>;
    if (call.engine === 'vapi') {
      if (!call.vapi_call_id) throw new ValidationError('This call has no Vapi call id yet.');
      if (body.action === 'end') {
        // Nothing to "end" on Vapi - see this file's header comment: a
        // whisper here is a single discrete 'say' control message, not a
        // held-open channel. Honest no-op response rather than a
        // fabricated session teardown.
        result = { engine: 'vapi', ended: true };
      } else {
        if (!body.text) throw new ValidationError('text is required to whisper on a Vapi call.');
        const provider = (await resolveProviderForCall(supabase, call)) as VapiProvider;
        await provider.say(call.vapi_call_id, body.text);
        result = { engine: 'vapi', sent: true, audible_to_caller: true };
      }
    } else {
      if (!call.pipecat_call_id) throw new ValidationError('This call has no pipecat call id yet.');
      const { ws_url } = pipecatWsUrl(call.pipecat_call_id, 'whisper');
      const token = signSupervisorToken({ pipecat_call_id: call.pipecat_call_id, action: 'whisper', organization_id: orgId });
      result = { engine: 'pipecat', ws_url, token, note: 'Connect to ws_url and send whisper_text/whisper_audio control frames - see apps/pipecat-service/app/supervisor.py.' };
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: body.action === 'end' ? AUDIT_ACTIONS.CALL_WHISPER_ENDED : AUDIT_ACTIONS.CALL_WHISPER_MESSAGE_SENT,
      entityType: 'call',
      entityId: id,
      newValue: { engine: call.engine, action: body.action, text: body.text ?? null },
      ipAddress: req.ip,
    });

    return ok(result, { message: 'Whisper action processed.' });
  });

  // POST /api/v1/calls/:id/barge
  app.post('/:id/barge', { preHandler: requirePermission('live_monitor.barge') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = bargeCallSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const call = await loadOwnCall(supabase, id, orgId);

    let result: Record<string, unknown>;
    if (call.engine === 'vapi') {
      if (!call.vapi_call_id) throw new ValidationError('This call has no Vapi call id yet.');
      if (body.action === 'end') {
        result = { engine: 'vapi', ended: true };
      } else {
        const provider = (await resolveProviderForCall(supabase, call)) as VapiProvider;
        const urls = await provider.getLiveMonitorUrls(call.vapi_call_id);
        if (!urls.listenUrl) throw new ValidationError('This call has no active listen URL - it may have already ended.');
        // Honest composition, not a fabricated capability - see this
        // file's header comment. The supervisor opens listenUrl for the
        // "hear both sides" half of barge, then uses POST .../whisper's
        // same 'say' mechanism for the "speak into the call" half.
        result = {
          engine: 'vapi',
          mode: 'listen_plus_say',
          ws_url: urls.listenUrl,
          note: "Vapi has no distinct barge primitive - this composes the real listen stream with the real 'say' control message (use POST /whisper to speak while barged in).",
        };
      }
    } else {
      if (!call.pipecat_call_id) throw new ValidationError('This call has no pipecat call id yet.');
      const { ws_url } = pipecatWsUrl(call.pipecat_call_id, 'barge');
      const token = signSupervisorToken({ pipecat_call_id: call.pipecat_call_id, action: 'barge', organization_id: orgId });
      result = { engine: 'pipecat', mode: 'three_way_mix', ws_url, token, note: 'Real three-way audio mixing - see apps/pipecat-service/app/supervisor.py + pipeline.py.' };
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: body.action === 'end' ? AUDIT_ACTIONS.CALL_BARGE_ENDED : AUDIT_ACTIONS.CALL_BARGE_STARTED,
      entityType: 'call',
      entityId: id,
      newValue: { engine: call.engine, action: body.action },
      ipAddress: req.ip,
    });

    return ok(result, { message: 'Barge action processed.' });
  });

  // POST /api/v1/calls/:id/transfer - supervisor-triggered manual
  // transfer (as opposed to the AI-initiated flow, which never comes
  // through this route - see calls.transfer_initiated_by).
  app.post('/:id/transfer', { preHandler: requirePermission('live_monitor.barge') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = supervisorTransferCallSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const call = await loadOwnCall(supabase, id, orgId);

    if (!call.transfer_destination_e164) {
      throw new ValidationError('This call has no transfer destination configured - nothing to transfer to.');
    }
    // Hard rule (spec 19/8L): the destination is never freely editable -
    // it must match exactly what was resolved server-side from the
    // campaign/agent's own configuration at call-creation time.
    if (body.destination_e164 !== call.transfer_destination_e164) {
      throw new ValidationError('destination_e164 must match this call\'s configured transfer destination.');
    }

    const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
    if (!providerCallId) throw new ValidationError('This call has no active provider call id.');

    const transitionResult = await transitionCallState(supabase, call.id, 'transfer_pending', {
      transfer_status: 'pending',
      transfer_initiated_by: 'supervisor',
    });
    if (!transitionResult.applied && transitionResult.reason === 'invalid_transition') {
      throw new ValidationError(`Cannot transfer a call in status "${call.status}".`);
    }

    const provider = await resolveProviderForCall(supabase, call);
    try {
      await provider.transferCall(providerCallId, body.destination_e164);
    } catch (err) {
      await supabase.from('calls').update({ transfer_status: 'failed' }).eq('id', call.id);
      throw err;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CALL_TRANSFER_SUPERVISOR_INITIATED,
      entityType: 'call',
      entityId: id,
      newValue: { destination_e164: body.destination_e164, initiated_by: 'supervisor' },
      ipAddress: req.ip,
    });

    return ok({ transferring: true, destination_e164: body.destination_e164 }, { message: 'Transfer initiated.' });
  });

  // POST /api/v1/calls/:id/end - supervisor force-ends a live call.
  app.post('/:id/end', { preHandler: requirePermission('live_monitor.barge') }, async (req) => {
    const { id } = req.params as { id: string };
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const call = await loadOwnCall(supabase, id, orgId);

    const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
    if (!providerCallId) throw new ValidationError('This call has no active provider call id.');

    const provider = await resolveProviderForCall(supabase, call);
    try {
      await provider.endCall(providerCallId);
    } catch (err) {
      // A "call already ended" error from the provider is not a failure
      // of intent (the supervisor wanted it ended, and it is ended) -
      // still surface genuine provider errors (network, auth) honestly.
      if (!(err instanceof OrchestrationProviderError)) throw err;
    }

    // Don't leave this entirely to the engine's own webhook - a lost or
    // delayed delivery would otherwise strand this call showing "live"
    // forever, with the supervisor having no way to clear it even though
    // they explicitly asked for it to end (this route previously trusted
    // the webhook exclusively). The supervisor's own action is authoritative
    // here: transition to 'completed' locally right away. If the real
    // end-of-call-report webhook still arrives afterward, it's a no-op
    // against this now-terminal status - never double-applied. A call
    // already terminal (or one whose current status has no direct path to
    // 'completed') just leaves this as the harmless no-op it already is.
    await transitionCallState(supabase, call.id, 'completed', {
      ended_at: new Date().toISOString(),
      ended_reason: 'supervisor_ended',
    });

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CALL_ENDED_BY_SUPERVISOR,
      entityType: 'call',
      entityId: id,
      newValue: { engine: call.engine },
      ipAddress: req.ip,
    });

    return ok({ ended: true }, { message: 'Call ended.' });
  });
}
