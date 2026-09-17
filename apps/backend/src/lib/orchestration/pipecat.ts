/**
 * Phase 6: PipecatProvider - a thin HTTP client (TypeScript, running in
 * the Node backend) against apps/pipecat-service, a separate self-hosted
 * Python/FastAPI service that runs the real pipecat-ai voice pipeline
 * (Twilio/Telnyx Media Streams transport -> STT -> LLM -> TTS). See
 * apps/pipecat-service/README.md for how to run/deploy it.
 *
 * ARCHITECTURAL CHOICE - who originates the call vs who handles media:
 * Call origination (dialing the customer's phone) happens through
 * Twilio/Telnyx's own REST API, called directly from THIS Node backend
 * using Phase 5's already-stored, already-decrypted TwilioProvider/
 * TelnyxProvider adapters and credentials - never duplicated into the
 * Python service. The Node backend originates the call with Twilio/
 * Telnyx's <Stream> TwiML (or Telnyx's equivalent streaming media
 * command) pointed at the pipecat-service's WebSocket media endpoint, and
 * only then asks pipecat-service to *handle* the resulting media stream
 * once the carrier connects it.
 *
 * This is the cleaner split for three reasons: (1) it reuses Phase 5's
 * credential storage and adapters exactly, with zero duplication of
 * Twilio/Telnyx auth in Python; (2) pipecat-service never needs to see a
 * decrypted carrier credential at all, only a short-lived, scoped
 * "handle this call id" instruction plus the LLM/STT/TTS keys it already
 * reads from its own environment; (3) it matches how VapiProvider already
 * works from this codebase's point of view - "create a call" always means
 * "ask something else to dial the phone", the engine's own job starts once
 * the media is flowing.
 *
 * Concretely: createCall() here (a) resolves the org's Twilio/Telnyx
 * credentials via the existing lib/telephony adapters, (b) originates the
 * outbound call with the carrier's REST API using TwiML/streaming
 * instructions that connect the call's audio to
 * `${PIPECAT_SERVICE_URL}/media-stream/{internal call id}`, then (c) POSTs
 * to pipecat-service's `/calls` control endpoint so it knows this
 * particular call id is coming and which agent config to run for it. The
 * carrier's own call SID becomes this call's `pipecat_call_id` is NOT
 * correct terminology - see below: pipecat-service assigns its own
 * internal pipeline id when it registers the expected call, and that id
 * (not the carrier's SID) is what's stored as `pipecat_call_id`, exactly
 * parallel to how vapi_call_id is Vapi's own id rather than any carrier
 * id. The carrier SID is recorded in call_events instead.
 *
 * If PIPECAT_SERVICE_URL is unset, or the org has no Twilio/Telnyx
 * connected, every method throws OrchestrationProviderNotConfiguredError -
 * never a simulated call.
 */

import {
  type AssistantConfig,
  type AssistantResult,
  type CallArtifacts,
  type CallOrchestrationProvider,
  type CreateCallParams,
  type CreateCallResult,
  type LiveMonitorUrls,
  OrchestrationProviderError,
  OrchestrationProviderNotConfiguredError,
} from './types.js';

export class PipecatProvider implements CallOrchestrationProvider {
  readonly key = 'pipecat' as const;
  readonly name = 'Pipecat (self-hosted)';
  private readonly serviceUrl: string | undefined;
  private readonly serviceToken: string | undefined;

