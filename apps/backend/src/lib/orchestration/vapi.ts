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
 *   POST   {call.monitor.controlUrl}        - end-call / transfer / say control
 *                                              messages while the call is
 *                                              live (see transferCall())
 *   PATCH  /assistant/{id} (server: {url})  - registers the webhook
 *                                              (server) URL Vapi POSTs
 *                                              call events to. Vapi has
 *                                              NO account-wide webhook
 *                                              API endpoint - PATCH /org
 *                                              does not exist (confirmed
 *                                              404 against the real API);
 *                                              the org-level default can
 *                                              only be set by hand in the
 *                                              Vapi dashboard's General
 *                                              Settings. The only real,
 *                                              API-reachable mechanism is
 *                                              a `server.url` set directly
 *                                              on each assistant, so this
 *                                              is threaded through every
 *                                              createAssistant()/
 *                                              updateAssistant() call (see
 *                                              toVapiAssistantPayload)
 *                                              and backfilled onto every
 *                                              already-existing assistant
 *                                              by registerWebhook() below.
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

import { CONVERSATION_GUIDANCE, personalityLines } from '../callGuidance.js';

const VAPI_REQUEST_TIMEOUT_MS = 20_000;
/** Webhook events every call must send: call status, the end-of-call
 * report, live transcripts (partial and final - Live Monitor) and tool calls. */
const SERVER_MESSAGES = ['status-update', 'end-of-call-report', 'transcript', 'tool-calls'];
/** A dead line (nobody speaking) is hung up after this long. */
const SILENCE_TIMEOUT_SECONDS = 20;
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

/** Derives the webhook URL Vapi should POST call events to from
 * BACKEND_PUBLIC_URL, or null when it's unset (in which case webhook
 * registration is skipped rather than sending a garbage/local URL to
 * Vapi - see env.ts's doc comment on BACKEND_PUBLIC_URL). Reads
 * process.env directly rather than the shared getEnv() - this adapter is
 * unit-tested in isolation from the rest of the app's required env vars
 * (SUPABASE_URL etc.), and getEnv()'s schema validation would throw for
 * those tests; env.ts's own schema still validates BACKEND_PUBLIC_URL as
 * a real URL at app startup, so a malformed value never reaches here in
 * production. */
function vapiWebhookUrl(): string | null {
  const raw = process.env.BACKEND_PUBLIC_URL;
  if (!raw) return null;
  return `${raw.replace(/\/+$/, '')}/api/v1/webhooks/vapi`;
}

/** Appended to every assistant's system prompt (toVapiAssistantPayload
 * below) regardless of what an individual agent's own configured prompt
 * says - a durable, platform-wide fix rather than something each agent's
 * author has to remember to write themselves. Covers the recurring,
 * concrete complaints this addresses: sounding like a script being read
 * rather than a real conversation, talking over what the caller just
 * said instead of responding to it, wasting turns having an "unnecessary
 * conversation" with an automated IVR menu instead of navigating it
 * tersely, and failing to recognize a voicemail greeting on its own as a
 * fallback when Vapi's own voicemailDetection doesn't fire. */
/** Vapi's documented stopSpeakingPlan: how much caller speech it takes to
 * interrupt the assistant mid-sentence. numWords: 0 (Vapi's own default)
 * stops the assistant the instant the caller starts talking, like a real
 * person would - explicitly requested ("it should cut off... I want to make
 * calls natural") after a brief numWords: 2 experiment meant a one-word
 * "wait"/"no" could no longer interrupt. Vapi's built-in default
 * acknowledgement phrases still keep pure backchannels ("uh-huh", "okay")
 * from cutting it off. Sent explicitly per call (not just left to the
 * default) so any assistant published during that numWords: 2 window is
 * overridden too. */
const STOP_SPEAKING_PLAN = { numWords: 0 };

/** Vapi's documented startSpeakingPlan: when the caller has finished their
 * turn. Was `smartEndpointingPlan: { provider: 'vapi' }`; Vapi's own API
 * spec now says "We strongly recommend using livekit endpointing when
 * working in English". Production per-turn data showed the old one
 * ending the caller's turn mid-sentence - "Yes. It's" -> the assistant
 * jumped in, so the caller never got to finish saying their name and the
 * assistant asked for it again ("asking for the name again and again, not
 * listening"). Sent per call too, so it applies without a republish. */
