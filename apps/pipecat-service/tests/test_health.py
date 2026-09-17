from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_is_always_ok():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_readiness_reports_not_ready_when_unconfigured():
    res = client.get("/readiness")
    assert res.status_code == 503
    body = res.json()
    assert body["ready"] is False
    assert body["llm_configured"] is False
    assert body["stt_configured"] is False
    assert body["tts_configured"] is False
    assert "OPENAI_API_KEY (LLM)" in body["missing"]
    assert "DEEPGRAM_API_KEY (STT)" in body["missing"]


def test_readiness_reports_ready_once_every_requirement_is_set(reset_settings):
    reset_settings.OPENAI_API_KEY = "sk-test"
    reset_settings.DEEPGRAM_API_KEY = "dg-test"
    reset_settings.ELEVENLABS_API_KEY = "el-test"
    reset_settings.PUBLIC_MEDIA_STREAM_URL = "wss://pipecat.example.com"

    res = client.get("/readiness")
    assert res.status_code == 200
    body = res.json()
    assert body["ready"] is True
    assert body["missing"] == []