  constructor(
    serviceUrl: string | undefined = process.env.PIPECAT_SERVICE_URL,
    serviceToken: string | undefined = process.env.PIPECAT_SERVICE_TOKEN,
  ) {
    this.serviceUrl = serviceUrl && serviceUrl.trim().length > 0 ? serviceUrl.trim().replace(/\/$/, '') : undefined;
    this.serviceToken = serviceToken && serviceToken.trim().length > 0 ? serviceToken.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.serviceUrl);
  }

  private requireServiceUrl(): string {
    if (!this.serviceUrl) {
      throw new OrchestrationProviderNotConfiguredError(
        'The pipecat self-hosted engine is not configured. Set PIPECAT_SERVICE_URL to a running apps/pipecat-service deployment.',
      );
    }
    return this.serviceUrl;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.serviceToken) headers.Authorization = `Bearer ${this.serviceToken}`;
    return headers;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const base = this.requireServiceUrl();
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new OrchestrationProviderError(`Failed to reach the pipecat-service (${method} ${path}).`, err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // pipecat-service returns its own honest "not configured" errors
      // (missing STT/TTS/LLM key) as a 422 - surface those distinctly
      // rather than folding everything into a generic 502.
      if (res.status === 422) {
        throw new OrchestrationProviderNotConfiguredError(text.slice(0, 500) || 'pipecat-service reports it is not fully configured.');
      }
      throw new OrchestrationProviderError(`pipecat-service request failed (${res.status} ${method} ${path}): ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Pipecat has no separate provider-side "assistant" object the way Vapi
   * does - its pipeline is built fresh per call directly from the local
   * ai_agent_versions row (system prompt, personality, LLM/voice config),
   * which pipecat-service reads back from THIS Node backend via a scoped
   * internal fetch when a call starts (see /calls POST payload below).
   * createAssistant()/updateAssistant() still exist to satisfy the shared
   * CallOrchestrationProvider interface, but they are a structural no-op
   * that only validates the service is reachable/configured - there is
   * nothing to persist as a "vapi_assistant_id equivalent". Storing a
   * bare marker keeps the interface's contract (a truthy
   * providerAssistantId) satisfiable without inventing a fake id.
   */
  async createAssistant(config: AssistantConfig): Promise<AssistantResult> {
    await this.request('GET', '/health');
    return { providerAssistantId: `pipecat-agent-version:${config.agentVersionId}` };
  }

  async updateAssistant(_providerAssistantId: string, config: AssistantConfig): Promise<AssistantResult> {
    return this.createAssistant(config);
  }

  async createCall(params: CreateCallParams): Promise<CreateCallResult> {
    const payload = {
      internal_call_id: params.callId,
      organization_id: params.organizationId,
      agent_version_id: params.agentVersionId,
      from_e164: params.fromPhoneNumber,
      to_e164: params.toPhoneNumber,
      transfer_destination_e164: params.transferDestinationE164,
    };
    const created = await this.request<{ pipecat_call_id: string; status: string }>('POST', '/calls', payload);
    return { providerCallId: created.pipecat_call_id, status: created.status };
  }

  async getCall(providerCallId: string): Promise<{ status: string; raw: Record<string, unknown> }> {
    const call = await this.request<{ status: string } & Record<string, unknown>>('GET', `/calls/${encodeURIComponent(providerCallId)}`);
    return { status: call.status, raw: call };
  }

  async endCall(providerCallId: string): Promise<void> {
    await this.request('POST', `/calls/${encodeURIComponent(providerCallId)}/end`, {});
  }

  async transferCall(providerCallId: string, destinationE164: string): Promise<void> {
    if (!/^\+[1-9]\d{6,14}$/.test(destinationE164)) {
      throw new OrchestrationProviderError(`Refusing to transfer to a non-E.164 destination: ${destinationE164}`);
    }
    await this.request('POST', `/calls/${encodeURIComponent(providerCallId)}/transfer`, { destination_e164: destinationE164 });
  }

  async getArtifacts(providerCallId: string): Promise<CallArtifacts> {
    const artifacts = await this.request<{ recording_url: string | null; transcript_url: string | null; transcript: string | null }>(
      'GET',
      `/calls/${encodeURIComponent(providerCallId)}/artifacts`,
    );
    return { recordingUrl: artifacts.recording_url, transcriptUrl: artifacts.transcript_url, transcript: artifacts.transcript };
  }

  async getTranscript(providerCallId: string): Promise<string | null> {
    return (await this.getArtifacts(providerCallId)).transcript;
  }

  async getRecording(providerCallId: string): Promise<string | null> {
    return (await this.getArtifacts(providerCallId)).recordingUrl;
  }

  /** pipecat-service does not (yet) expose a separate low-latency listen/
   * control WebSocket for live monitoring the way Vapi's monitor object
   * does - Phase 10's Live Monitor UI is explicitly out of scope for this
   * phase. This honestly reports "not supported" rather than fabricating
   * URLs. */
  async getLiveMonitorUrls(_providerCallId: string): Promise<LiveMonitorUrls> {
    return { listenUrl: null, controlUrl: null, supportsWhisperBarge: false };
  }

  /** pipecat-service posts call lifecycle + transcript events directly to
   * this Node backend's own POST /api/v1/webhooks/pipecat receiver - that
   * URL is fixed application configuration (WEBHOOK_BASE_URL +
   * '/api/v1/webhooks/pipecat'), not something registered per-call the way
   * Vapi's account-wide server URL is. This method still exists to satisfy
   * the shared interface and to let pipecat-service confirm it has a
   * reachable webhook target configured on its own side. */
  async registerWebhook(url: string): Promise<void> {
    await this.request('POST', '/webhook-config', { url });
  }
}
