/**
 * Phase 6: real Vapi REST API integration (managed call orchestration
 * engine). Uses an org-level `VAPI_API_KEY`-style bearer token (stored
 * encrypted per-org in vapi_credentials, decrypted and passed in by the
 * route layer - see routes/vapi.ts, the same per-org-credential pattern
 * as lib/voice and lib/telephony rather than a single process-wide key,
 * though the constructor still falls back to process.env.VAPI_API_KEY for
 * local/dev parity with every other adapter in this codebase).
 *
 * Endpoints used (Vapi's real, current documented REST API as of this
 * build - https://docs.vapi.ai/api-reference):
 *   POST   /assistant                       - create an assistant
 *   PATCH  /assistant/{id}                  - update an assistant
 *   POST   /phone-number                    - import/link a number (Twilio
 *                                              byo-phone-number by
 *                                              account/auth or SID, or
 *                                              byo-sip-trunk for BYON)
 *   POST   /call                            - create an outbound call
 *   GET    /call/{id}                       - get call status/artifacts
 *   POST   /call/{id}/hangup                - end a call (Vapi models this
 *                                              as updating the call to
 *                                              ended, exposed as a control
 *                                              message over the call's own
 *                                              control URL when live, or a
 *                                              hangup shortcut otherwise)
 *   POST   {call.monitor.controlUrl}        - transfer-call / say control
 *                                              messages while the call is
 *                                              live (see transferCall())
 *   PATCH  /org (or /assistant server config) - registers the webhook
 *                                              (server) URL Vapi POSTs
 *                                              call events to.
 *
 * Live monitoring: Vapi exposes `call.monitor.listenUrl` (a WSS PCM audio
 * stream, read-only) and `call.monitor.controlUrl` (an HTTP endpoint that
 * accepts control messages - say / transfer / mute-assistant / etc, which
 * is what whisper and barge-in are built from) directly on the call
 * object returned by POST /call and GET /call/{id} - getLiveMonitorUrls()
 * simply relays those two fields; no separate "start monitoring" API call
 * exists to make.
 *
 * If VAPI_API_KEY (or the org's decrypted credential) is unset, every
 * method throws OrchestrationProviderNotConfiguredError immediately -
 * never a fabricated assistant/call.
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

const VAPI_API_BASE = 'https://api.vapi.ai';

interface VapiArtifactMessage {
  role?: string; // 'assistant' | 'bot' | 'user' | 'customer' | ...
  message?: string;
  /** Vapi's real per-message offset from call start, in seconds. */
  secondsFromStart?: number;
  endSecondsFromStart?: number;
}

interface VapiCallObject {
  id: string;
  status: string;
  endedReason?: string;
  monitor?: { listenUrl?: string; controlUrl?: string };
  artifact?: { recordingUrl?: string; transcript?: string; transcriptUrl?: string; messages?: VapiArtifactMessage[] };
  messages?: VapiArtifactMessage[];
  cost?: number;
  startedAt?: string;
  endedAt?: string;
}

/** Maps Vapi's real per-message role strings to our two-party speaker
 * enum. Anything not recognized as the customer side is treated as the
 * AI side (Vapi's own roles for the assistant vary: 'assistant', 'bot',
 * 'system' framing lines are filtered out entirely). Returns null for a
 * role that carries no actual spoken content (e.g. 'system' or 'tool'). */
export function vapiRoleToSpeaker(role: string | undefined): 'ai' | 'caller' | null {
  const normalized = (role ?? '').toLowerCase();
  if (normalized === 'user' || normalized === 'customer') return 'caller';
  if (normalized === 'assistant' || normalized === 'bot') return 'ai';
  return null;
}

