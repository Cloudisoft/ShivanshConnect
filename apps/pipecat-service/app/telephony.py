"""
Phase 6: outbound carrier call origination for apps/pipecat-service.

Places the REAL outbound call via Twilio's or Telnyx's own REST API,
using credentials that arrive TRANSIENTLY in the POST /calls request body
(see app/schemas.py's TelephonyCredentials) - never read from this
service's own environment, never persisted, never logged. This is the
concrete shape the Phase 6 task brief's "short-lived, scoped credential
fetch" option takes in this codebase: the Node backend resolves and
decrypts the org's already-stored Twilio/Telnyx credentials (Phase 5's
existing tables/adapters - nothing duplicated) and hands them to this one
request; this function uses them exactly once, synchronously, and they go
out of scope the moment the HTTP handler returns.

Both carriers are told to stream the call's audio to this service's own
publicly reachable WebSocket media-stream endpoint
(settings.PUBLIC_MEDIA_STREAM_URL + f"/media-stream/{pipecat_call_id}"),
which is where app/pipeline.py's real pipecat-ai pipeline actually
attaches once the carrier connects.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

import httpx

TWILIO_API_BASE = "https://api.twilio.com/2010-04-01"
TELNYX_API_BASE = "https://api.telnyx.com/v2"


class TelephonyOriginationError(Exception):
    """Raised when the real carrier REST call fails - never silently
    treated as success, never a simulated call SID returned."""


@dataclass
class OriginatedCall:
    carrier: Literal["twilio", "telnyx"]
    carrier_call_sid: str


async def originate_twilio_call(
    *, account_sid: str, auth_token: str, from_e164: str, to_e164: str, stream_ws_url: str
) -> OriginatedCall:
    """Places a real outbound call via Twilio's Calls API
    (POST /2010-04-01/Accounts/{Sid}/Calls.json), using inline TwiML that
    opens a bidirectional Media Stream to our own WebSocket endpoint - the
    real, documented mechanism Twilio offers for exactly this (a
    <Connect><Stream> verb). See
    https://www.twilio.com/docs/voice/twiml/stream for the real API this
    mirrors.
    """
    twiml = f'<Response><Connect><Stream url="{stream_ws_url}" /></Connect></Response>'
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            res = await client.post(
                f"{TWILIO_API_BASE}/Accounts/{account_sid}/Calls.json",
                auth=(account_sid, auth_token),
                data={"From": from_e164, "To": to_e164, "Twiml": twiml},
            )
        except httpx.HTTPError as exc:
            raise TelephonyOriginationError(f"Failed to reach the Twilio API: {exc}") from exc
    if res.status_code >= 300:
        raise TelephonyOriginationError(f"Twilio call origination failed ({res.status_code}): {res.text[:500]}")
    body = res.json()
    return OriginatedCall(carrier="twilio", carrier_call_sid=body["sid"])


async def originate_telnyx_call(
    *, api_key: str, from_e164: str, to_e164: str, stream_ws_url: str
) -> OriginatedCall:
    """Places a real outbound call via Telnyx's Call Control API
    (POST /v2/calls), with `stream_url` set inline so Telnyx opens its own
    bidirectional Media Streaming WebSocket to our endpoint immediately on
    answer - Telnyx's real, documented mechanism
    (https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming).
    `connection_id` is expected to already exist as a Telnyx "Call Control
    Application" tied to this api_key's account; a fresh deployment must
    create one in the Telnyx portal first (see README.md).
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            res = await client.post(
                f"{TELNYX_API_BASE}/calls",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "to": to_e164,
                    "from": from_e164,
                    "stream_url": stream_ws_url,
                    "stream_track": "both_tracks",
                },
            )
        except httpx.HTTPError as exc:
            raise TelephonyOriginationError(f"Failed to reach the Telnyx API: {exc}") from exc
    if res.status_code >= 300:
        raise TelephonyOriginationError(f"Telnyx call origination failed ({res.status_code}): {res.text[:500]}")
    body = res.json()
    call_control_id = body.get("data", {}).get("call_control_id")
    if not call_control_id:
        raise TelephonyOriginationError("Telnyx response did not include a call_control_id.")
    return OriginatedCall(carrier="telnyx", carrier_call_sid=call_control_id)
