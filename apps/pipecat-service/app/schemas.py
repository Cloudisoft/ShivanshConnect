from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel


class TelephonyCredentials(BaseModel):
    provider: Literal["twilio", "telnyx"]
    account_sid: Optional[str] = None
    auth_token: Optional[str] = None
    api_key: Optional[str] = None


class CreateCallRequest(BaseModel):
    internal_call_id: str
    organization_id: str
    agent_version_id: str
    from_e164: str
    to_e164: str
    transfer_destination_e164: Optional[str] = None
    telephony: TelephonyCredentials


class CreateCallResponse(BaseModel):
    pipecat_call_id: str
    status: str


class TransferRequest(BaseModel):
    destination_e164: str


class WebhookConfigRequest(BaseModel):
    url: str


class ArtifactsResponse(BaseModel):
    recording_url: Optional[str] = None
    transcript_url: Optional[str] = None
    transcript: Optional[str] = None
