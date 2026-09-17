/**
 * Phase 7: campaign preflight validation (spec section 9).
 *
 * Every check here is a real query against stored state - never a
 * hardcoded `ready: true`. Returns every failing check (not just the
 * first) so the pre-launch confirmation modal can show the caller
 * everything that needs fixing at once.
 */
import type { getSupabaseAdmin } from '../lib/supabase.js';
import type { PreflightError, PreflightResult } from '@shivanshconnect/shared';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export async function runCampaignPreflight(supabase: Supabase, orgId: string, campaignId: string): Promise<PreflightResult> {
  const errors: PreflightError[] = [];

  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaignId).maybeSingle();
  if (!campaign || campaign.organization_id !== orgId) {
    return { ready: false, errors: [{ code: 'campaign_not_found', message: 'Campaign not found.' }] };
  }

  if (!campaign.current_version_id) {
    errors.push({ code: 'no_published_version', message: 'Campaign cannot start because it has no published configuration version. Publish a version first.' });
  } else {
    const { data: version } = await supabase.from('campaign_versions').select('*').eq('id', campaign.current_version_id).maybeSingle();
    if (!version) {
      errors.push({ code: 'no_published_version', message: 'Campaign cannot start because its published version could not be found.' });
    } else {
      if (!version.ai_agent_version_id) {
        errors.push({ code: 'no_agent', message: 'Campaign cannot start because no AI agent is configured for this version.' });
      } else {
        const { data: agentVersion } = await supabase.from('ai_agent_versions').select('id, agent_id, status').eq('id', version.ai_agent_version_id).maybeSingle();
        if (!agentVersion) {
          errors.push({ code: 'agent_version_missing', message: 'Campaign cannot start because the snapshotted agent version no longer exists.' });
        } else {
          const { data: agent } = await supabase.from('ai_agents').select('id, status').eq('id', agentVersion.agent_id).maybeSingle();
          if (!agent || agent.status !== 'active') {
            errors.push({ code: 'agent_inactive', message: 'Campaign cannot start because its AI agent is not active.' });
          }
          if (agentVersion.status !== 'published' && agentVersion.status !== 'archived') {
            errors.push({ code: 'agent_version_not_published', message: 'Campaign cannot start because its snapshotted agent version was never published.' });
          }
        }
      }

      if (version.voice_id) {
        const { data: voice } = await supabase.from('voices').select('id, provider_key, status').eq('id', version.voice_id).maybeSingle();
        if (!voice || voice.status !== 'active') {
          errors.push({ code: 'voice_inactive', message: 'Campaign cannot start because its configured voice is not active.' });
        } else {
          const { data: providerCreds } = await supabase
            .from('voice_provider_credentials')
            .select('status')
            .eq('organization_id', orgId)
            .eq('provider_key', voice.provider_key)
            .maybeSingle();
          if (!providerCreds || providerCreds.status !== 'connected') {
            errors.push({ code: 'voice_provider_not_connected', message: `Campaign cannot start because the "${voice.provider_key}" voice provider is not connected.` });
          }
        }
      }

      const kbIds: string[] = version.knowledge_base_ids ?? [];
      if (kbIds.length > 0) {
        const { data: docs } = await supabase.from('knowledge_documents').select('id, status').in('knowledge_base_id', kbIds);
        const notReady = (docs ?? []).filter((d: any) => d.status !== 'ready');
        if (notReady.length > 0) {
          errors.push({ code: 'knowledge_base_not_ready', message: `Campaign cannot start because ${notReady.length} attached knowledge base document(s) are not ready.` });
        }
      }
    }
  }

  if (!campaign.phone_number_id) {
    errors.push({ code: 'no_phone_number', message: 'Campaign cannot start because no phone number is assigned.' });
  } else {
    const { data: phoneNumber } = await supabase.from('phone_numbers').select('*').eq('id', campaign.phone_number_id).maybeSingle();
    if (!phoneNumber || phoneNumber.organization_id !== orgId) {
      errors.push({ code: 'phone_number_missing', message: 'Campaign cannot start because its assigned phone number could not be found.' });
    } else if (phoneNumber.status !== 'active') {
      errors.push({ code: 'phone_number_inactive', message: 'Campaign cannot start because its assigned phone number is not active.' });
    } else if (phoneNumber.provider_key === 'twilio' || phoneNumber.provider_key === 'telnyx') {
      const { data: telCreds } = await supabase
        .from('phone_number_provider_credentials')
        .select('status')
        .eq('organization_id', orgId)
        .eq('provider_key', phoneNumber.provider_key)
        .maybeSingle();
      if (!telCreds || telCreds.status !== 'connected') {
        errors.push({ code: 'telephony_provider_not_connected', message: `Campaign cannot start because the "${phoneNumber.provider_key}" telephony provider is not connected.` });
      }
    }
  }

  if (!campaign.transfer_number_e164) {
    errors.push({ code: 'no_transfer_number', message: 'Campaign cannot start because no transfer number has been set.' });
  } else if (!/^\+[1-9]\d{6,14}$/.test(campaign.transfer_number_e164)) {
    errors.push({ code: 'invalid_transfer_number', message: 'Campaign cannot start because its transfer number is not a valid E.164 number.' });
  }

  if (campaign.calling_window_start >= campaign.calling_window_end) {
    errors.push({ code: 'invalid_calling_window', message: 'Campaign cannot start because its calling window start time is not before its end time.' });
  }
  if (!Array.isArray(campaign.calling_days) || campaign.calling_days.length === 0) {
    errors.push({ code: 'no_calling_days', message: 'Campaign cannot start because it has no calling days selected.' });
  }

  const { count: eligibleLeadCount } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['pending', 'retry_pending']);
  if (!eligibleLeadCount || eligibleLeadCount === 0) {
    errors.push({ code: 'no_eligible_leads', message: 'Campaign cannot start because no eligible leads remain.' });
  }

  const engine = campaign.engine ?? 'vapi';
  if (engine === 'vapi') {
    const { data: vapiCreds } = await supabase.from('vapi_credentials').select('status').eq('organization_id', orgId).maybeSingle();
    if (!vapiCreds || vapiCreds.status !== 'connected') {
      errors.push({ code: 'orchestration_engine_not_configured', message: 'Campaign cannot start because the Vapi call engine is not configured for this organization.' });
    }
  } else if (!process.env.PIPECAT_SERVICE_URL) {
    errors.push({ code: 'orchestration_engine_not_configured', message: 'Campaign cannot start because the pipecat call engine is not configured for this organization.' });
  }

  const { data: dialingSettings } = await supabase.from('dialing_settings').select('max_concurrency').eq('organization_id', orgId).eq('is_default', true).maybeSingle();
  const orgMaxConcurrency = dialingSettings?.max_concurrency ?? 25;
  if (campaign.concurrency_limit > orgMaxConcurrency * 4) {
    errors.push({ code: 'concurrency_too_high', message: `Campaign cannot start because its concurrency limit (${campaign.concurrency_limit}) far exceeds the organization's reasonable global cap.` });
  }

  return { ready: errors.length === 0, errors };
}
