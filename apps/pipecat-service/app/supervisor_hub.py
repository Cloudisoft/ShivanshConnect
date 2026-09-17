"""
Phase 10: per-call registry connecting the Live Monitor supervisor
WebSocket endpoints (main.py's /supervisor/{pipecat_call_id}/{action}) to
the real pipecat pipeline's own frame processors (pipeline.py's
SupervisorTapProcessor / SupervisorInjectProcessor).

This is intentionally the ONLY coupling point between "a websocket
connection exists" and "the live audio pipeline does something with it" -
neither main.py's WS handler nor pipeline.py's FrameProcessors talk to
each other directly, they both go through one SupervisorHub instance per
call, exactly the same "in-process pub/sub as the documented seam" pattern
the Node backend uses for callEventBus/transcriptEventBus (see
apps/backend/src/lib/callStateMachine.ts's header comment) - here
implemented with asyncio primitives since this service is asyncio-native.

Audio format note: pipecat's transport frames carry raw PCM16 bytes
(sample rate/channel count as configured on the transport/serializer this
call is actually using) - this hub is deliberately format-agnostic, it
just moves bytes; SupervisorTapProcessor/SupervisorInjectProcessor are
where actual frame-type-specific handling happens (see pipeline.py).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger("pipecat_service.supervisor")


@dataclass
class CallSupervisorState:
    pipecat_call_id: str
    # Listen (and the "hear both sides" half of barge): every connected
    # supervisor WebSocket that wants tapped audio frames mirrored to it.
    listeners: set = field(default_factory=set)
    # Whisper: audio bytes queued here get mixed into the OUTBOUND
    # (caller-facing) leg only by SupervisorInjectProcessor - the caller
    # hears it, this is real injection, never a silent no-op.
    whisper_queue: "asyncio.Queue[bytes]" = field(default_factory=lambda: asyncio.Queue(maxsize=200))
    # Barge: audio bytes queued here are ALSO mixed into the outbound leg
    # (this is the "supervisor speaks into the call" half of barge) - kept
    # as a separate queue from whisper so the two actions never
    # cross-contaminate if both happen to be active (barge implies the
    # supervisor is also always listening, whisper does not).
    barge_queue: "asyncio.Queue[bytes]" = field(default_factory=lambda: asyncio.Queue(maxsize=200))
    barge_active: bool = False


class SupervisorHub:
    def __init__(self) -> None:
        self._calls: dict[str, CallSupervisorState] = {}

    def _state(self, pipecat_call_id: str) -> CallSupervisorState:
        if pipecat_call_id not in self._calls:
            self._calls[pipecat_call_id] = CallSupervisorState(pipecat_call_id=pipecat_call_id)
        return self._calls[pipecat_call_id]

    def discard_call(self, pipecat_call_id: str) -> None:
        """Called once the call itself ends (main.py's media_stream
        handler finally block) - drops all queued audio and forces any
        still-connected supervisor sockets to be cleaned up by their own
        WS loops (they will get a send error and close)."""
        self._calls.pop(pipecat_call_id, None)

    # ---- listen / tap (pipeline -> supervisor) ----------------------
    def add_listener(self, pipecat_call_id: str, ws) -> None:
        self._state(pipecat_call_id).listeners.add(ws)

    def remove_listener(self, pipecat_call_id: str, ws) -> None:
        state = self._calls.get(pipecat_call_id)
        if state:
            state.listeners.discard(ws)

    async def broadcast_audio(self, pipecat_call_id: str, direction: str, pcm_bytes: bytes) -> None:
        """Called by SupervisorTapProcessor for every real audio frame
        passing through the pipeline. `direction` is 'caller' or 'ai' so
        the frontend can label which side is speaking. Never buffers -
        a supervisor who isn't connected yet simply misses frames that
        already went by, exactly like joining a live phone call late."""
        state = self._calls.get(pipecat_call_id)
        if not state or not state.listeners:
            return
        dead = []
        for ws in state.listeners:
            try:
                await ws.send_bytes(bytes([1 if direction == "ai" else 0]) + pcm_bytes)
            except Exception:
                dead.append(ws)
        for ws in dead:
            state.listeners.discard(ws)

    # ---- whisper / barge (supervisor -> pipeline injection) ----------
    def push_whisper_audio(self, pipecat_call_id: str, pcm_bytes: bytes) -> None:
        state = self._state(pipecat_call_id)
        try:
            state.whisper_queue.put_nowait(pcm_bytes)
        except asyncio.QueueFull:
            logger.warning("whisper queue full for call %s - dropping frame (backpressure)", pipecat_call_id)

    def push_barge_audio(self, pipecat_call_id: str, pcm_bytes: bytes) -> None:
        state = self._state(pipecat_call_id)
        try:
            state.barge_queue.put_nowait(pcm_bytes)
        except asyncio.QueueFull:
            logger.warning("barge queue full for call %s - dropping frame (backpressure)", pipecat_call_id)

    def set_barge_active(self, pipecat_call_id: str, active: bool) -> None:
        self._state(pipecat_call_id).barge_active = active

    def drain_injection_audio(self, pipecat_call_id: str) -> Optional[bytes]:
        """Non-blocking pull SupervisorInjectProcessor calls on every
        pipeline tick: whisper takes priority (a supervisor whispering a
        correction mid-barge still gets heard), falls back to barge audio,
        returns None when there is nothing pending right now."""
        state = self._calls.get(pipecat_call_id)
        if not state:
            return None
        for q in (state.whisper_queue, state.barge_queue):
            try:
                return q.get_nowait()
            except asyncio.QueueEmpty:
                continue
        return None


# Process-wide singleton - one pipecat-service process, many concurrent
# calls, each keyed by its own pipecat_call_id (mirrors store.py's
# call_store singleton).
supervisor_hub = SupervisorHub()