/** Voicemail detection, per report: "calls don't detect VMs properly and
 * keep talking with VM". Was OpenAI's transcript-based detector, which only
 * decides once enough words have been transcribed and first checked 2.5s
 * in; Vapi's own detector listens to the audio itself (greeting cadence,
 * beep) and is Vapi's recommended provider. It checks from 2.5s and every
 * 2.5s after (Vapi rejects anything under 2.5s with a 400, which failed
 * every campaign call on 29 Sep 18:18-18:30 UTC), for about 15s - a
 * voicemail greeting is caught while it is still playing. When it fires the call is hung up. Voicemails it
 * still misses are caught from the transcript by
 * services/voicemailBackstop.ts. */
export const VOICEMAIL_DETECTION_PLAN = {
  provider: 'vapi',
  backoffPlan: { startAtSeconds: 2.5, frequencySeconds: 2.5, maxRetries: 5 },
  beepMaxAwaitSeconds: 20,
};

/** Per explicit request: "just detect the VM and then drop the VM, nothing
 * more". Every campaign call detects voicemail and hangs up the moment it
 * is detected - no voicemail message is ever left (Vapi hangs up on
 * detection when no voicemailMessage is set), whatever the campaign's old
 * voicemail settings say. Calls outside a campaign (vm null) are left as
 * they were. */
export function voicemailSettings(vm: AssistantConfig['voicemailDetection'] | undefined): Record<string, unknown> {
  if (!vm) return {};
  return { voicemailDetection: VOICEMAIL_DETECTION_PLAN };
}

const START_SPEAKING_PLAN = { waitSeconds: 0.4, smartEndpointingPlan: { provider: 'livekit' } };

/** Vapi's documented artifactPlan (verified against Vapi's own published
 * OpenAPI spec, api.vapi.ai/api-json). Real production incident: 0 of
 * 108 calls in a 3-hour window had a recording - every one failed with
 * the recording URL returning 400 "InvalidArgument: Authorization". The
 * org's Vapi account has a custom Cloudflare R2 storage credential
 * configured, so Vapi uploaded every recording to that PRIVATE bucket and
 * returned its raw, unsigned object URL, which nothing without the
 * bucket's own keys can download. recordingUseCustomStorageEnabled: false
 * alone did NOT fix it (the account stores recordings in a private
 * "hipaa-recordings" bucket either way), so getArtifacts() also returns
 * Vapi's authenticated GET /call/{id}/mono-recording download (302 to a
 * short-lived signed URL), which processCallArtifacts.ts uses; it then
 * re-stores the bytes in this platform's own storage, so nothing depends
 * on Vapi keeping them. recordingEnabled: true is Vapi's default, set
 * explicitly per explicit request: recordings for every call. */
const ARTIFACT_PLAN = { recordingEnabled: true, recordingUseCustomStorageEnabled: false };

/** Vapi's built-in office ambience (CreateAssistantDTO/AssistantOverrides
 * backgroundSound: 'off' | 'office' | audio URL). */
const BACKGROUND_SOUND = 'office';

/** Appended to the per-call system prompt whenever the call has a
 * transfer destination - the model must actually invoke the tool, not
 * just announce it. */
export const TRANSFER_TOOL_INSTRUCTION =
  "\n\nCall transfer: when the caller should be transferred (they ask for a person, or your instructions say to transfer), say one short sentence such as \"Sure, transferring you now.\" and call the transferCall tool in that same reply. Never say you are transferring without calling transferCall, and never ask the caller to hold or wait first.";

/** Vapi's real transferCall tool (CreateTransferCallToolDTO) for one
 * server-resolved E.164 destination. Blind transfer, and no extra
 * scripted line (message: '') - the assistant's own "transferring you
 * now" is the only thing said before the caller is connected. */
export function buildTransferTool(destinationE164: string): Record<string, unknown> {
  return {
    type: 'transferCall',
    destinations: [{ type: 'number', number: destinationE164, message: '' }],
    messages: [{ type: 'request-start', content: '', blocking: false }],
  };
}

/** Function tools answered by this backend's tool-calls webhook
 * (services/toolCallHandler.ts). They had real handlers since Phase 8 but
 * were never declared on any call, so the model could not use them:
 * schedule_callback (the caller asks to be called back later) and
 * request_dnc (the caller asks not to be called again). */
