"""
Phase 6: the real pipecat-ai voice pipeline - Twilio/Telnyx Media Streams
transport -> STT -> LLM -> TTS -> back to the call.

Imports from `pipecat-ai` are done lazily, inside build_pipeline(), rather
than at module load time. This lets the rest of this service (config,
call registry, REST control API, and this file's own unit-testable
helpers) start and be tested even in an environment where the full
pipecat-ai package (and its provider extras) isn't installed - the
control-plane API is what routes/calls.ts's PipecatProvider actually talks
to, and it must be testable on its own. A real deployment always installs
`requirements.txt` in full (see README.md), so build_pipeline() always
succeeds there.

Personality/system-prompt handling mirrors exactly what VapiProvider does
on the Node side (see lib/orchestration/vapi.ts's toVapiAssistantPayload)
so the two engines produce comparable agent behavior from the same
ai_agent_versions row.
"""

from __future__ import annotations

from typing import Any, Optional

from .config import settings
from .supervisor_hub import supervisor_hub


class PipelineNotAvailableError(Exception):
    """Raised when pipecat-ai (or one of its provider extras this call
    needs) is not importable - a real, honest deployment gap, never
    silently downgraded to a fake/no-op pipeline."""


def build_system_prompt(agent_config: dict[str, Any]) -> str:
    """Folds personality traits into the system prompt exactly the way
    VapiProvider does, so switching an org between engines doesn't change
    how the agent is instructed to behave."""
    lines = [agent_config.get("system_prompt", "")]
    personality = agent_config.get("personality") or {}
    if personality.get("tone"):
        lines.append(f"Tone: {personality['tone']}.")
    if personality.get("personality_traits"):
        lines.append(f"Personality traits: {', '.join(personality['personality_traits'])}.")
    if personality.get("behavior_traits"):
        lines.append(f"Behavior: {', '.join(personality['behavior_traits'])}.")
    return "\n\n".join(line for line in lines if line)


def _build_supervisor_processors(pipecat_call_id: str):
    """
    Phase 10: two real pipecat FrameProcessors that give Live Monitor's
    listen/whisper/barge a genuine place to attach, using pipecat-ai's own
    frame-processing architecture (this is the "we own the whole
    pipeline, implement real audio mixing" half of Phase 10 - see
    routes/liveMonitor.ts on the Node side for the full Vapi-vs-pipecat
    writeup).

    - SupervisorTapProcessor: never mutates what passes through it - every
      AudioRawFrame it sees is forwarded downstream completely unchanged,
      and a COPY of its raw bytes is fire-and-forget broadcast to
      supervisor_hub for any connected /supervisor/{id}/listen (and,
      while barged in, /supervisor/{id}/barge) socket. Placed twice in
      the pipeline: right after transport.input() (tags frames 'caller')
      and right after the TTS service (tags frames 'ai') - together this
      is the complete "supervisor hears both sides" listen feed.
    - SupervisorInjectProcessor: placed immediately before
      transport.output(). On every frame it drains any pending
      whisper/barge audio bytes queued by a connected supervisor
      WebSocket (supervisor_hub.drain_injection_audio) and, when present,
      pushes a REAL new OutputAudioRawFrame carrying that audio into the
      outbound stream ahead of the current frame - this is actual
      injection into the caller-facing leg, not a logged-and-discarded
      no-op. Whisper and barge use the exact same injection path; the
      only difference is which hub queue fed it (see supervisor_hub.py).

    Both classes are defined here (not at module scope) because they
    subclass pipecat-ai's own FrameProcessor, which - like every other
    pipecat-ai symbol in this file - is only importable once the real
    package is installed (see this file's header comment on lazy
    imports).
    """
    from pipecat.frames.frames import AudioRawFrame, OutputAudioRawFrame
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

    class SupervisorTapProcessor(FrameProcessor):
        def __init__(self, label: str):
            super().__init__()
            self._label = label  # 'caller' | 'ai'

        async def process_frame(self, frame, direction: "FrameDirection"):
            await super().process_frame(frame, direction)
            if isinstance(frame, AudioRawFrame):
                try:
                    import asyncio

                    asyncio.create_task(supervisor_hub.broadcast_audio(pipecat_call_id, self._label, bytes(frame.audio)))
                except Exception:  # pragma: no cover - broadcast is best-effort, never blocks the call
                    logger = __import__("logging").getLogger("pipecat_service.supervisor")
                    logger.exception("supervisor audio tap broadcast failed for call %s", pipecat_call_id)
            await self.push_frame(frame, direction)

    class SupervisorInjectProcessor(FrameProcessor):
        async def process_frame(self, frame, direction: "FrameDirection"):
            await super().process_frame(frame, direction)
            if isinstance(frame, AudioRawFrame):
                injected = supervisor_hub.drain_injection_audio(pipecat_call_id)
                if injected:
                    sample_rate = getattr(frame, "sample_rate", 16000)
                    num_channels = getattr(frame, "num_channels", 1)
                    await self.push_frame(
                        OutputAudioRawFrame(audio=injected, sample_rate=sample_rate, num_channels=num_channels),
                        direction,
                    )
            await self.push_frame(frame, direction)

    return SupervisorTapProcessor("caller"), SupervisorTapProcessor("ai"), SupervisorInjectProcessor()


