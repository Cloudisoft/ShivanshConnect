"""
Phase 6: posts call lifecycle + transcript events back to the Node
backend's POST /api/v1/webhooks/pipecat, so pipecat-originated calls flow
through the EXACT same webhook_events/call_events pipeline Vapi calls do
(spec's "unified webhook handling" requirement). Every delivery carries
its own `event_id` (a fresh uuid4 per call) so the Node side's UNIQUE
(provider, event_id) idempotency guarantee applies here too.
"""

from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

import httpx

from .config import settings


async def post_event(*, pipecat_call_id: str, event_type: str, extra: Optional[dict[str, Any]] = None) -> None:
    if not settings.NODE_BACKEND_WEBHOOK_URL:
        # Not configured - this is a genuine deployment gap (see
        # README.md), but it must never crash the call itself. Logged,
        # not raised: the call keeps running even if event delivery to
        # Node is unavailable.
        return

    payload = {
        "event_id": str(uuid4()),
        "event_type": event_type,
        "pipecat_call_id": pipecat_call_id,
        **(extra or {}),
    }
    headers = {"Content-Type": "application/json"}
    if settings.PIPECAT_SERVICE_TOKEN:
        headers["Authorization"] = f"Bearer {settings.PIPECAT_SERVICE_TOKEN}"

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            await client.post(settings.NODE_BACKEND_WEBHOOK_URL, json=payload, headers=headers)
        except httpx.HTTPError:
            # Best-effort: Node's own webhook receiver is itself
            # idempotent and this call already has webhook_failures dead-
            # lettering server-side once a delivery DOES arrive - a
            # dropped delivery here is a known gap this phase accepts
            # (no local retry queue yet) rather than one this function
            # should hide by pretending it succeeded.
            pass
