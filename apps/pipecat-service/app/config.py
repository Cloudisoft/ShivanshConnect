"""
Phase 6: apps/pipecat-service configuration.

Every setting here is read straight from the process environment (this
service's own deployment, separate from the Node backend's). Nothing here
is ever hard-coded or faked - `Settings.stt_configured` /
`tts_configured` / `llm_configured` are honest, live checks the readiness
endpoint and call-origination path both use to fail loudly with a clear
"not configured: missing X" error instead of silently no-op'ing (the hard
rule from the Phase 6 task brief).

Real provider integrations, gated purely on whether their key is present:
  - LLM:  OPENAI_API_KEY        (matches Phase 3's OpenAI provider choice)
  - STT:  DEEPGRAM_API_KEY      (Deepgram is a first-class pipecat-ai STT
                                  service - realistic, low-latency choice
                                  for real-time telephony)
  - TTS:  ELEVENLABS_API_KEY or CARTESIA_API_KEY (both already used
                                  elsewhere in this platform - Phase 4's
                                  voice providers - so an org reusing the
                                  same key here needs no new account)

Telephony credentials are NEVER read from this service's own environment -
they arrive transiently, per-call, in the POST /calls request body (see
app/telephony.py's header comment for exactly why).
"""

from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    PORT: int = 8100
    ENV: str = "development"

    # Shared secret with the Node backend, used both ways: Node sends it
    # as `Authorization: Bearer <token>` on every request to this service,
    # and this service sends it the same way when posting call lifecycle/
    # transcript events back to Node's POST /api/v1/webhooks/pipecat. When
    # unset, both sides skip verification (local/dev only - see
    # routes/webhooks.ts's verifyPipecatToken()).
    PIPECAT_SERVICE_TOKEN: str | None = None

    # Where this service posts call lifecycle + transcript events back to
    # the Node backend, e.g. "https://backend.example.com/api/v1/webhooks/pipecat".
    NODE_BACKEND_WEBHOOK_URL: str | None = None

    # The publicly reachable base URL for THIS service's own WebSocket
    # media-stream endpoint, e.g. "wss://pipecat.example.com" - Twilio/
    # Telnyx's Media Streams feature connects to
    # f"{PUBLIC_MEDIA_STREAM_URL}/media-stream/{call_id}" once the carrier
    # call is answered. Required to actually place a call (the carrier
    # has to be told where to stream audio); local dev can use ngrok or
    # similar.
    PUBLIC_MEDIA_STREAM_URL: str | None = None

    OPENAI_API_KEY: str | None = None
    DEEPGRAM_API_KEY: str | None = None
    ELEVENLABS_API_KEY: str | None = None
    CARTESIA_API_KEY: str | None = None

    @property
    def llm_configured(self) -> bool:
        return bool(self.OPENAI_API_KEY)

    @property
    def stt_configured(self) -> bool:
        return bool(self.DEEPGRAM_API_KEY)

    @property
    def tts_configured(self) -> bool:
        return bool(self.ELEVENLABS_API_KEY or self.CARTESIA_API_KEY)

    @property
    def media_stream_configured(self) -> bool:
        return bool(self.PUBLIC_MEDIA_STREAM_URL)

    @property
    def missing_requirements(self) -> list[str]:
        missing = []
        if not self.llm_configured:
            missing.append("OPENAI_API_KEY (LLM)")
        if not self.stt_configured:
            missing.append("DEEPGRAM_API_KEY (STT)")
        if not self.tts_configured:
            missing.append("ELEVENLABS_API_KEY or CARTESIA_API_KEY (TTS)")
        if not self.media_stream_configured:
            missing.append("PUBLIC_MEDIA_STREAM_URL (publicly reachable media-stream endpoint)")
        return missing

    @property
    def fully_configured(self) -> bool:
        return len(self.missing_requirements) == 0


settings = Settings()
