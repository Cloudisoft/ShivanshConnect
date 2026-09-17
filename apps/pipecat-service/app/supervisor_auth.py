"""
Phase 10: verifies the short-lived, HMAC-signed supervisor tokens Node's
`lib/pipecatSupervisorToken.ts` mints for Live Monitor's listen/whisper/
barge actions. Byte-for-byte the same scheme as that file - keep the two
in sync if this ever changes:

    token := base64url(json(payload)) + "." + base64url(hmac_sha256(secret, base64url(json(payload))))
    payload := { pipecat_call_id, action, organization_id, exp }

`secret` is this service's own PIPECAT_SERVICE_TOKEN (settings.
PIPECAT_SERVICE_TOKEN) - the same shared secret already used to
authenticate every other Node<->pipecat-service call, reused here rather
than inventing a second one to rotate.

When PIPECAT_SERVICE_TOKEN is unset (local/dev only, matching every other
honest-default in this service), verification is skipped entirely - the
same documented posture as require_auth() in main.py.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Optional, TypedDict


class SupervisorTokenPayload(TypedDict):
    pipecat_call_id: str
    action: str
    organization_id: str
    exp: float


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def _b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def verify_supervisor_token(token: str, secret: str) -> Optional[SupervisorTokenPayload]:
    """Returns the decoded payload when `token` is a validly-signed,
    unexpired token; None otherwise (a malformed token, a bad signature,
    or an expired one - never raises, so callers always get a clean
    accept/reject decision)."""
    try:
        payload_b64, sig_b64 = token.split(".")
    except ValueError:
        return None

    expected_sig = _b64url_encode(hmac.new(secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig_b64, expected_sig):
        return None

    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        return None

    if not isinstance(payload, dict) or "exp" not in payload:
        return None
    if float(payload["exp"]) < time.time():
        return None
    return payload  # type: ignore[return-value]


def authorize_supervisor_connection(
    *,
    token: Optional[str],
    secret: Optional[str],
    pipecat_call_id: str,
    action: str,
) -> bool:
    """The single check main.py's /supervisor/{call_id}/{action} WS route
    runs before accepting a connection: token must verify AND must be
    scoped to exactly this call id and action (a valid 'listen' token can
    never be replayed to open a 'barge' connection, and a token minted for
    one call can never be used against another)."""
    if not secret:
        return True  # unconfigured - local/dev only, see header comment
    if not token:
        return False
    payload = verify_supervisor_token(token, secret)
    if not payload:
        return False
    return payload["pipecat_call_id"] == pipecat_call_id and payload["action"] == action
