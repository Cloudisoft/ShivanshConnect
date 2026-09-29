/**
 * Phase 8: real tool-call/function-call webhook event handling (master
 * spec sections 17/53/60) - "the AI can create a callback" / "the AI can
 * recognize a DNC request" are implemented here as real webhook-event
 * handling against Vapi's/pipecat's own tool-call payload shape, never a
 * UI mockup.
 *
 * Vapi sends a `message.type === 'tool-calls'` webhook with a
 * `message.toolCallList` (or, on older API versions, `toolCalls`) array of
 * `{ id, function: { name, arguments } }` - `arguments` may already be a
 * parsed object or a JSON string depending on the assistant's configured
 * function schema, so both are handled. pipecat-service (this platform's
 * own component) mirrors the same normalized shape in its own webhook
 * payload (`event_type: 'tool-calls'`, `tool_calls: [...]`) rather than
 * inventing a second shape for the same concept.
 *
 * Two recognized tool intents (function names), both real, deterministic,
 * end-to-end wiring - never a hallucinated free-form intent:
 *   - `schedule_callback` -> services/callbackScheduler.ts
 *   - `request_dnc` -> services/dncToolHandler.ts
 * An unrecognized function name is recorded (call_events) and ignored -
 * never crashes the webhook.
 */
import { ensureLeadForCall, parseCallerDetails, saveCallerDetails } from './callerLead.js';
import { getLlmProvider } from '../lib/llm/index.js';
import { knowledgeBaseIdsForCall } from './callKnowledge.js';
import { createCallback } from './callbackScheduler.js';
import { handleDncRequest } from './dncToolHandler.js';
import type { getSupabaseAdmin } from '../lib/supabase.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

export interface NormalizedToolCall {
  id: string | null;
  name: string;
  arguments: Record<string, unknown>;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

/** Extracts tool calls from a Vapi `message` payload
 * (`message.type === 'tool-calls'`). */
export function extractVapiToolCalls(message: Record<string, any>): NormalizedToolCall[] {
  const list: any[] = message?.toolCallList ?? message?.toolCalls ?? [];
  return list
    .map((tc) => {
      const fn = tc?.function ?? tc;
      if (!fn?.name) return null;
      return { id: tc?.id ?? null, name: fn.name as string, arguments: parseArguments(fn.arguments) };
    })
    .filter((tc): tc is NormalizedToolCall => tc !== null);
}

/** Extracts tool calls from a pipecat-service webhook body
 * (`event_type === 'tool-calls'`). */
export function extractPipecatToolCalls(body: Record<string, any>): NormalizedToolCall[] {
  const list: any[] = body?.tool_calls ?? [];
  return list
    .map((tc) => {
      if (!tc?.name) return null;
      return { id: tc?.id ?? null, name: tc.name as string, arguments: parseArguments(tc.arguments) };
    })
    .filter((tc): tc is NormalizedToolCall => tc !== null);
}

export interface ProcessToolCallsResult {
  handled: number;
  skipped: number;
  /** Vapi's synchronous server-tool response entries - only
   * search_knowledge_base returns one (the model needs its answer);
   * schedule_callback/request_dnc are side effects. */
  results: Array<{ toolCallId: string; result: string }>;
}

const KB_NO_RESULTS = 'Nothing in the knowledge base covers that.';
const KB_UNAVAILABLE = 'The knowledge base is not available right now.';

/** Live knowledge-base lookup for one call: embeds the query and runs the
 * same pgvector search the agent's "test your knowledge base" uses, over
 * the knowledge bases this call may use (campaign's, else the agent's).
 * Returns plain text for the model to answer from. */
export async function searchKnowledgeBaseForCall(supabase: Supabase, call: Record<string, any>, query: string): Promise<string> {
  if (!query.trim()) return KB_NO_RESULTS;
  const provider = getLlmProvider();
  if (!provider.isConfigured) return KB_UNAVAILABLE;

  let kbIdsOverride: string[] | null = null;
  if (call.campaign_id) {
    const { data: campaign } = await supabase.from('campaigns').select('current_version_id').eq('id', call.campaign_id).maybeSingle();
    if (campaign?.current_version_id) {
      const { data: version } = await supabase.from('campaign_versions').select('knowledge_base_ids').eq('id', campaign.current_version_id).maybeSingle();
      kbIdsOverride = version?.knowledge_base_ids ?? null;
    }
  }
  const kbIds = await knowledgeBaseIdsForCall(supabase, call.organization_id, call.ai_agent_id ?? null, kbIdsOverride);
  if (kbIds.length === 0) return KB_NO_RESULTS;

  // match_knowledge_chunks scopes by the knowledge base's owning agent
  // (null = organization-wide), so search once per owner and keep the best.
  const { data: kbs } = await supabase.from('knowledge_bases').select('id, agent_id').in('id', kbIds).eq('organization_id', call.organization_id);
  const owners = [...new Set((kbs ?? []).map((kb: { agent_id: string | null }) => kb.agent_id ?? null))];
  if (owners.length === 0) return KB_NO_RESULTS;

  const { embeddings } = await provider.embedText([query]);
  const queryEmbedding = embeddings[0];
  if (!queryEmbedding) return KB_UNAVAILABLE;

  const matches: Array<{ content: string; similarity: number }> = [];
  for (const owner of owners) {
    const { data, error } = await supabase.rpc('match_knowledge_chunks', {
      query_embedding: queryEmbedding,
      match_organization_id: call.organization_id,
      match_agent_id: owner,
      match_count: 4,
    });
    if (error) throw error;
    matches.push(...((data ?? []) as Array<{ content: string; similarity: number }>));
  }
  if (matches.length === 0) return KB_NO_RESULTS;
  return matches
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, 4)
    .map((m) => m.content.trim())
    .join('\n\n---\n\n');
}