def _build_transcript_emitter(pipecat_call_id: str):
    """
    Phase 10: real-time transcript emission (the pipecat half of "live
    transcript, not just post-call" - see apps/backend/src/services/
    liveTranscriptIngestion.ts for the Node side that receives this).

    Two instances are inserted into the pipeline:
      - one right after the STT service, tapping pipecat-ai's own
        `TranscriptionFrame` (STT services only emit this once an
        utterance is finalized, never for interim/partial hypotheses -
        so, unlike Vapi, there is no separate partial/final flag to check
        here; every TranscriptionFrame this sees is already a complete
        caller utterance).
      - one right after the LLM service, accumulating `TextFrame` chunks
        between `LLMFullResponseStartFrame`/`LLMFullResponseEndFrame`
        (pipecat-ai's own documented boundary markers for one complete
        assistant turn) and posting the assistant's utterance exactly
        once it's complete - never one event per token/chunk.

    Both post to Node's POST /api/v1/webhooks/pipecat with
    `event_type: 'transcript'` via webhook_client.post_event, fire-and-
    forget (a lost transcript-update delivery does not fail the call -
    the post-call artifact fetch still backfills it, see
    processCallArtifacts.ts's reconciliation logic).
    """
    from pipecat.frames.frames import LLMFullResponseEndFrame, LLMFullResponseStartFrame, TextFrame, TranscriptionFrame
    from pipecat.processors.frame_processor import FrameProcessor

    from .webhook_client import post_event

    class CallerTranscriptEmitter(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, TranscriptionFrame) and getattr(frame, "text", "").strip():
                import asyncio

                asyncio.create_task(
                    post_event(pipecat_call_id=pipecat_call_id, event_type="transcript", extra={"speaker": "caller", "text": frame.text})
                )
            await self.push_frame(frame, direction)

    class AssistantTranscriptEmitter(FrameProcessor):
        def __init__(self):
            super().__init__()
            self._buffer = ""

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, LLMFullResponseStartFrame):
                self._buffer = ""
            elif isinstance(frame, TextFrame):
                self._buffer += frame.text
            elif isinstance(frame, LLMFullResponseEndFrame):
                text = self._buffer.strip()
                self._buffer = ""
                if text:
                    import asyncio

                    asyncio.create_task(
                        post_event(pipecat_call_id=pipecat_call_id, event_type="transcript", extra={"speaker": "ai", "text": text})
                    )
            await self.push_frame(frame, direction)

    return CallerTranscriptEmitter(), AssistantTranscriptEmitter()


