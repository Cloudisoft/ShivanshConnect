/**
 * Phase 6: PipecatProvider - a thin HTTP client (TypeScript, running in
 * the Node backend) against apps/pipecat-service, a separate self-hosted
 * Python/FastAPI service that runs the real pipecat-ai voice pipeline
 * (Twilio/Telnyx Media Streams transport -> STT -> LLM -> TTS). See
 * apps/pipecat-service/README.md for how to run/deploy it.
 *
 * ARCHITECTURAL CHOICE - who originates the call vs who handles media:
 * The spec brief offered two options: (a) pipecat-service calls back to
 * Node for a short-lived scoped credential fetch, or (b) Node originates
 * the call itself and only asks pipecat-service to handle the resulting
 * media stream. This codebase uses a variant of (a) that avoids adding a
 * whole extra Node<->Python callback round trip: routes/calls.ts resolves
 * and decrypts the org's Twilio/Telnyx credentials using Phase 5's
 * EXISTING adapters/storage (zero duplication - nothing new is ever
 * persisted), then forwards them ONCE, transiently, in this single
 * createCall() request body (see CreateCallParams.telephonyCredentials).
 * pipecat-service uses them exactly once, synchronously, to place the
 * real outbound call via the carrier's own REST API and open a Media
 * Streams WebSocket back to itself - it never stores or logs them. This
 * is the practical shape of "a short-lived, scoped credential fetch" here:
 * scoped to a single call, short-lived because it's used and discarded in
 * the same request, and it needed no separate callback endpoint on Node
 * because createCall() already carries everything else needed to place
 * this specific call.
 *
 * pipecat-service assigns its OWN internal pipeline id to the call - that
 * id (not the carrier's Twilio/Telnyx call SID) is what's returned here
 * and stored as `calls.pipecat_call_id`, exactly parallel to how
 * `vapi_call_id` is Vapi's own id rather than any carrier id. The
 * carrier's own SID is recorded in call_events instead (see
 * apps/pipecat-service's own event posting).
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
  type TranscriptSegmentRaw,
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
    if (!params.telephonyCredentials) {
      throw new OrchestrationProviderNotConfiguredError(
        'The pipecat engine needs this organization\'s Twilio or Telnyx credentials to place a call - connect one under Phone Providers first.',
      );
    }
    const payload = {
      internal_call_id: params.callId,
      organization_id: params.organizationId,
      agent_version_id: params.agentVersionId,
      from_e164: params.fromPhoneNumber,
      to_e164: params.toPhoneNumber,
      transfer_destination_e164: params.transferDestinationE164,
      // Transient, single-use - see this file's header comment. Never
      // logged by this client, and pipecat-service is documented to
      // discard it immediately after placing the call.
      telephony: {
        provider: params.telephonyCredentials.provider,
        account_sid: params.telephonyCredentials.accountSid,
        auth_token: params.telephonyCredentials.authToken,
        api_key: params.telephonyCredentials.apiKey,
      },
      // Same per-call personalization fix as VapiProvider.createCall()'s
      // assistantOverrides (see that method's comment / callOrigination.ts's
      // resolveCallPersonalization()): pipecat already builds its
      // system-prompt/greeting per call directly from the local
      // ai_agent_versions row it fetches back from this backend, so these
      // are forwarded as an explicit override pipecat-service is
      // documented to prefer over re-deriving an unpersonalized one -
      // keeps both engines behaviorally consistent for named-vs-unnamed
      // lead greetings. Omitted (undefined) when the caller resolved no
      // override, so pipecat-service falls back to its own default
      // per-call construction unchanged.
      first_message_override: params.firstMessageOverride ?? undefined,
      system_prompt_override: params.systemPromptOverride ?? undefined,
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
    const artifacts = await this.request<{
      recording_url: string | null;
      transcript_url: string | null;
      transcript: string | null;
      // Optional - pipecat-service exposes this only when it has real
      // per-utterance STT timing to report; absent (undefined/null) is
      // treated the same as "no structured segments", never fabricated.
      segments?: Array<{ speaker: 'ai' | 'caller'; start_ms: number; end_ms: number | null; text: string }> | null;
    }>('GET', `/calls/${encodeURIComponent(providerCallId)}/artifacts`);
    const segments: TranscriptSegmentRaw[] | null = artifacts.segments?.length
      ? artifacts.segments.map((s) => ({ speaker: s.speaker, startMs: s.start_ms, endMs: s.end_ms, text: s.text }))
      : null;
    return { recordingUrl: artifacts.recording_url, transcriptUrl: artifacts.transcript_url, transcript: artifacts.transcript, segments };
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