export function buildCallControlTools(serverUrl: string | null): Record<string, unknown>[] {
  const withServer = (tool: Record<string, unknown>) => (serverUrl ? { ...tool, server: { url: serverUrl } } : tool);
  return [
    withServer({
      type: 'function',
      function: {
        name: 'schedule_callback',
        description:
          'Schedule a callback when the caller asks to be called back later. Agree on a specific date and time with the caller first and confirm it back to them, then call this.',
        parameters: {
          type: 'object',
          properties: {
            scheduled_at: {
              type: 'string',
              description: "The agreed callback time as an ISO 8601 timestamp with the caller's UTC offset, e.g. 2026-09-30T15:00:00-04:00.",
            },
            timezone: { type: 'string', description: "The caller's IANA timezone if known, e.g. America/New_York." },
            reason: { type: 'string', description: 'Why they want a callback.' },
            notes: { type: 'string', description: 'Anything else worth remembering for the callback.' },
          },
          required: ['scheduled_at'],
        },
      },
      messages: [{ type: 'request-start', content: '', blocking: false }],
    }),
    withServer({
      type: 'function',
      function: {
        name: 'request_dnc',
        description: 'Use only when the caller explicitly asks not to be called again. Adds their number to the Do Not Call list.',
        parameters: {
          type: 'object',
          properties: { reason: { type: 'string', description: 'What the caller said.' } },
          required: [],
        },
      },
      messages: [{ type: 'request-start', content: '', blocking: false }],
    }),
  ];
}

/** Saves the caller's details (inbound calls): creates or updates their
 * lead record - see services/toolCallHandler.ts save_caller_details. */
export function buildCallerDetailsTool(serverUrl: string | null): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'function',
    function: {
      name: 'save_caller_details',
      description:
        "Save the caller's details as soon as you learn them: name, best phone number, email and the purpose of their call. Call it again whenever you learn more.",
      parameters: {
        type: 'object',
        properties: {
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          phone: { type: 'string', description: 'Best number to reach them, if different from the number they are calling from.' },
          email: { type: 'string' },
          purpose: { type: 'string', description: 'Why they are calling, in a short sentence.' },
          notes: { type: 'string' },
        },
        required: [],
      },
    },
    messages: [{ type: 'request-start', content: '', blocking: false }],
  };
  if (serverUrl) tool.server = { url: serverUrl };
  return tool;
}

/** Function tool the model calls to look things up in the campaign's
 * knowledge base mid-call. Answered synchronously by routes/webhooks.ts
 * (tool-calls -> services/toolCallHandler.ts search_knowledge_base). */
export function buildKnowledgeBaseTool(serverUrl: string | null): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'function',
    function: {
      name: 'search_knowledge_base',
      description:
        "Look up facts in this company's knowledge base (services, process, eligibility, timelines, costs, FAQs). Call it whenever the caller asks something specific you aren't certain of from your instructions.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: "A short search query for what the caller wants to know." } },
        required: ['query'],
      },
    },
    // Silent lookup - the assistant just answers once the result is back.
    messages: [{ type: 'request-start', content: '', blocking: false }],
  };
  if (serverUrl) tool.server = { url: serverUrl };
  return tool;
}


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

/** Our internal voice provider_key values (packages/shared/src/voice.ts's
 * VOICE_PROVIDER_KEYS) don't all match Vapi's own `voice.provider` enum
 * string-for-string - ElevenLabs is the clearest mismatch (our
 * 'elevenlabs' vs Vapi's real 'eleven11labs'-family value '11labs'),
 * which is exactly what sending providerKey straight through as Vapi's
 * `voice.provider` produced: a hard 400 rejecting the whole assistant
 * creation ("voice.provider must be one of the following values: vapi,
 * 11labs, azure, cartesia, ..."). Cartesia's key happens to already
 * match Vapi's enum, so it silently worked; ElevenLabs never could.
 * OmniVoice/VoxCPM (VOICE_PROVIDER_CATALOG's requiresExternalHosting:
 * true) are self-hosted TTS servers Vapi has no native provider for at
 * all - making those work would need Vapi's separate "custom-voice"
 * integration (a server URL Vapi calls to synthesize audio, not a
 * voiceId), which isn't implemented, so they fail fast here with an
 * actionable message instead of reproducing this same opaque 400. */
const VAPI_VOICE_PROVIDER_MAP: Record<string, string> = {
  elevenlabs: '11labs',
  cartesia: 'cartesia',
};

