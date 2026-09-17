/**
 * Phase 6: call orchestration provider abstraction (master spec sections
 * 8E/18/19/30/31, plus the explicit ask to add pipecat as a second, real,
 * self-hosted engine alongside Vapi).
 *
 * Mirrors lib/llm/types.ts, lib/voice/types.ts and lib/telephony/types.ts's
 * shape exactly: an adapter interface plus typed "not configured" vs
 * "provider error" exceptions that routes map to honest, never-fabricated
 * API responses.
 *
 * Per spec section 101, a call/assistant provider id (Vapi's
 * assistant/call id, pipecat's own call id) is NEVER a separate identity
 * space - every call and every published agent version resolves to
 * exactly one internal row (calls / ai_agent_versions). The engine
 * (`CallOrchestrationProviderKey`) is a property stored on that row, not a
 * different kind of record. See routes/calls.ts and
 * lib/orchestration/index.ts.
 *
 * Two adapters implement this interface:
 *  - VapiProvider: a real Vapi REST API integration (managed engine).
 *  - PipecatProvider: a thin HTTP client (TypeScript) against
 *    apps/pipecat-service, a separate self-hosted Python/FastAPI service
 *    that runs the actual real-time voice pipeline using the pipecat-ai
 *    package. See apps/pipecat-service/README.md for exactly how call
 *    origination is split between Node and Python and why.
 */

export type CallOrchestrationProviderKey = 'vapi' | 'pipecat';

/** Thrown when a provider cannot run at all - no credentials configured
 * for this org (Vapi), or the self-hosted pipecat-service has no
 * telephony/LLM/STT/TTS credentials of its own configured. Routes map
 * this to an honest 422, exactly like every other adapter family. */
export class OrchestrationProviderNotConfiguredError extends Error {
  constructor(message = 'This call orchestration engine is not configured.') {
    super(message);
    this.name = 'OrchestrationProviderNotConfiguredError';
  }
}

/** Thrown for any other provider-side failure (network error, non-2xx
 * response, malformed payload) - never a simulated/fabricated result. */
export class OrchestrationProviderError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'OrchestrationProviderError';
  }
}

/** Thrown when a caller tries to transfer a call to a destination that was
 * not resolved server-side from the campaign/agent's own stored config.
 * Hard rule from spec section 19/8L: the AI (or any caller) must never
 * invent or supply a transfer destination - this exception exists so the
 * rule fails loudly instead of silently trusting a client-provided value. */
export class InvalidTransferDestinationError extends Error {
  constructor(message = 'Transfer destination must be a pre-validated E.164 number resolved from server-side configuration.') {
    super(message);
    this.name = 'InvalidTransferDestinationError';
  }
}

export interface AssistantConfig {
  /** Internal ids so createAssistant()/updateAssistant() can attribute
   * provider-side objects back to the one internal identity even before
   * the caller persists the returned provider id. */
  agentId: string;
  agentVersionId: string;
  organizationId: string;
  name: string;
  systemPrompt: string;
  greeting: string;
  /** Personality traits folded into the system prompt/instructions per
   * engine convention - see each adapter for exactly how. */
  personality: { tone: string | null; personality_traits: string[]; behavior_traits: string[] };
  llmProvider: string;
  llmModel: string;
  llmTemperature: number;
  llmMaxTokens: number;
  voice: {
    providerKey: string;
    providerVoiceId: string;
  } | null;
  transferRules: { on_no_match: string; transfer_to: string | null; conditions: string[] };
  maxCallDurationSeconds: number | null;
}

export interface AssistantResult {
  /** The engine's own assistant id - stored on ai_agent_versions as
   * vapi_assistant_id (Vapi) or unused (pipecat builds its pipeline
   * per-call from the local ai_agent_versions row directly, so it has no
   * separate provider-side assistant object - see PipecatProvider's
   * class doc). */
  providerAssistantId: string;
}

/** Transient, single-use carrier credentials for the PIPECAT engine only -
 * resolved and decrypted by routes/calls.ts from Phase 5's existing
 * per-org encrypted storage, then forwarded once over the private network
 * to pipecat-service so IT can place the actual outbound Twilio/Telnyx
 * call and wire up the media stream. pipecat-service never stores these -
 * see PipecatProvider's class doc for exactly why this is the chosen
 * split between "don't duplicate credential storage" and "don't hand
 * pipecat-service a long-lived credential of its own". Vapi never uses
 * this field - Vapi originates calls itself once a number is imported
 * into it. */
export interface TransientTelephonyCredentials {
  provider: 'twilio' | 'telnyx';
  accountSid?: string;
  authToken?: string;
  apiKey?: string;
}

export interface CreateCallParams {
  callId: string; // internal calls.id, created BEFORE the provider call per spec 72
  organizationId: string;
  providerAssistantId: string | null; // Vapi only
  agentVersionId: string;
  fromPhoneNumber: string; // E.164, must already be imported/owned on the engine
  fromPhoneNumberProviderId: string | null; // Vapi's imported phone-number id, when applicable
  toPhoneNumber: string; // E.164 customer number
  /** Pre-validated, server-resolved E.164 transfer destination for this
   * call (from the agent/campaign's own config) - never client-supplied.
   * Null when the agent has no transfer destination configured. */
  transferDestinationE164: string | null;
  /** pipecat only - see TransientTelephonyCredentials's doc. */
  telephonyCredentials?: TransientTelephonyCredentials | null;
}

export interface CreateCallResult {
  providerCallId: string;
  status: string;
}

export interface CallArtifacts {
  recordingUrl: string | null;
  transcriptUrl: string | null;
  transcript: string | null;
}

export interface LiveMonitorUrls {
  listenUrl: string | null;
  controlUrl: string | null;
  /** Whisper/barge are both driven through controlUrl on Vapi's real
   * mechanism - kept as a single flag so callers know whether whisper/
   * barge control messages can be sent at all, rather than assuming
   * controlUrl alone implies it. */
  supportsWhisperBarge: boolean;
}

export interface CallOrchestrationProvider {
  readonly key: CallOrchestrationProviderKey;
  readonly name: string;
  readonly isConfigured: boolean;

  createAssistant(config: AssistantConfig): Promise<AssistantResult>;
  updateAssistant(providerAssistantId: string, config: AssistantConfig): Promise<AssistantResult>;
  createCall(params: CreateCallParams): Promise<CreateCallResult>;
  getCall(providerCallId: string): Promise<{ status: string; raw: Record<string, unknown> }>;
  endCall(providerCallId: string): Promise<void>;
  /** destinationE164 must already be the server-resolved, pre-validated
   * number - see InvalidTransferDestinationError's doc. Adapters
   * themselves also re-validate the format defensively. */
  transferCall(providerCallId: string, destinationE164: string): Promise<void>;
  getArtifacts(providerCallId: string): Promise<CallArtifacts>;
  getTranscript(providerCallId: string): Promise<string | null>;
  getRecording(providerCallId: string): Promise<string | null>;
  getLiveMonitorUrls(providerCallId: string): Promise<LiveMonitorUrls>;
  registerWebhook(url: string): Promise<void>;
}
