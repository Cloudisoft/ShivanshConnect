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
    # Real per-lead personalization parity with VapiProvider's
    # assistantOverrides (see lib/orchestration/pipecat.ts's createCall() -
    # these are the SAME server-resolved, already-renderTemplate()'d
    # strings Node sends Vapi). Optional: absent means "no lead context /
    # no name" was resolvable on the Node side either, so the pipeline
    # falls back to whatever this service's own defaults produce.
    first_message_override: Optional[str] = None
    system_prompt_override: Optional[str] = None


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
