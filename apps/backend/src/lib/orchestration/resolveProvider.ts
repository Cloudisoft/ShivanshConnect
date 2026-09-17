/**
 * Resolves the real orchestration provider adapter for an existing
 * `calls` row, decrypting the org's stored Vapi credential exactly the
 * way services/callOrigination.ts does at call-creation time. Extracted
 * out of services/processCallArtifacts.ts (Phase 9) so Phase 10's Live
 * Monitor action routes (routes/liveMonitor.ts - listen/whisper/barge/
 * transfer/end) resolve the provider through the exact same single code
 * path rather than a second, potentially-drifting copy.
 */
import type { getSupabaseAdmin } from '../supabase.js';
import { decryptCredentials, type EncryptedEnvelope } from '../crypto/credentials.js';
import { createOrchestrationProvider, OrchestrationProviderNotConfiguredError, type CallOrchestrationProvider } from './index.js';
import { VapiProvider } from './vapi.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export async function resolveProviderForCall(supabase: Supabase, call: Record<string, any>): Promise<CallOrchestrationProvider> {
  if (call.engine === 'vapi') {
    const { data: credRow } = await supabase.from('vapi_credentials').select('encrypted_credentials').eq('organization_id', call.organization_id).maybeSingle();
    if (!credRow) throw new OrchestrationProviderNotConfiguredError('Vapi is not connected for this organization.');
    const apiKey = decryptCredentials<{ api_key: string }>(credRow.encrypted_credentials as EncryptedEnvelope).api_key;
    return createOrchestrationProvider('vapi', { api_key: apiKey }) as VapiProvider;
  }
  return createOrchestrationProvider('pipecat');
}
