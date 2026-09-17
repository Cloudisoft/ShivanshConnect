"""
Phase 6: in-memory call registry for apps/pipecat-service.

This process is the source of truth for exactly one thing: which pipecat-
assigned call ids are currently active and what pipeline config they
should run. It deliberately does NOT persist call status history, cost,
transcripts, or anything else long-term - that lives in the Node backend's
`calls`/`call_events` tables (Phase 6's actual system of record), reached
by posting events to NODE_BACKEND_WEBHOOK_URL (see webhook_client.py).
Losing this process's in-memory state loses only in-flight call handles,
never any durable record - restarting it mid-call would drop that call's
live pipeline, which is an acceptable, documented limitation for this
phase (Phase 10's Live Monitor / production hardening is out of scope
here).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional
from uuid import uuid4


@dataclass
class CallRecord:
    pipecat_call_id: str
    internal_call_id: str
    organization_id: str
    agent_version_id: str
    from_e164: str
    to_e164: str
    transfer_destination_e164: Optional[str]
    status: str = "dialing"
    carrier: Optional[str] = None  # "twilio" | "telnyx"
    carrier_call_sid: Optional[str] = None
    control_ws_connected: bool = False
    recording_url: Optional[str] = None
    transcript: str = ""
    created_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    ended_reason: Optional[str] = None


class CallStore:
    def __init__(self) -> None:
        self._calls: dict[str, CallRecord] = {}

    def create(
        self,
        *,
        internal_call_id: str,
        organization_id: str,
        agent_version_id: str,
        from_e164: str,
        to_e164: str,
        transfer_destination_e164: Optional[str],
    ) -> CallRecord:
        record = CallRecord(
            pipecat_call_id=f"pc_{uuid4().hex[:24]}",
            internal_call_id=internal_call_id,
            organization_id=organization_id,
            agent_version_id=agent_version_id,
            from_e164=from_e164,
            to_e164=to_e164,
            transfer_destination_e164=transfer_destination_e164,
        )
        self._calls[record.pipecat_call_id] = record
        return record

    def get(self, pipecat_call_id: str) -> Optional[CallRecord]:
        return self._calls.get(pipecat_call_id)

    def all(self) -> list[CallRecord]:
        return list(self._calls.values())


# Process-wide singleton - one pipecat-service process handles many
# concurrent calls, each keyed by its own pipecat_call_id.
call_store = CallStore()
