from fastapi.testclient import TestClient

import app.main as main_module
from app.main import app
from app.telephony import OriginatedCall

client = TestClient(app)

VALID_TWILIO_BODY = {
    "internal_call_id": "call-1",
    "organization_id": "org-1",
    "agent_version_id": "version-1",
    "from_e164": "+14845551111",
    "to_e164": "+14845552222",
    "transfer_destination_e164": "+14845559999",
    "telephony": {"provider": "twilio", "account_sid": "AC123", "auth_token": "secret"},
}


def test_create_call_fails_cleanly_with_no_llm_stt_tts_configured():
    """The exact scenario the Phase 6 task brief calls out: no engine
    config at all must fail with a clear error, never a simulated call."""
    res = client.post("/calls", json=VALID_TWILIO_BODY)
    assert res.status_code == 422
    detail = res.json()["detail"]
    assert "not configured" in detail
    assert "OPENAI_API_KEY" in detail


def test_create_call_requires_telephony_credentials_matching_the_provider(reset_settings):
    reset_settings.OPENAI_API_KEY = "sk-test"
    reset_settings.DEEPGRAM_API_KEY = "dg-test"
    reset_settings.ELEVENLABS_API_KEY = "el-test"
    reset_settings.PUBLIC_MEDIA_STREAM_URL = "wss://pipecat.example.com"

    body = dict(VALID_TWILIO_BODY, telephony={"provider": "twilio"})  # missing account_sid/auth_token
    res = client.post("/calls", json=body)
    assert res.status_code == 422
    assert "Twilio credentials" in res.json()["detail"]


def test_create_call_places_a_real_twilio_call_when_fully_configured(reset_settings, monkeypatch):
    reset_settings.OPENAI_API_KEY = "sk-test"
    reset_settings.DEEPGRAM_API_KEY = "dg-test"
    reset_settings.ELEVENLABS_API_KEY = "el-test"
    reset_settings.PUBLIC_MEDIA_STREAM_URL = "wss://pipecat.example.com"

    calls_made = {}

    async def fake_originate_twilio_call(*, account_sid, auth_token, from_e164, to_e164, stream_ws_url):
        calls_made["account_sid"] = account_sid
        calls_made["stream_ws_url"] = stream_ws_url
        return OriginatedCall(carrier="twilio", carrier_call_sid="CA_test_123")

    async def fake_post_event(**kwargs):
        return None

    monkeypatch.setattr(main_module, "originate_twilio_call", fake_originate_twilio_call)
    monkeypatch.setattr(main_module, "post_event", fake_post_event)

    res = client.post("/calls", json=VALID_TWILIO_BODY)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "dialing"
    assert body["pipecat_call_id"].startswith("pc_")
    assert calls_made["account_sid"] == "AC123"
    assert calls_made["stream_ws_url"] == f"wss://pipecat.example.com/media-stream/{body['pipecat_call_id']}"

    get_res = client.get(f"/calls/{body['pipecat_call_id']}")
    assert get_res.status_code == 200
    assert get_res.json()["carrier_call_sid"] == "CA_test_123"


def test_get_unknown_call_is_404():
    res = client.get("/calls/pc_does_not_exist")
    assert res.status_code == 404


def test_requests_are_rejected_without_the_bearer_token_when_one_is_configured(reset_settings):
    reset_settings.PIPECAT_SERVICE_TOKEN = "shared-secret"
    res = client.post("/calls", json=VALID_TWILIO_BODY)
    assert res.status_code == 401

    res_with_token = client.post("/calls", json=VALID_TWILIO_BODY, headers={"Authorization": "Bearer shared-secret"})
    # Still fails (unconfigured provider keys) but past the auth check -
    # a 422, not a 401.
    assert res_with_token.status_code == 422
