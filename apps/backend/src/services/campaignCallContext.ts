/**
 * Everything a call placed or answered "as" a campaign needs, resolved
 * from the campaign's current (published) version snapshot: the agent
 * version, voice, phone number pool, transfer number, script, knowledge
 * bases and calling rules. Shared by the campaign dialer
 * (campaignDispatcher.ts), the callback dialer (callbackDispatcher.ts) and
 * inbound calls (inboundCalls.ts) so all three behave identically.
 */
import type { CampaignCallingRulesSnapshot } from '@shivanshconnect/shared';
import type { getSupabaseAdmin } from '../lib/supabase.js';
import { resolveDefaultEngine } from './callOrigination.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface CampaignCallContext {
  campaign: Record<string, any>;
  version: Record<string, any>;
  callingRules: CampaignCallingRulesSnapshot | null;
  agentVersionRow: Record<string, any> | null;
  voiceOverride: { providerKey: string; providerVoiceId: string } | null;
  phoneNumberPool: Record<string, any>[];
  engine: 'vapi' | 'pipecat';
  transferDestination: string | null;
  scriptId: string | null;
  knowledgeBaseIds: string[];
  callingRulesOverride: {
    voicemail_detection_enabled: boolean;
    voicemail_message: string | null;
    leave_voicemail: boolean;
    background_noise: CampaignCallingRulesSnapshot['background_noise'];
  } | null;
}

export async function loadCampaignCallContext(supabase: Supabase, campaign: Record<string, any>, versionRow?: Record<string, any> | null): Promise<CampaignCallContext | null> {
  let version = versionRow ?? null;
  if (!version) {
    if (!campaign.current_version_id) return null;
    const { data } = await supabase.from('campaign_versions').select('*').eq('id', campaign.current_version_id).maybeSingle();
    version = data;
  }
  if (!version) return null;
  const orgId = campaign.organization_id as string;
  const callingRules = (version.calling_rules as CampaignCallingRulesSnapshot | null) ?? null;

  const [agentVersionResult, poolResult, voiceResult, engine] = await Promise.all([
    version.ai_agent_version_id
      ? supabase.from('ai_agent_versions').select('*').eq('id', version.ai_agent_version_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('campaign_phone_numbers').select('phone_numbers(*)').eq('campaign_id', campaign.id),
    version.voice_id
      ? supabase.from('voices').select('provider_key, provider_voice_id').eq('id', version.voice_id).maybeSingle()
      : Promise.resolve({ data: null }),
    resolveDefaultEngine(supabase, orgId),
  ]);

  let phoneNumberPool: Record<string, any>[] = (((poolResult as { data: any[] | null }).data ?? []) as any[]).map((row) => row.phone_numbers).filter(Boolean);
  if (phoneNumberPool.length === 0 && campaign.phone_number_id) {
    // Legacy fallback: a campaign that predates the pool (or whose pool
    // row was somehow never backfilled) still dials from its single
    // configured number exactly as before.
    const { data } = await supabase.from('phone_numbers').select('*').eq('id', campaign.phone_number_id).maybeSingle();
    if (data) phoneNumberPool = [data];
  }
  const voice = (voiceResult as { data: { provider_key: string; provider_voice_id: string } | null }).data;

  return {
    campaign,
    version,
    callingRules,
    agentVersionRow: (agentVersionResult as { data: Record<string, any> | null }).data,
    voiceOverride: voice ? { providerKey: voice.provider_key, providerVoiceId: voice.provider_voice_id } : null,
    phoneNumberPool,
    engine,
    transferDestination: version.transfer_number_e164 ?? campaign.transfer_number_e164 ?? null,
    scriptId: version.script_id ?? null,
    knowledgeBaseIds: version.knowledge_base_ids ?? [],
    callingRulesOverride: callingRules
      ? {
          voicemail_detection_enabled: callingRules.voicemail_detection_enabled,
          voicemail_message: callingRules.voicemail_message,
          leave_voicemail: callingRules.leave_voicemail,
          background_noise: callingRules.background_noise,
        }
      : null,
  };
}
