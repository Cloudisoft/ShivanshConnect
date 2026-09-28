import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Knowledge base ids a call may search - shared with the live
 * search_knowledge_base tool (services/toolCallHandler.ts). */
export async function knowledgeBaseIdsForCall(
  supabase: Supabase,
  orgId: string,
  agentId: string | null,
  knowledgeBaseIdsOverride: string[] | null | undefined,
): Promise<string[]> {
  if (knowledgeBaseIdsOverride && knowledgeBaseIdsOverride.length > 0) return knowledgeBaseIdsOverride;
  if (!agentId) return [];
  // A campaign with no knowledge base of its own falls back to the agent's.
  const { data } = await supabase.from('knowledge_bases').select('id').eq('organization_id', orgId).eq('agent_id', agentId);
  return (data ?? []).map((kb: { id: string }) => kb.id);
}
