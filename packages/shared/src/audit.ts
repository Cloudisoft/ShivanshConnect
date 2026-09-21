export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

/** Known audit actions used by Phase 1 handlers. Not an exhaustive enum -
 * future phases may write additional free-form actions. */
export const AUDIT_ACTIONS = {
  USER_INVITED: 'user.invited',
  USER_INVITATION_REVOKED: 'user.invitation_revoked',
  USER_INVITATION_ACCEPTED: 'user.invitation_accepted',
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_DEACTIVATED: 'user.deactivated',
  USER_REACTIVATED: 'user.reactivated',
  USER_UPDATED: 'user.updated',
  ORGANIZATION_SETTINGS_CHANGED: 'organization.settings_changed',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DELETED: 'role.deleted',
  ROLE_PERMISSIONS_CHANGED: 'role.permissions_changed',

  LEAD_LIST_CREATED: 'lead_list.created',
  LEAD_LIST_UPDATED: 'lead_list.updated',
  LEAD_LIST_DELETED: 'lead_list.deleted',
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_DELETED: 'lead.deleted',
  LEAD_BULK_ACTION: 'lead.bulk_action',
  DNC_ENTRY_ADDED: 'dnc.entry_added',
  DNC_ENTRY_REMOVED: 'dnc.entry_removed',
  IMPORT_JOB_CREATED: 'import_job.created',
  IMPORT_JOB_COMMITTED: 'import_job.committed',

  AGENT_CREATED: 'agent.created',
  AGENT_UPDATED: 'agent.updated',
  AGENT_DELETED: 'agent.deleted',
  AGENT_VERSION_CREATED: 'agent_version.created',
  AGENT_VERSION_UPDATED: 'agent_version.updated',
  AGENT_VERSION_PUBLISHED: 'agent_version.published',
  AGENT_VERSION_RESTORED: 'agent_version.restored',
  SCRIPT_CREATED: 'script.created',
  SCRIPT_UPDATED: 'script.updated',
  SCRIPT_DELETED: 'script.deleted',
  KNOWLEDGE_BASE_CREATED: 'knowledge_base.created',
  KNOWLEDGE_DOCUMENT_UPLOADED: 'knowledge_document.uploaded',
  KNOWLEDGE_DOCUMENT_DELETED: 'knowledge_document.deleted',
  KNOWLEDGE_DOCUMENT_REPROCESSED: 'knowledge_document.reprocessed',

  VOICE_PROVIDER_CREDENTIALS_SAVED: 'voice_provider.credentials_saved',
  VOICE_PROVIDER_CONNECTION_TESTED: 'voice_provider.connection_tested',
  VOICE_SYNCED: 'voice.synced',
  VOICE_CLONE_REQUESTED: 'voice.clone_requested',
  VOICE_DELETED: 'voice.deleted',

  TELEPHONY_PROVIDER_CREDENTIALS_SAVED: 'telephony_provider.credentials_saved',
  TELEPHONY_PROVIDER_CONNECTION_TESTED: 'telephony_provider.connection_tested',
  PHONE_NUMBER_SYNCED: 'phone_number.synced',
  PHONE_NUMBER_PURCHASED: 'phone_number.purchased',
  PHONE_NUMBER_IMPORTED: 'phone_number.imported',
  PHONE_NUMBER_UPDATED: 'phone_number.updated',
  PHONE_NUMBER_DELETED: 'phone_number.deleted',

  VAPI_CREDENTIALS_SAVED: 'vapi.credentials_saved',
  VAPI_CONNECTION_TESTED: 'vapi.connection_tested',
  CALL_CREATED: 'call.created',
  CALL_TRANSFER_REQUESTED: 'call.transfer_requested',
  WEBHOOK_EVENT_REPLAYED: 'webhook_event.replayed',

  CAMPAIGN_CREATED: 'campaign.created',
  CAMPAIGN_UPDATED: 'campaign.updated',
  CAMPAIGN_DELETED: 'campaign.deleted',
  CAMPAIGN_DUPLICATED: 'campaign.duplicated',
  CAMPAIGN_VERSION_CREATED: 'campaign_version.created',
  CAMPAIGN_VERSION_PUBLISHED: 'campaign_version.published',
  CAMPAIGN_STARTED: 'campaign.started',
  CAMPAIGN_PAUSED: 'campaign.paused',
  CAMPAIGN_RESUMED: 'campaign.resumed',
  CAMPAIGN_STOPPED: 'campaign.stopped',
  CAMPAIGN_ARCHIVED: 'campaign.archived',
  CAMPAIGN_CONCURRENCY_CHANGED: 'campaign.concurrency_changed',
  CAMPAIGN_LEADS_ATTACHED: 'campaign.leads_attached',
  CAMPAIGN_LEADS_ROTATED: 'campaign.leads_rotated',
  DIALING_SETTINGS_UPDATED: 'dialing_settings.updated',

  DISPOSITION_CREATED: 'disposition.created',
  DISPOSITION_UPDATED: 'disposition.updated',
  DISPOSITION_DELETED: 'disposition.deleted',
  CALL_DISPOSITION_OVERRIDDEN: 'call_disposition.overridden',

  CALLBACK_CREATED: 'callback.created',
  CALLBACK_UPDATED: 'callback.updated',
  CALLBACK_CANCELLED: 'callback.cancelled',

  LEAD_DNC_REQUESTED_ON_CALL: 'lead.dnc_requested_on_call',

  CDR_EXPORT_CREATED: 'cdr.export_created',

  // Phase 14: the export engine generalized beyond CDR.
  LEADS_EXPORT_CREATED: 'leads.export_created',
  SMS_MESSAGES_EXPORT_CREATED: 'sms_messages.export_created',
  EMAIL_MESSAGES_EXPORT_CREATED: 'email_messages.export_created',

  // Phase 10: Live Monitor supervisor actions (listen/whisper/barge/
  // transfer/end) - every one of these is audit logged with who did what
  // to which call and when (master spec sections 18/19).
  CALL_LISTEN_STARTED: 'call.listen_started',
  CALL_WHISPER_STARTED: 'call.whisper_started',
  CALL_WHISPER_MESSAGE_SENT: 'call.whisper_message_sent',
  CALL_WHISPER_ENDED: 'call.whisper_ended',
  CALL_BARGE_STARTED: 'call.barge_started',
  CALL_BARGE_ENDED: 'call.barge_ended',
  CALL_TRANSFER_SUPERVISOR_INITIATED: 'call.transfer_supervisor_initiated',
  CALL_ENDED_BY_SUPERVISOR: 'call.ended_by_supervisor',

  // Phase 11: AI call evaluator + improvement queue (master spec sections
  // 24/49/86). Evaluation itself runs under the service-role key and is
  // not user-initiated, so it is not audit logged; what IS audit logged
  // is every human decision on an improvement.
  AGENT_IMPROVEMENT_STATUS_CHANGED: 'agent_improvement.status_changed',
  AGENT_IMPROVEMENT_APPLIED: 'agent_improvement.applied',

  // Phase 13: SMTP settings, SMS campaigns, email campaigns (master spec
  // sections 38-41).
  SMTP_SETTINGS_SAVED: 'smtp_settings.saved',
  SMTP_TEST_SENT: 'smtp_settings.test_sent',
  SMS_CAMPAIGN_CREATED: 'sms_campaign.created',
  SMS_CAMPAIGN_UPDATED: 'sms_campaign.updated',
  SMS_CAMPAIGN_DELETED: 'sms_campaign.deleted',
  SMS_CAMPAIGN_STARTED: 'sms_campaign.started',
  SMS_CAMPAIGN_PAUSED: 'sms_campaign.paused',
  SMS_CAMPAIGN_RESUMED: 'sms_campaign.resumed',
  SMS_CAMPAIGN_CANCELLED: 'sms_campaign.cancelled',
  EMAIL_CAMPAIGN_CREATED: 'email_campaign.created',
  EMAIL_CAMPAIGN_UPDATED: 'email_campaign.updated',
  EMAIL_CAMPAIGN_DELETED: 'email_campaign.deleted',
  EMAIL_CAMPAIGN_STARTED: 'email_campaign.started',
  EMAIL_CAMPAIGN_PAUSED: 'email_campaign.paused',
  EMAIL_CAMPAIGN_RESUMED: 'email_campaign.resumed',
  EMAIL_CAMPAIGN_CANCELLED: 'email_campaign.cancelled',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
