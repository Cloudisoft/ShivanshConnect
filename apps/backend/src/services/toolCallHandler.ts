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

  for (const toolCall of toolCalls) {
    try {
      if (toolCall.name === 'schedule_callback') {
        const args = toolCall.arguments;
        const scheduledAt = typeof args.scheduled_at === 'string' ? args.scheduled_at : null;
        if (!scheduledAt || !call.lead_id) {
          await supabase.from('call_events').insert({ call_id: call.id, organization_id: call.organization_id, event_type: 'tool_call.invalid_args', payload: { tool: 'schedule_callback', args, reason: !call.lead_id ? 'call has no associated lead' : 'missing scheduled_at' } });
          skipped += 1;
          continue;
        }
        await createCallback(supabase, {
          organizationId: call.organization_id,
          leadId: call.lead_id,
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
        handled += 1;
      } else if (toolCall.name === 'request_dnc') {
        const reason = typeof toolCall.arguments.reason === 'string' ? toolCall.arguments.reason : null;
        await handleDncRequest(supabase, call, reason);
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

  return { handled, skipped };
}