function toSegments(messages: VapiArtifactMessage[] | undefined): TranscriptSegmentRaw[] | null {
  if (!messages || messages.length === 0) return null;
  const segments: TranscriptSegmentRaw[] = [];
  for (const m of messages) {
    const speaker = vapiRoleToSpeaker(m.role);
    if (!speaker || !m.message) continue;
    segments.push({
      speaker,
      startMs: Math.max(0, Math.round((m.secondsFromStart ?? 0) * 1000)),
      endMs: m.endSecondsFromStart != null ? Math.round(m.endSecondsFromStart * 1000) : null,
      text: m.message,
    });
  }
  return segments.length > 0 ? segments : null;
}

export class VapiProvider implements CallOrchestrationProvider {
  readonly key = 'vapi' as const;
  readonly name = 'Vapi';
  private readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined = process.env.VAPI_API_KEY) {
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new OrchestrationProviderNotConfiguredError(
        'Vapi is not connected for this organization. Add a Vapi API key under Settings > Integrations first.',
      );
    }
    return this.apiKey;
  }

  private headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const apiKey = this.requireApiKey();
    let res: Response;
    try {
      res = await fetch(`${VAPI_API_BASE}${path}`, {
        method,
        headers: this.headers(apiKey),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new OrchestrationProviderError(`Failed to reach the Vapi API (${method} ${path}).`, err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OrchestrationProviderError(`Vapi request failed (${res.status} ${method} ${path}): ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Maps our internal AssistantConfig into Vapi's real assistant creation
   * payload shape: model (LLM provider/model/messages/temperature),
   * voice (provider + voiceId), firstMessage (greeting),
   * forwardingPhoneNumber (transfer_to, when configured) and
   * maxDurationSeconds. */
  private toVapiAssistantPayload(config: AssistantConfig): Record<string, unknown> {
    const traitLines = [
      config.personality.tone ? `Tone: ${config.personality.tone}.` : null,
      config.personality.personality_traits.length ? `Personality traits: ${config.personality.personality_traits.join(', ')}.` : null,
      config.personality.behavior_traits.length ? `Behavior: ${config.personality.behavior_traits.join(', ')}.` : null,
    ].filter(Boolean);
    const systemContent = [config.systemPrompt, ...traitLines].join('\n\n');

    const payload: Record<string, unknown> = {
      name: config.name,
      firstMessage: config.greeting,
      model: {
        provider: config.llmProvider,
        model: config.llmModel,
        temperature: config.llmTemperature,
        maxTokens: config.llmMaxTokens,
        messages: [{ role: 'system', content: systemContent }],
      },
      metadata: { agentId: config.agentId, agentVersionId: config.agentVersionId, organizationId: config.organizationId },
    };

    if (config.voice) {
      payload.voice = { provider: config.voice.providerKey, voiceId: config.voice.providerVoiceId };
    }
    if (config.maxCallDurationSeconds) {
      payload.maxDurationSeconds = config.maxCallDurationSeconds;
    }
    // The transfer destination itself is never sent here as a free-form
    // AI-chosen value - it is exposed to the assistant only as a
    // server-controlled tool target that createCall()/transferCall()
    // ultimately resolve to a pre-validated E.164 number, never invented
    // by the model (spec 19/8L).
    if (config.transferRules.transfer_to) {
      payload.forwardingPhoneNumber = config.transferRules.transfer_to;
    }

    return payload;
  }

  /** Lightweight authenticated read used purely to verify a stored API
   * key actually works (POST /vapi/test-connection) - lists at most one
   * assistant, the cheapest real read Vapi's API offers. */
  async ping(): Promise<void> {
    await this.request('GET', '/assistant?limit=1');
  }

  async createAssistant(config: AssistantConfig): Promise<AssistantResult> {
    const payload = this.toVapiAssistantPayload(config);
    const created = await this.request<{ id: string }>('POST', '/assistant', payload);
    return { providerAssistantId: created.id };
  }

  async updateAssistant(providerAssistantId: string, config: AssistantConfig): Promise<AssistantResult> {
    const payload = this.toVapiAssistantPayload(config);
    const updated = await this.request<{ id: string }>('PATCH', `/assistant/${encodeURIComponent(providerAssistantId)}`, payload);
    return { providerAssistantId: updated.id };
  }

  /** Imports/links a phone number into Vapi so it can originate/receive
   * calls through this engine - Vapi's real `POST /phone-number` endpoint.
   * `twilio` links by accountSid/authToken + the E.164 number; `byo-sip-
   * trunk` links a BYON SIP-declared number by its trunk credentials. This
   * must succeed (or already exist) before createCall() can use the
   * number. */
  async importPhoneNumber(input: {
    provider: 'twilio' | 'telnyx' | 'byo-sip-trunk';
    e164: string;
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    telnyxApiKey?: string;
    sipTrunkGatewayHost?: string;
  }): Promise<{ vapiPhoneNumberId: string }> {
    const payload: Record<string, unknown> = { number: input.e164 };
    if (input.provider === 'twilio') {
      payload.provider = 'twilio';
      payload.twilioAccountSid = input.twilioAccountSid;
      payload.twilioAuthToken = input.twilioAuthToken;
    } else if (input.provider === 'telnyx') {
      payload.provider = 'telnyx';
      payload.credentialId = input.telnyxApiKey; // Vapi requires a pre-registered Telnyx credential id
    } else {
      payload.provider = 'byo-phone-number';
      payload.numberE164CheckEnabled = true;
      payload.sipUri = input.sipTrunkGatewayHost ? `sip:${input.e164}@${input.sipTrunkGatewayHost}` : undefined;
    }
    const created = await this.request<{ id: string }>('POST', '/phone-number', payload);
    return { vapiPhoneNumberId: created.id };
  }

  async createCall(params: CreateCallParams): Promise<CreateCallResult> {
    if (!params.providerAssistantId) {
      throw new OrchestrationProviderError('Vapi calls require a published assistant (providerAssistantId) - publish the agent version first.');
    }
    if (!params.fromPhoneNumberProviderId) {
      throw new OrchestrationProviderError(
        'This phone number has not been imported into Vapi yet - import it via importPhoneNumber() before placing a call with it.',
      );
    }
    const payload: Record<string, unknown> = {
      assistantId: params.providerAssistantId,
      phoneNumberId: params.fromPhoneNumberProviderId,
      customer: { number: params.toPhoneNumber },
      metadata: { internalCallId: params.callId, organizationId: params.organizationId },
    };
    const created = await this.request<VapiCallObject>('POST', '/call', payload);
    return { providerCallId: created.id, status: created.status };
  }

  async getCall(providerCallId: string): Promise<{ status: string; raw: Record<string, unknown> }> {
    const call = await this.request<VapiCallObject>('GET', `/call/${encodeURIComponent(providerCallId)}`);
    return { status: call.status, raw: call as unknown as Record<string, unknown> };
  }

  async endCall(providerCallId: string): Promise<void> {
    await this.request('POST', `/call/${encodeURIComponent(providerCallId)}/hangup`, {});
  }

  /** Real transfer mechanism: Vapi accepts a "transfer-call" control
   * message posted to the live call's own monitor.controlUrl. destinationE164
   * is validated as strict E.164 defensively here too, on top of the
   * caller (routes/calls.ts) only ever passing a server-resolved value -
   * this adapter never accepts a free-form/AI-authored string. */
  async transferCall(providerCallId: string, destinationE164: string): Promise<void> {
    if (!/^\+[1-9]\d{6,14}$/.test(destinationE164)) {
      throw new OrchestrationProviderError(`Refusing to transfer to a non-E.164 destination: ${destinationE164}`);
    }
    const call = await this.request<VapiCallObject>('GET', `/call/${encodeURIComponent(providerCallId)}`);
    if (!call.monitor?.controlUrl) {
      throw new OrchestrationProviderError('This call has no active control URL - it may have already ended.');
    }
    let res: Response;
    try {
      res = await fetch(call.monitor.controlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'transfer-call', destination: { type: 'number', number: destinationE164 } }),
      });
    } catch (err) {
      throw new OrchestrationProviderError('Failed to reach the Vapi call control URL for transfer.', err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OrchestrationProviderError(`Vapi transfer-call control message failed (${res.status}): ${text.slice(0, 500)}`);
    }
  }

  /**
   * Phase 10: posts a real 'say' control message to the live call's own
   * monitor.controlUrl - Vapi's real, current documented mechanism for
   * injecting speech into an in-progress call (the same control channel
   * transferCall() above uses for 'transfer-call'). This IS the
   * "whisper" primitive routes/liveMonitor.ts's POST /calls/:id/whisper
   * uses for Vapi calls.
   *
   * HONEST LIMITATION (see routes/liveMonitor.ts's header comment for the
   * full writeup): Vapi's public API has no separate "whisper-only-to-the-
   * assistant, inaudible to the caller" channel, because the "agent" on a
   * Vapi call is Vapi's own AI, not a human on a distinct leg the way a
   * traditional contact-center whisper targets. The 'say' message is
   * therefore audible on the live call to whoever is connected, exactly
   * as it would be if the assistant itself said it. This module never
   * pretends otherwise - "whisper" and "barge" on Vapi both reduce to
   * this same real control-plane call; the only difference the barge
   * action documents is that the supervisor's own /listen audio channel
   * is also open at the same time (see getLiveMonitorUrls()/barge
   * handling in routes/liveMonitor.ts).
   */
  async say(providerCallId: string, text: string): Promise<void> {
    const call = await this.request<VapiCallObject>('GET', `/call/${encodeURIComponent(providerCallId)}`);
    if (!call.monitor?.controlUrl) {
      throw new OrchestrationProviderError('This call has no active control URL - it may have already ended.');
    }
    let res: Response;
    try {
      res = await fetch(call.monitor.controlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'say', message: text }),
      });
    } catch (err) {
      throw new OrchestrationProviderError('Failed to reach the Vapi call control URL for say/whisper.', err);
    }
    if (!res.ok) {
      const text2 = await res.text().catch(() => '');
      throw new OrchestrationProviderError(`Vapi say control message failed (${res.status}): ${text2.slice(0, 500)}`);
    }
  }

  async getArtifacts(providerCallId: string): Promise<CallArtifacts> {
    const call = await this.request<VapiCallObject>('GET', `/call/${encodeURIComponent(providerCallId)}`);
    return {
      recordingUrl: call.artifact?.recordingUrl ?? null,
      transcriptUrl: call.artifact?.transcriptUrl ?? null,
      transcript: call.artifact?.transcript ?? null,
      segments: toSegments(call.artifact?.messages ?? call.messages),
    };
  }

  async getTranscript(providerCallId: string): Promise<string | null> {
    return (await this.getArtifacts(providerCallId)).transcript;
  }

  async getRecording(providerCallId: string): Promise<string | null> {
    return (await this.getArtifacts(providerCallId)).recordingUrl;
  }

  async getLiveMonitorUrls(providerCallId: string): Promise<LiveMonitorUrls> {
    const call = await this.request<VapiCallObject>('GET', `/call/${encodeURIComponent(providerCallId)}`);
    return {
      listenUrl: call.monitor?.listenUrl ?? null,
      controlUrl: call.monitor?.controlUrl ?? null,
      supportsWhisperBarge: Boolean(call.monitor?.controlUrl),
    };
  }

  /** Vapi delivers webhook events per-assistant (assistant.serverUrl) or
   * account-wide (org server URL). This backend registers the account-wide
   * default so every assistant's events land on the same receiver without
   * having to set it per-assistant on every createAssistant() call. */
  async registerWebhook(url: string): Promise<void> {
    await this.request('PATCH', '/org', { server: { url } });
  }
}
