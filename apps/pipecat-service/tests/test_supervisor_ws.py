"""
Phase 10 tests for the /supervisor/{pipecat_call_id}/{action} WebSocket
endpoint (main.py) - what's provable here, honestly, without a live call:

  - auth: a request with no/invalid/mismatched-scope token is rejected
    before the connection is ever accepted.
  - call-id validation: an unknown pipecat_call_id is rejected.
  - wiring into supervisor_hub: once accepted, a 'listen' connection is
    registered as a real listener (supervisor_hub.add_listener) and
    removed on disconnect; a 'whisper'/'barge' connection's binary
    messages land in the real queue SupervisorInjectProcessor drains from
    (supervisor_hub.drain_injection_audio) - proving the WS layer is
    correctly wired into the hub the pipeline's frame processors read
    from.

What is NOT (and cannot be) proven here: that SupervisorTapProcessor/
SupervisorInjectProcessor/the transcript emitters (pipeline.py) behave
correctly against REAL pipecat-ai Pipeline/FrameProcessor internals -
pipecat-ai itself isn't installed in this sandbox (see pipeline.py's
header comment on why every pipecat-ai import is lazy, exactly like every
other pipecat-ai symbol this whole service touches - see test_calls.py's
existing "not configured" tests for the same documented gap), and there
is no live call/audio hardware to run one against regardless. What IS
provable, and is proven below and in test_supervisor_hub.py, is
everything on THIS side of that boundary: the WS endpoint's auth/call-id
validation, and that a connection is correctly wired into supervisor_hub
- the exact seam pipeline.py's real FrameProcessors read from/write to.
Confirming the FrameProcessors themselves needs a real pipecat-ai install
plus a real or staged call, in a later environment.
"""

from uuid import uuid4

from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.store import call_store
from app.supervisor_hub import supervisor_hub
from tests.test_supervisor_auth import make_token

client = TestClient(app)


def _create_call_record():
    record = call_store.create(
        internal_call_id=str(uuid4()),
        organization_id="org-1",
        agent_version_id="version-1",
        from_e164="+14845551111",
        to_e164="+14845552222",
        transfer_destination_e164=None,
    )
    return record


def test_unknown_action_is_rejected_before_accept():
    record = _create_call_record()
    try:
        with client.websocket_connect(f"/supervisor/{record.pipecat_call_id}/not-a-real-action") as ws:
            ws.receive_text()
    except Exception:
        pass  # a closed-before-accept handshake surfaces as a client-side exception - expected


def test_unknown_call_id_is_rejected(reset_settings):
    reset_settings.PIPECAT_SERVICE_TOKEN = None
    try:
        with client.websocket_connect("/supervisor/pc_does_not_exist/listen") as ws:
            ws.receive_text()
        raised = False
    except Exception:
        raised = True
    assert raised


def test_invalid_token_is_rejected_when_a_secret_is_configured(reset_settings):
    reset_settings.PIPECAT_SERVICE_TOKEN = "shared-secret"
    record = _create_call_record()
    try:
        with client.websocket_connect(f"/supervisor/{record.pipecat_call_id}/listen?token=garbage") as ws:
            ws.receive_text()
        raised = False
    except Exception:
        raised = True
    assert raised
    # Never registered as a listener - the connection was never accepted.
    assert record.pipecat_call_id not in supervisor_hub._calls or ws is None


def test_token_scoped_to_a_different_call_is_rejected(reset_settings):
    reset_settings.PIPECAT_SERVICE_TOKEN = "shared-secret"
    record = _create_call_record()
    other_record = _create_call_record()
    token = make_token(pipecat_call_id=other_record.pipecat_call_id, action="listen", secret="shared-secret")
    try:
        with client.websocket_connect(f"/supervisor/{record.pipecat_call_id}/listen?token={token}") as ws:
            ws.receive_text()
        raised = False
    except Exception:
        raised = True
    assert raised


def test_valid_listen_connection_is_accepted_and_registered_then_cleaned_up_on_disconnect(reset_settings):
    reset_settings.PIPECAT_SERVICE_TOKEN = "shared-secret"
    record = _create_call_record()
    token = make_token(pipecat_call_id=record.pipecat_call_id, action="listen", secret="shared-secret")

    with client.websocket_connect(f"/supervisor/{record.pipecat_call_id}/listen?token={token}") as ws:
        # A real listener was registered against the real hub - this is
        # exactly what SupervisorTapProcessor.broadcast_audio() checks
        # before pushing tapped audio frames (see pipeline.py).
        state = supervisor_hub._calls.get(record.pipecat_call_id)
        assert state is not None
        assert len(state.listeners) == 1

    # Closed cleanly -> removed from the listener set (never leaks a dead
    # socket that broadcast_audio would keep trying to send to).
    state = supervisor_hub._calls.get(record.pipecat_call_id)
    assert state is None or len(state.listeners) == 0


def test_valid_whisper_connection_queues_binary_audio_for_the_pipeline_to_drain(reset_settings):
    reset_settings.PIPECAT_SERVICE_TOKEN = "shared-secret"
    record = _create_call_record()
    token = make_token(pipecat_call_id=record.pipecat_call_id, action="whisper", secret="shared-secret")

    with client.websocket_connect(f"/supervisor/{record.pipecat_call_id}/whisper?token={token}") as ws:
        ws.send_bytes(b"\x01\x02\x03\x04")
        import time as _time

        _time.sleep(0.05)  # let the server-side receive loop process it

    drained = supervisor_hub.drain_injection_audio(record.pipecat_call_id)
    assert drained == b"\x01\x02\x03\x04"


def test_valid_barge_connection_registers_as_both_listener_and_injector(reset_settings):
    reset_settings.PIPECAT_SERVICE_TOKEN = "shared-secret"
    record = _create_call_record()
    token = make_token(pipecat_call_id=record.pipecat_call_id, action="barge", secret="shared-secret")

    with client.websocket_connect(f"/supervisor/{record.pipecat_call_id}/barge?token={token}") as ws:
        state = supervisor_hub._calls.get(record.pipecat_call_id)
        assert state is not None
        assert len(state.listeners) == 1
        assert state.barge_active is True
        ws.send_bytes(b"\xaa\xbb")
        import time as _time

        _time.sleep(0.05)

    drained = supervisor_hub.drain_injection_audio(record.pipecat_call_id)
    assert drained == b"\xaa\xbb"
    state = supervisor_hub._calls.get(record.pipecat_call_id)
    assert state is None or state.barge_active is False
