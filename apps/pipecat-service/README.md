# apps/pipecat-service

The self-hosted second call orchestration engine, alongside Vapi (the
managed engine - see `apps/backend/src/lib/orchestration/vapi.ts`).
Pipecat is a Python framework, so this is a **separate service** from the
Node backend: its own process, its own dependencies, its own deployment
(a second Railway service in production, not a route inside
`apps/backend`).

## What this is

A FastAPI control-plane API that `apps/backend`'s `PipecatProvider`
(`apps/backend/src/lib/orchestration/pipecat.ts`) talks to over plain
HTTP, plus a WebSocket endpoint that Twilio/Telnyx connect their call
audio to once a call is answered. The real voice pipeline (speech-to-text
-> LLM -> text-to-speech, wired to the live phone audio) is built with the
actual [`pipecat-ai`](https://github.com/pipecat-ai/pipecat) Python
package - nothing here is a stub or a simulated pipeline.

```
Node backend (routes/calls.ts)
  -> PipecatProvider.createCall()  [HTTP, apps/backend]
       -> POST /calls              [this service]
            -> places the REAL outbound call via Twilio/Telnyx's own
               REST API, using credentials Node resolved from Phase 5's
               existing per-org encrypted storage and forwarded ONCE,
               transiently, in this one request (see below)
            -> tells the carrier to stream call audio to
               PUBLIC_MEDIA_STREAM_URL/media-stream/{pipecat_call_id}
  <- { pipecat_call_id, status: "dialing" }

Carrier (Twilio/Telnyx) answers the call
  -> opens a WebSocket to /media-stream/{pipecat_call_id}   [this service]
       -> builds a real pipecat-ai Pipeline (STT -> LLM -> TTS) and runs it
       -> posts call lifecycle + transcript events back to
          NODE_BACKEND_WEBHOOK_URL (Node's POST /api/v1/webhooks/pipecat),
          the SAME webhook_events/call_events pipeline Vapi calls flow
          through
```

## Architectural choice: who dials, who streams

The Phase 6 task brief allowed either (a) this service calling back to
Node for a short-lived scoped credential fetch, or (b) Node originating
the call itself and handing this service only the resulting media stream.
This codebase uses a variant of (a): Node resolves and decrypts the org's
already-stored Twilio/Telnyx credentials (Phase 5's existing tables and
adapters - nothing new is ever persisted, nowhere) and forwards them once,
transiently, inside the single `POST /calls` request body. This service
uses them synchronously to place the real outbound call and never stores,
logs, or persists them. See `app/telephony.py` and
`apps/backend/src/lib/orchestration/pipecat.ts`'s header comments for the
full reasoning.

## Running it locally

```bash
cd apps/pipecat-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in the keys you have
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

`GET /health` is a bare liveness check (always 200 once the process is
up). `GET /readiness` is the honest one - it returns `200 {"ready": true}`
only once an LLM key, an STT key, a TTS key, AND a public media-stream URL
are all configured, and otherwise `503` naming exactly what's missing
(e.g. `["DEEPGRAM_API_KEY (STT)"]`). `POST /calls` fails the same way with
a `422` and a `pipecat engine not configured: missing ...` message -
**never** a silently simulated call, per the Phase 6 hard rule.

To actually receive Twilio/Telnyx Media Streams locally you need a public
URL for this process - tunnel it (ngrok, cloudflared, etc.) and set
`PUBLIC_MEDIA_STREAM_URL` to the tunnel's `wss://` URL.

## Environment variables

See `.env.example` for the full list with comments. Summary:

| Variable | Required for | Notes |
| --- | --- | --- |
| `PORT` | - | Default `8100`. |
| `PIPECAT_SERVICE_TOKEN` | auth | Shared secret with the Node backend, both directions. Unset = no auth (local/dev only). |
| `NODE_BACKEND_WEBHOOK_URL` | event delivery | Node's `POST /api/v1/webhooks/pipecat`. |
| `PUBLIC_MEDIA_STREAM_URL` | placing any call | This service's own public `wss://` base URL. |
| `OPENAI_API_KEY` | LLM | Reuses Phase 3's provider choice. |
| `DEEPGRAM_API_KEY` | STT | Real-time speech-to-text. |
| `ELEVENLABS_API_KEY` / `CARTESIA_API_KEY` | TTS | At least one; ElevenLabs preferred when both are set. Same providers as Phase 4's voice catalog. |

Telephony (Twilio/Telnyx) credentials are **never** read from this
service's own environment - see the architectural choice above.

## Deploying (Railway)

This is a second Railway service in the same project, not a route added
to the existing Node service:

1. Create a new Railway service from this directory (`apps/pipecat-
   service`) with a Python buildpack/Dockerfile pointing at
   `uvicorn app.main:app --host 0.0.0.0 --port $PORT`.
2. Set the environment variables from the table above (Railway's own
   "Variables" tab) - in particular generate a domain for it and set
   `PUBLIC_MEDIA_STREAM_URL` to `wss://<that-domain>`.
3. Set `PIPECAT_SERVICE_TOKEN` to the same value on both this service and
   the Node backend service, and set the Node backend's
   `PIPECAT_SERVICE_URL` to this service's `https://<domain>`.
4. In the Node backend, an org selects "Pipecat (self-hosted)" as its
   default call engine (Settings > Integrations), or requests it
   per-call via `POST /calls { engine: "pipecat" }`.

## What could not be verified in this sandbox

No real phone call is placed anywhere in this build - there is no
network path to an actual Twilio/Telnyx account or a live WebSocket media
stream in this sandbox, and that is expected for this phase. What IS
verified here:

- The service starts and its control API (`/health`, `/readiness`,
  `/calls`, `/calls/{id}`, `/calls/{id}/end`, `/calls/{id}/transfer`,
  `/calls/{id}/artifacts`, `/webhook-config`) responds correctly,
  including the "not configured" 422/503 paths with zero calls made to
  Twilio/Telnyx.
- Call origination against Twilio's real REST API shape is exercised with
  a mocked HTTP layer (`tests/test_calls.py`), confirming the request is
  built correctly (account SID, TwiML `<Stream>` URL, etc.) without
  actually calling out to Twilio.
- The real `pipecat-ai` pipeline construction code
  (`app/pipeline.py:build_pipeline`) is written against pipecat-ai
  1.10.0's documented module layout (`pipecat.pipeline.pipeline.Pipeline`,
  `pipecat.services.deepgram.stt.DeepgramSTTService`,
  `pipecat.services.openai.llm.OpenAILLMService`,
  `pipecat.services.elevenlabs.tts.ElevenLabsTTSService` /
  `pipecat.services.cartesia.tts.CartesiaTTSService`,
  `pipecat.transports.network.fastapi_websocket.FastAPIWebsocketTransport`,
  `pipecat.serializers.twilio.TwilioFrameSerializer`) but is not run
  end-to-end against a live media stream here - it raises a clear
  `PipelineNotAvailableError` if the package or a required key is
  missing, rather than degrading silently.