function mapToVapiVoiceProvider(providerKey: string): string {
  const mapped = VAPI_VOICE_PROVIDER_MAP[providerKey];
  if (mapped) return mapped;
  throw new OrchestrationProviderError(
    `Voices from "${providerKey}" can't be used for Vapi calls yet - Vapi has no native provider for it and this platform doesn't implement its custom-voice integration. Please select an ElevenLabs or Cartesia voice instead.`,
  );
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
        // A hung Vapi request used to hold the caller (a dispatcher tick,
        // a supervisor's click) open until the platform's own 30s cutoff.
        signal: AbortSignal.timeout(VAPI_REQUEST_TIMEOUT_MS),
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
    const traitLines = personalityLines(config.personality);
    // Baseline conversational instructions appended to every assistant's
    // system prompt, regardless of what any individual agent's own prompt
    // says - applies automatically to every existing agent the next time
    // its version is republished, and to every future one, rather than
    // needing to be pasted into each agent's prompt by hand. Real,
    // recurring problems this addresses: sounding scripted/robotic rather
    // than like a natural conversation, not acknowledging what the caller
    // actually just said before moving on, and mishandling a gatekeeper/
    // IVR system that asks for a name before connecting to a real person.
    const systemContent = [config.systemPrompt, ...traitLines, CONVERSATION_GUIDANCE].join('\n\n');

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
      // Explicitly request every webhook message type routes/webhooks.ts
      // actually handles, rather than relying on Vapi's own undocumented
      // default set - without this, Vapi may never deliver 'transcript'
      // messages at all, silently starving Live Monitor's real-time
      // transcript feed (services/liveTranscriptIngestion.ts) even though
      // everything downstream of the webhook is correctly wired.
      serverMessages: SERVER_MESSAGES,
    };

    if (config.voice) {
      payload.voice = { provider: mapToVapiVoiceProvider(config.voice.providerKey), voiceId: config.voice.providerVoiceId };
      // Real, documented Vapi voice field: without an explicit `model`,
      // Vapi falls back to each provider's own default TTS model, which is
      // NOT the fastest one available - Cartesia's default is an older
      // "sonic" model rather than the low-latency sonic-2 this platform's
      // own lib/voice/cartesia.ts already uses everywhere else (voice
      // previews, cloning), and ElevenLabs' default is a quality-optimized
      // model, not the latency-optimized Flash one. This is the single
      // biggest TTS lever on the pause between a caller finishing a
      // sentence and the assistant's reply starting to play.
      // Cartesia: sonic-3 (a newer, higher-quality generation than
      // sonic-2, listed in Vapi's own CartesiaVoice model enum) - per the
      // "voice quality is still poor" report on a Cartesia voice.
      const fastModelByProvider: Record<string, string> = {
        cartesia: 'sonic-3',
        elevenlabs: 'eleven_flash_v2_5',
      };
      const fastModel = fastModelByProvider[config.voice.providerKey];
      if (fastModel) {
        (payload.voice as Record<string, unknown>).model = fastModel;
      }
    }
    if (config.maxCallDurationSeconds) {
      payload.maxDurationSeconds = config.maxCallDurationSeconds;
    }

    // Real, currently-documented Vapi turn-taking/endpointing config
    // (docs.vapi.ai/customization/speech-configuration): waits briefly
    // after the caller stops speaking, and uses Vapi's own smart-
    // endpointing model to avoid cutting a caller off mid-sentence -
    // this is what actually makes the assistant's turn-taking feel
    // humanlike instead of firing on the first micro-pause.
    payload.startSpeakingPlan = START_SPEAKING_PLAN;
    payload.stopSpeakingPlan = STOP_SPEAKING_PLAN;
    payload.artifactPlan = ARTIFACT_PLAN;
    // Real field: ends the call if the caller goes silent for this long
    // (Vapi default is 30s; set explicitly here so a campaign never
    // leaves a call hung open indefinitely on a dead line).
    payload.silenceTimeoutSeconds = SILENCE_TIMEOUT_SECONDS;
    // Lets the assistant hang up itself once the conversation is over
    // (goodbye said, not interested, wrong number, callback booked) - it
    // had no way to, so finished calls sat open until the silence timeout.
    payload.endCallFunctionEnabled = true;

    // Per explicit request: every campaign plays Vapi's office ambience
    // behind the assistant (the campaign-level background-noise option was
    // removed). Also sent per call in createCall()'s assistantOverrides.
    payload.backgroundSound = BACKGROUND_SOUND;

    // Voicemail/answering-machine detection from the campaign's calling
    // rules - see voicemailSettings(). Also sent per call in createCall().
    Object.assign(payload, voicemailSettings(config.voicemailDetection));
    // The transfer destination itself is never sent here as a free-form
    // AI-chosen value - it is exposed to the assistant only as a
    // server-controlled tool target that createCall()/transferCall()
    // ultimately resolve to a pre-validated E.164 number, never invented
    // by the model (spec 19/8L).
    if (config.transferRules.transfer_to) {
      payload.forwardingPhoneNumber = config.transferRules.transfer_to;
    }

    // Registers this backend's webhook receiver directly on the
    // assistant - the only real, API-reachable way to do this (see this
    // file's header comment for why there's no account-wide equivalent).
    // Without it, Vapi never sends status-update/end-of-call-report/
    // transcript events for calls placed with this assistant at all.
    const webhookUrl = vapiWebhookUrl();
    if (webhookUrl) {
      payload.server = { url: webhookUrl };
    }

    return payload;
  }

  /** Lightweight authenticated read used purely to verify a stored API
   * key actually works (POST /vapi/test-connection) - lists at most one
   * assistant, the cheapest real read Vapi's API offers. */
  async ping(): Promise<void> {
    await this.request('GET', '/assistant?limit=1');
  }

  /** A complete transient assistant for one inbound call, returned in
   * response to Vapi's assistant-request webhook (see
   * services/inboundCalls.ts). Same base as a stored assistant, with the
   * call's own greeting/prompt and live tools; no voicemail detection
   * (the caller dialed us). */
  buildInboundAssistant(
    config: AssistantConfig,
    opts: { firstMessage: string; systemPrompt: string; transferDestinationE164: string | null; knowledgeBaseSearch: boolean },
  ): Record<string, unknown> {
    const payload = this.toVapiAssistantPayload({ ...config, voicemailDetection: null });
    delete payload.voicemailDetection;
    delete payload.voicemailMessage;
    delete payload.forwardingPhoneNumber;
    payload.firstMessage = opts.firstMessage;
    payload.firstMessageMode = 'assistant-speaks-first';
    const transfer = opts.transferDestinationE164 && /^\+[1-9]\d{6,14}$/.test(opts.transferDestinationE164) ? opts.transferDestinationE164 : null;
    const serverUrl = vapiWebhookUrl();
    const tools: Record<string, unknown>[] = [...buildCallControlTools(serverUrl), buildCallerDetailsTool(serverUrl)];
    if (transfer) tools.push(buildTransferTool(transfer));
    if (opts.knowledgeBaseSearch) tools.push(buildKnowledgeBaseTool(serverUrl));
    const model = payload.model as Record<string, unknown>;
    model.messages = [{ role: 'system', content: transfer ? `${opts.systemPrompt}${TRANSFER_TOOL_INSTRUCTION}` : opts.systemPrompt }];
    model.tools = tools;
    payload.startSpeakingPlan = START_SPEAKING_PLAN;
    payload.stopSpeakingPlan = STOP_SPEAKING_PLAN;
    payload.artifactPlan = ARTIFACT_PLAN;
    payload.backgroundSound = BACKGROUND_SOUND;
    return payload;
  }

  /** Points an imported number's inbound calls at this backend: Vapi asks
   * our assistant-request webhook who should answer, and if that fails
   * the call goes to fallbackE164 (a person) instead of being dropped. */
  async configureInboundNumber(vapiPhoneNumberId: string, fallbackE164: string | null): Promise<void> {
    const serverUrl = vapiWebhookUrl();
    if (!serverUrl) throw new OrchestrationProviderError('BACKEND_PUBLIC_URL is not set - cannot route inbound calls to this backend.');
    const body: Record<string, unknown> = { server: { url: serverUrl } };
    if (fallbackE164 && /^\+[1-9]\d{6,14}$/.test(fallbackE164)) {
      body.fallbackDestination = { type: 'number', number: fallbackE164, message: '' };
    }
    await this.request('PATCH', `/phone-number/${encodeURIComponent(vapiPhoneNumberId)}`, body);
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
  /** Vapi's Telnyx phone-number import does not accept a raw API key
   * inline the way Twilio's does - it requires a `credentialId`
   * referencing a credential resource registered with Vapi first (POST
   * /credential). Registers one on every call rather than caching it,
   * since this only runs once per not-yet-imported number (the result is
   * cached on phone_numbers.vapi_phone_number_id by the caller) - a
   * little Vapi-side credential churn, never a wrong/fabricated id. */
  private async ensureTelnyxCredential(apiKey: string): Promise<string> {
    const created = await this.request<{ id: string }>('POST', '/credential', { provider: 'telnyx', apiKey });
    return created.id;
  }

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
      if (!input.telnyxApiKey) {
        throw new OrchestrationProviderError('A Telnyx API key is required to import a Telnyx number into Vapi.');
      }
      payload.provider = 'telnyx';
      payload.credentialId = await this.ensureTelnyxCredential(input.telnyxApiKey);
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
    // Real per-lead personalization: Vapi's documented POST /call body
    // accepts an `assistantOverrides` object that overrides fields on the
    // assistant for THIS call only, without touching the cached/shared
    // assistant record (params.providerAssistantId is created once per
    // agent version and reused for every lead a campaign dials - baking
    // `{{first_name}}` etc. into the assistant itself would apply it to
    // every future call too). Only sent when the caller actually resolved
    // an override - a plain call with neither leaves the assistant's own
    // stored firstMessage/system message untouched.
    //
    // stopSpeakingPlan/artifactPlan are always sent here too (not just on
    // the stored assistant) so they apply to every call immediately,
    // including ones placed with assistants published before they existed -
    // no republish needed.
    {
      const assistantOverrides: Record<string, unknown> = {
        startSpeakingPlan: START_SPEAKING_PLAN,
        stopSpeakingPlan: STOP_SPEAKING_PLAN,
        artifactPlan: ARTIFACT_PLAN,
        backgroundSound: BACKGROUND_SOUND,
        // Per call too, so live transcripts flow even when the agent's saved
        // assistant predates this setting.
        serverMessages: SERVER_MESSAGES,
        // Hang up as soon as the conversation is done - per call so it
        // applies without republishing every agent.
        endCallFunctionEnabled: true,
        silenceTimeoutSeconds: SILENCE_TIMEOUT_SECONDS,
        ...voicemailSettings(params.voicemailDetection),
      };
      // Auto transfer: the assistant gets a real transferCall tool for this
      // call's server-resolved destination (the campaign's transfer number,
      // else the agent's). The old assistant-level forwardingPhoneNumber is
      // not in Vapi's current API, so the model had nothing to call and
      // only ever *said* it was transferring.
      const transferDestination = params.transferDestinationE164 && /^\+[1-9]\d{6,14}$/.test(params.transferDestinationE164) ? params.transferDestinationE164 : null;
      const appendedTools: Record<string, unknown>[] = [];
      if (transferDestination) appendedTools.push(buildTransferTool(transferDestination));
      // The campaign's knowledge base, searchable live during the call.
      if (params.knowledgeBaseSearch) appendedTools.push(buildKnowledgeBaseTool(vapiWebhookUrl()));
      // Callbacks and Do-Not-Call requests, on every call.
      appendedTools.push(...buildCallControlTools(vapiWebhookUrl()));
      if (appendedTools.length > 0) assistantOverrides['tools:append'] = appendedTools;
      if (params.firstMessageOverride) assistantOverrides.firstMessage = params.firstMessageOverride;
      if (params.systemPromptOverride) {
        // Vapi requires BOTH `provider` and `model` on the override's model
        // object even for a partial (messages-only) override - omitting
        // either fails 400 ("assistantOverrides.model.<field> must be one
        // of the following values: ...") exactly as if an invalid value had
        // been sent, even though neither was ever included at all. See
        // CreateCallParams' llmProvider/llmModel doc comments.
        assistantOverrides.model = {
          provider: params.llmProvider ?? 'openai',
          model: params.llmModel ?? 'gpt-4o-mini',
          // The override replaces the whole model block, so the agent's
          // own temperature/max tokens are repeated here too.
          ...(params.llmTemperature != null ? { temperature: params.llmTemperature } : {}),
          ...(params.llmMaxTokens != null ? { maxTokens: params.llmMaxTokens } : {}),
          messages: [{ role: 'system', content: transferDestination ? `${params.systemPromptOverride}${TRANSFER_TOOL_INSTRUCTION}` : params.systemPromptOverride }],
        };
      }
      payload.assistantOverrides = assistantOverrides;
    }
    const created = await this.request<VapiCallObject>('POST', '/call', payload);
    return { providerCallId: created.id, status: created.status };
  }

  async getCall(providerCallId: string): Promise<{ status: string; raw: Record<string, unknown> }> {
    const call = await this.request<VapiCallObject>('GET', `/call/${encodeURIComponent(providerCallId)}`);
    return { status: call.status, raw: call as unknown as Record<string, unknown> };
  }

  /** Ends a live call with an 'end-call' control message on the call's own
   * monitor.controlUrl. Vapi's REST API has no hangup endpoint (the old
   * POST /call/{id}/hangup returned 404), so supervisor End call and the
   * stuck/silent-call sweeps were never actually ending calls at Vapi -
   * they kept running (and billing) until the caller hung up. A call that
   * has already ended is a no-op. */
  async endCall(providerCallId: string): Promise<void> {
    const call = await this.request<VapiCallObject>('GET', `/call/${encodeURIComponent(providerCallId)}`);
    if (call.status === 'ended') return;
    if (!call.monitor?.controlUrl) {
      throw new OrchestrationProviderError('This call has no active control URL - it may have already ended.');
    }
    let res: Response;
    try {
      res = await fetch(call.monitor.controlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'end-call' }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new OrchestrationProviderError('Failed to reach the Vapi call control URL to end the call.', err);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OrchestrationProviderError(`Vapi end-call control message failed (${res.status}): ${text.slice(0, 500)}`);
    }
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
        // Vapi's control-message type is 'transfer' (ClientInboundMessageTransfer
        // in its published API spec) - 'transfer-call' is not a control
        // message Vapi accepts, which is why supervisor transfers hung for
        // ~30s and failed.
        body: JSON.stringify({ type: 'transfer', destination: { type: 'number', number: destinationE164 } }),
        signal: AbortSignal.timeout(10_000),
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
        // Vapi's ClientInboundMessageSay carries the text in `content`, not
        // `message` (published API spec).
        body: JSON.stringify({ type: 'say', content: text }),
        signal: AbortSignal.timeout(10_000),
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
    const recordingUrl = call.artifact?.recordingUrl ?? null;
    return {
      recordingUrl,
      // The raw recordingUrl points into a private bucket (400
      // "InvalidArgument: Authorization"); Vapi's own authenticated
      // download endpoint redirects to a signed, fetchable URL.
      recordingDownload: recordingUrl
        ? {
            url: `${VAPI_API_BASE}/call/${encodeURIComponent(providerCallId)}/mono-recording`,
            headers: { Authorization: `Bearer ${this.requireApiKey()}` },
          }
        : null,
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

  /** Vapi has no account-wide webhook API (see this file's header
   * comment) - toVapiAssistantPayload() sets `server.url` on every
   * assistant this backend creates or updates going forward, but that
   * does nothing for assistants that already existed before this fix
   * shipped. This backfills the same `server.url` onto every assistant
   * already registered under this org's Vapi account, so re-running
   * Test Connection actually fixes previously-published agents too,
   * not just new ones. Vapi's real GET /assistant list endpoint caps at
   * limit=1000 (docs.vapi.ai/api-reference/assistants/list) - a single
   * page comfortably covers any real org's assistant count.
   *
   * PATCHes run in bounded-concurrency batches rather than one at a
   * time - an org with many assistants doing this sequentially made
   * Test Connection take 49+ real seconds in production (confirmed in
   * Railway logs), which just looks like a stuck/broken button with no
   * feedback. A single already-deleted/archived assistant failing to
   * PATCH is swallowed rather than aborting the rest of the batch or
   * failing the whole connection test - this is a best-effort backfill,
   * and every assistant created or updated from now on gets server.url
   * set automatically regardless of whether this backfill fully
   * succeeds. */
  async registerWebhook(url: string): Promise<void> {
    const assistants = await this.request<Array<{ id: string }>>('GET', '/assistant?limit=1000');
    const CONCURRENCY = 10;
    for (let i = 0; i < assistants.length; i += CONCURRENCY) {
      const batch = assistants.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((assistant) =>
          this.request('PATCH', `/assistant/${encodeURIComponent(assistant.id)}`, { server: { url } }).catch(() => {
            // best-effort - see doc comment above
          }),
        ),
      );
    }
  }
}
