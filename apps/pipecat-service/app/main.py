"""
Phase 6: apps/pipecat-service - the self-hosted second call orchestration
engine. FastAPI control API that apps/backend's PipecatProvider (TypeScript
HTTP client, lib/orchestration/pipecat.ts) talks to, plus the WebSocket
media-stream endpoint Twilio/Telnyx connect to once a call is answered.

Run: `uvicorn app.main:app --host 0.0.0.0 --port 8100` (see README.md for
the full story, including how this differs from the Node backend's own
process and how to deploy it as its own Railway service).
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from .config import settings
from .pipeline import PipelineNotAvailableError, build_pipeline
from .schemas import (
    ArtifactsResponse,
    CreateCallRequest,
    CreateCallResponse,
    TransferRequest,
    WebhookConfigRequest,
)
from .store import CallRecord, call_store
from .telephony import TelephonyOriginationError, originate_telnyx_call, originate_twilio_call
from .webhook_client import post_event

logger = logging.getLogger("pipecat_service")

app = FastAPI(title="ShivanshConnect pipecat-service", version="0.1.0")

_registered_webhook_url: Optional[str] = None


def require_auth(authorization: Optional[str] = Header(default=None)) -> None:
    """Verifies the shared bearer token Node sends on every request, when
    PIPECAT_SERVICE_TOKEN is configured. Unset -> unauthenticated access is
    allowed (local/dev only), matching the Node side's honest same-default
    documented in routes/webhooks.ts's verifyPipecatToken()."""
    if not settings.PIPECAT_SERVICE_TOKEN:
        return
    expected = f"Bearer {settings.PIPECAT_SERVICE_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token.")


@app.get("/health")
async def health() -> dict:
    """Basic liveness - always 200 once the process is up, regardless of
    provider configuration. Kubernetes/Railway-style liveness probes use
    this; use /readiness to know whether calls can actually be placed."""
    return {"status": "ok", "service": "pipecat-service"}


@app.get("/readiness")
async def readiness() -> JSONResponse:
    """Honest configuration-status report - never claims readiness that
    isn't real. 200 with ready=true only when LLM + STT + TTS + a public
    media-stream URL are all configured; otherwise 503 naming exactly
    what's missing, per the Phase 6 hard rule ('never silently no-op')."""
    body = {
        "ready": settings.fully_configured,
        "llm_configured": settings.llm_configured,
        "stt_configured": settings.stt_configured,
        "tts_configured": settings.tts_configured,
        "media_stream_configured": settings.media_stream_configured,
        "missing": settings.missing_requirements,
    }
    return JSONResponse(status_code=200 if settings.fully_configured else 503, content=body)


@app.post("/webhook-config", dependencies=[Depends(require_auth)])
async def webhook_config(body: WebhookConfigRequest) -> dict:
    """Confirms this service has (or is told about) a reachable webhook
    target. NODE_BACKEND_WEBHOOK_URL is normally set via this service's own
    environment at deploy time; this endpoint lets VapiProvider-equivalent
    registerWebhook() calls confirm/override it at runtime too, matching
    the shared CallOrchestrationProvider interface."""
    global _registered_webhook_url
    _registered_webhook_url = body.url
    return {"registered": True, "url": body.url}


