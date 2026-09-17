"""
Phase 10 unit tests: supervisor_auth.py's HMAC token verification. These
mint tokens directly in Python using the SAME algorithm
apps/backend/src/lib/pipecatSupervisorToken.ts uses (see that file's
header comment) - a genuine cross-language round-trip is exercised by
test_supervisor_ws.py instead, using a token minted the way the real
Node backend would.
"""

import base64
import hashlib
import hmac
import json
import time

from app.supervisor_auth import authorize_supervisor_connection, verify_supervisor_token

SECRET = "test-shared-secret"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def make_token(*, pipecat_call_id="pc_1", action="listen", organization_id="org-1", exp=None, secret=SECRET):
    payload = {
        "pipecat_call_id": pipecat_call_id,
        "action": action,
        "organization_id": organization_id,
        "exp": exp if exp is not None else time.time() + 300,
    }
    payload_b64 = _b64url(json.dumps(payload).encode("utf-8"))
    sig = _b64url(hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest())
    return f"{payload_b64}.{sig}"


def test_verify_supervisor_token_accepts_a_validly_signed_unexpired_token():
    token = make_token()
    payload = verify_supervisor_token(token, SECRET)
    assert payload is not None
    assert payload["pipecat_call_id"] == "pc_1"
    assert payload["action"] == "listen"


def test_verify_supervisor_token_rejects_a_tampered_payload():
    token = make_token()
    payload_b64, sig_b64 = token.split(".")
    tampered_payload = _b64url(json.dumps({"pipecat_call_id": "pc_EVIL", "action": "listen", "organization_id": "org-1", "exp": time.time() + 300}).encode())
    tampered = f"{tampered_payload}.{sig_b64}"
    assert verify_supervisor_token(tampered, SECRET) is None


def test_verify_supervisor_token_rejects_wrong_secret():
    token = make_token()
    assert verify_supervisor_token(token, "wrong-secret") is None


def test_verify_supervisor_token_rejects_expired_token():
    token = make_token(exp=time.time() - 10)
    assert verify_supervisor_token(token, SECRET) is None


def test_verify_supervisor_token_rejects_malformed_token():
    assert verify_supervisor_token("not-a-real-token", SECRET) is None
    assert verify_supervisor_token("", SECRET) is None


def test_authorize_supervisor_connection_requires_matching_call_id_and_action():
    token = make_token(pipecat_call_id="pc_1", action="listen")
    assert authorize_supervisor_connection(token=token, secret=SECRET, pipecat_call_id="pc_1", action="listen") is True
    # A token minted for one call can never be replayed against another.
    assert authorize_supervisor_connection(token=token, secret=SECRET, pipecat_call_id="pc_OTHER", action="listen") is False
    # A token minted for 'listen' can never be used to open 'barge'.
    assert authorize_supervisor_connection(token=token, secret=SECRET, pipecat_call_id="pc_1", action="barge") is False


def test_authorize_supervisor_connection_unconfigured_secret_allows_through_local_dev_only():
    assert authorize_supervisor_connection(token=None, secret=None, pipecat_call_id="pc_1", action="listen") is True


def test_authorize_supervisor_connection_missing_token_rejected_when_secret_configured():
    assert authorize_supervisor_connection(token=None, secret=SECRET, pipecat_call_id="pc_1", action="listen") is False
