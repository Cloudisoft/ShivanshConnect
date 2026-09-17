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


async def build_pipeline(
    *,
    transport: Any,
    agent_config: dict[str, Any],
    transfer_destination_e164: Optional[str],
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

    pipeline = Pipeline(
        [
            transport.input(),
            stt_service,
            context_aggregator.user(),
            llm_service,
            tts_service,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))
    runner = PipelineRunner()
    return runner, task