@app.post("/calls", dependencies=[Depends(require_auth)], response_model=CreateCallResponse)
async def create_call(body: CreateCallRequest) -> CreateCallResponse:
    missing = settings.missing_requirements
    if missing:
        raise HTTPException(status_code=422, detail=f"pipecat engine not configured: missing {', '.join(missing)}")

    record = call_store.create(
        internal_call_id=body.internal_call_id,
        organization_id=body.organization_id,
        agent_version_id=body.agent_version_id,
        from_e164=body.from_e164,
        to_e164=body.to_e164,
        transfer_destination_e164=body.transfer_destination_e164,
    )

    stream_ws_url = f"{settings.PUBLIC_MEDIA_STREAM_URL}/media-stream/{record.pipecat_call_id}"

    try:
        if body.telephony.provider == "twilio":
            if not (body.telephony.account_sid and body.telephony.auth_token):
                raise HTTPException(status_code=422, detail="Twilio credentials (account_sid, auth_token) are required.")
            originated = await originate_twilio_call(
                account_sid=body.telephony.account_sid,
                auth_token=body.telephony.auth_token,
                from_e164=body.from_e164,
                to_e164=body.to_e164,
                stream_ws_url=stream_ws_url,
            )
        else:
            if not body.telephony.api_key:
                raise HTTPException(status_code=422, detail="A Telnyx API key is required.")
            originated = await originate_telnyx_call(
                api_key=body.telephony.api_key,
                from_e164=body.from_e164,
                to_e164=body.to_e164,
                stream_ws_url=stream_ws_url,
            )
    except TelephonyOriginationError as exc:
        record.status = "failed"
        record.ended_reason = str(exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    record.carrier = originated.carrier
    record.carrier_call_sid = originated.carrier_call_sid
    record.status = "dialing"

    await post_event(
        pipecat_call_id=record.pipecat_call_id,
        event_type="dialing",
        extra={"carrier": originated.carrier, "carrier_call_sid": originated.carrier_call_sid},
    )

    return CreateCallResponse(pipecat_call_id=record.pipecat_call_id, status=record.status)


def _get_call_or_404(pipecat_call_id: str) -> CallRecord:
    record = call_store.get(pipecat_call_id)
    if not record:
        raise HTTPException(status_code=404, detail="Call not found.")
    return record


@app.get("/calls/{pipecat_call_id}", dependencies=[Depends(require_auth)])
async def get_call(pipecat_call_id: str) -> dict:
    record = _get_call_or_404(pipecat_call_id)
    return {
        "pipecat_call_id": record.pipecat_call_id,
        "status": record.status,
        "carrier": record.carrier,
        "carrier_call_sid": record.carrier_call_sid,
        "ended_reason": record.ended_reason,
    }


@app.post("/calls/{pipecat_call_id}/end", dependencies=[Depends(require_auth)])
async def end_call(pipecat_call_id: str) -> dict:
    record = _get_call_or_404(pipecat_call_id)
    record.status = "completed"
    import time as _time

    record.ended_at = _time.time()
    await post_event(pipecat_call_id=record.pipecat_call_id, event_type="completed", extra={"ended_reason": "api_requested"})
    return {"ended": True}


@app.post("/calls/{pipecat_call_id}/transfer", dependencies=[Depends(require_auth)])
async def transfer_call(pipecat_call_id: str, body: TransferRequest) -> dict:
    record = _get_call_or_404(pipecat_call_id)
    # Hard rule from spec 19/8L, enforced here too (defense in depth on
    # top of the Node backend and VapiProvider already refusing a
    # non-server-resolved destination): this service also only ever
    # transfers to whatever E.164 destination was resolved server-side at
    # call-creation time and stored on the call record - a transfer
    # request naming a DIFFERENT destination than that is rejected outright.
    if record.transfer_destination_e164 and body.destination_e164 != record.transfer_destination_e164:
        raise HTTPException(
            status_code=422,
            detail="Transfer destination does not match this call's server-resolved configuration.",
        )
    record.status = "transferring"
    await post_event(pipecat_call_id=record.pipecat_call_id, event_type="transferring", extra={"destination_e164": body.destination_e164})
    return {"transferring": True}


@app.get("/calls/{pipecat_call_id}/artifacts", dependencies=[Depends(require_auth)], response_model=ArtifactsResponse)
async def get_artifacts(pipecat_call_id: str) -> ArtifactsResponse:
    record = _get_call_or_404(pipecat_call_id)
    return ArtifactsResponse(recording_url=record.recording_url, transcript_url=None, transcript=record.transcript or None)


@app.websocket("/media-stream/{pipecat_call_id}")
async def media_stream(websocket: WebSocket, pipecat_call_id: str) -> None:
    """
    Handles the carrier's (Twilio/Telnyx) inbound Media Streams WebSocket
    connection for one call's audio - this is where the real pipecat-ai
    pipeline (STT -> LLM -> TTS) actually attaches, once the call is
    answered and the carrier connects here per the stream_url passed to
    originate_twilio_call()/originate_telnyx_call().

    This handler intentionally builds the transport/pipeline lazily, only
    once a real WebSocket connects - see app/pipeline.py's header comment
    for why the pipecat-ai import itself is deferred this far down too.
    """
    record = call_store.get(pipecat_call_id)
    if not record:
        await websocket.close(code=4404)
        return

    await websocket.accept()
    record.control_ws_connected = True
    record.status = "in_progress"
    await post_event(pipecat_call_id=pipecat_call_id, event_type="answered")
    await post_event(pipecat_call_id=pipecat_call_id, event_type="in_progress")

    try:
        from pipecat.serializers.twilio import TwilioFrameSerializer
        from pipecat.transports.network.fastapi_websocket import (
            FastAPIWebsocketParams,
            FastAPIWebsocketTransport,
        )

        serializer = TwilioFrameSerializer(stream_sid=pipecat_call_id, call_sid=record.carrier_call_sid or pipecat_call_id)
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(audio_in_enabled=True, audio_out_enabled=True, serializer=serializer),
        )
        runner, task = await build_pipeline(
            transport=transport,
            agent_config={"agent_version_id": record.agent_version_id},
            transfer_destination_e164=record.transfer_destination_e164,
        )
        await runner.run(task)
    except PipelineNotAvailableError as exc:
        logger.error("pipecat pipeline unavailable for call %s: %s", pipecat_call_id, exc)
        record.status = "failed"
        record.ended_reason = str(exc)
        await post_event(pipecat_call_id=pipecat_call_id, event_type="failed", extra={"ended_reason": str(exc)})
    except WebSocketDisconnect:
        pass
    finally:
        if record.status not in ("completed", "failed"):
            record.status = "completed"
        import time as _time

        record.ended_at = _time.time()
        await post_event(pipecat_call_id=pipecat_call_id, event_type=record.status, extra={"ended_reason": record.ended_reason})