/**
 * Runs every recognized tool call against `call`. Never throws for an
 * individual malformed/unrecognized call - each is logged to call_events
 * and the loop continues, so one bad tool call never fails the whole
 * webhook delivery.
 */
export async function processToolCalls(supabase: Supabase, call: Record<string, any>, toolCalls: NormalizedToolCall[]): Promise<ProcessToolCallsResult> {
  let handled = 0;
  let skipped = 0;
  const results: ProcessToolCallsResult['results'] = [];

  for (const toolCall of toolCalls) {
    try {
      if (toolCall.name === 'schedule_callback') {
        const args = toolCall.arguments;
        const scheduledAt = typeof args.scheduled_at === 'string' ? args.scheduled_at : null;
        // An inbound caller we don't know yet gets a lead now - a callback
        // needs someone to call back.
        const leadId = scheduledAt ? await ensureLeadForCall(supabase, call) : call.lead_id;
        if (!scheduledAt || !leadId) {
          await supabase.from('call_events').insert({ call_id: call.id, organization_id: call.organization_id, event_type: 'tool_call.invalid_args', payload: { tool: 'schedule_callback', args, reason: !leadId ? 'call has no associated lead' : 'missing scheduled_at' } });
          if (toolCall.id) {
            results.push({ toolCallId: toolCall.id, result: !scheduledAt ? 'Not scheduled: agree on a specific date and time first.' : "Not scheduled: I don't have a phone number for this caller." });
          }
          skipped += 1;
          continue;
        }
        let answer: string;
        try {
          const { callback } = await createCallback(supabase, {
            organizationId: call.organization_id,
            leadId,
            campaignId: call.campaign_id ?? null,
            phoneE164: call.customer_number,
            scheduledAt,
            timezone: typeof args.timezone === 'string' ? args.timezone : undefined,
            reason: typeof args.reason === 'string' ? args.reason : null,
            notes: typeof args.notes === 'string' ? args.notes : null,
            assignedTo: 'ai',
            sourceCallId: call.id,
            createdBy: null,
          });
          answer = `Callback scheduled for ${callback.scheduled_at}.`;
          handled += 1;
        } catch (err) {
          // e.g. a time in the past - tell the model so it can re-confirm.
          answer = `Not scheduled: ${err instanceof Error ? err.message : 'could not save the callback.'} Confirm a future date and time with the caller and try again.`;
          await supabase.from('call_events').insert({ call_id: call.id, organization_id: call.organization_id, event_type: 'tool_call.error', payload: { tool: 'schedule_callback', args, error: answer } });
          skipped += 1;
        }
        if (toolCall.id) results.push({ toolCallId: toolCall.id, result: answer });
      } else if (toolCall.name === 'save_caller_details') {
        let answer: string;
        try {
          answer = await saveCallerDetails(supabase, call, parseCallerDetails(toolCall.arguments));
          handled += 1;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('save_caller_details failed for call', call.id, err);
          answer = "Couldn't save the details right now - carry on with the call.";
          skipped += 1;
        }
        if (toolCall.id) results.push({ toolCallId: toolCall.id, result: answer });
      } else if (toolCall.name === 'search_knowledge_base') {
        const query = typeof toolCall.arguments.query === 'string' ? toolCall.arguments.query : '';
        let answer: string;
        try {
          answer = await searchKnowledgeBaseForCall(supabase, call, query);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('search_knowledge_base failed for call', call.id, err);
          answer = KB_UNAVAILABLE;
        }
        if (toolCall.id) results.push({ toolCallId: toolCall.id, result: answer });
        handled += 1;
      } else if (toolCall.name === 'request_dnc') {
        const reason = typeof toolCall.arguments.reason === 'string' ? toolCall.arguments.reason : null;
        await handleDncRequest(supabase, call, reason);
        if (toolCall.id) results.push({ toolCallId: toolCall.id, result: 'Done - they will not be called again.' });
        handled += 1;
      } else {
        await supabase.from('call_events').insert({ call_id: call.id, organization_id: call.organization_id, event_type: 'tool_call.unrecognized', payload: { name: toolCall.name } });
        skipped += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool call processing failed.';
      await supabase.from('call_events').insert({ call_id: call.id, organization_id: call.organization_id, event_type: 'tool_call.error', payload: { tool: toolCall.name, error: message } });
      skipped += 1;
    }
  }

  return { handled, skipped, results };
}