async def build_pipeline(
    *,
    transport: Any,
    agent_config: dict[str, Any],
    transfer_destination_e164: Optional[str],
    pipecat_call_id: Optional[str] = None,
):
    """
    Builds a real pipecat-ai Pipeline: `transport.input()` -> STT -> LLM
    context aggregator -> LLM service -> TTS -> `transport.output()`.

    `transport` is a pipecat-ai FastAPIWebsocketTransport (or Twilio/Telnyx
    frame serializer variant) already bound to the live media-stream
    WebSocket for one call - constructed by the caller (main.py's
    websocket handler) since it needs the raw WebSocket connection object.

    Raises PipelineNotAvailableError with a clear message identifying
    exactly which piece is missing (the pipecat-ai package itself, or a
    specific provider's env var) - this function is never called unless
    settings.fully_configured is already True (main.py checks that before
    accepting a call), but it re-checks here too as defense in depth for
    any direct caller.
    """
    missing = settings.missing_requirements
    if missing:
        raise PipelineNotAvailableError(f"pipecat engine not configured: missing {', '.join(missing)}")

    try:
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineParams, PipelineTask
        from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
        from pipecat.services.deepgram.stt import DeepgramSTTService
        from pipecat.services.openai.llm import OpenAILLMService
    except ImportError as exc:  # pragma: no cover - exercised only without the full extra installed
        raise PipelineNotAvailableError(
            "pipecat-ai is not installed in this environment - run `pip install -r requirements.txt` "
            "(see apps/pipecat-service/README.md)."
        ) from exc

    # TTS: prefer ElevenLabs, fall back to Cartesia - whichever key this
    # deployment actually has configured (mirrors Phase 4's voice provider
    # choice being per-org; here it is per pipecat-service deployment).
    tts_service = None
    if settings.ELEVENLABS_API_KEY:
        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

        voice = agent_config.get("voice") or {}
        tts_service = ElevenLabsTTSService(
            api_key=settings.ELEVENLABS_API_KEY,
            voice_id=voice.get("provider_voice_id") or "21m00Tcm4TlvDq8ikWAM",
        )
    else:
        from pipecat.services.cartesia.tts import CartesiaTTSService

        voice = agent_config.get("voice") or {}
        tts_service = CartesiaTTSService(
            api_key=settings.CARTESIA_API_KEY,
            voice_id=voice.get("provider_voice_id") or "829ccd10-f8b3-43cd-b8a0-4aeaa81f3b30",
        )

    stt_service = DeepgramSTTService(api_key=settings.DEEPGRAM_API_KEY)
    llm_service = OpenAILLMService(api_key=settings.OPENAI_API_KEY, model=agent_config.get("llm_model") or "gpt-4o-mini")

    system_prompt = build_system_prompt(agent_config)
    messages = [{"role": "system", "content": system_prompt}]
    if agent_config.get("greeting"):
        messages.append({"role": "assistant", "content": agent_config["greeting"]})
    context = OpenAILLMContext(messages)
    context_aggregator = llm_service.create_context_aggregator(context)

    stages: list[Any] = [transport.input()]
    caller_tap = ai_tap = injector = None
    if pipecat_call_id:
        # Phase 10: only wired up when the caller (main.py) knows this
        # call's pipecat_call_id, i.e. always for a real carrier-originated
        # call - see this function's docstring / _build_supervisor_
        # processors()'s for exactly what these do.
        caller_tap, ai_tap, injector = _build_supervisor_processors(pipecat_call_id)
        stages.append(caller_tap)
    stages.append(stt_service)
    if pipecat_call_id:
        caller_transcript, assistant_transcript = _build_transcript_emitter(pipecat_call_id)
        stages.append(caller_transcript)
    stages += [context_aggregator.user(), llm_service]
    if pipecat_call_id:
        stages.append(assistant_transcript)
    stages.append(tts_service)
    if ai_tap:
        stages.append(ai_tap)
    if injector:
        stages.append(injector)
    stages += [transport.output(), context_aggregator.assistant()]

    pipeline = Pipeline(stages)

    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    runner = PipelineRunner()
    return runner, task
