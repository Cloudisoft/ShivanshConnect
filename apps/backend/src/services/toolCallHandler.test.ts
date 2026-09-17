import { describe, expect, it } from 'vitest';
import { extractPipecatToolCalls, extractVapiToolCalls } from './toolCallHandler.js';

describe('toolCallHandler - normalizing tool-call payloads', () => {
  it('extracts Vapi tool calls with a stringified JSON arguments payload', () => {
    const message = {
      toolCallList: [{ id: 'tc1', function: { name: 'schedule_callback', arguments: JSON.stringify({ scheduled_at: '2026-02-01T15:00:00Z', reason: 'wants a callback' }) } }],
    };
    const calls = extractVapiToolCalls(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('schedule_callback');
    expect(calls[0].arguments.reason).toBe('wants a callback');
  });

  it('extracts Vapi tool calls with an already-parsed object arguments payload', () => {
    const message = { toolCalls: [{ id: 'tc2', function: { name: 'request_dnc', arguments: { reason: 'asked to be removed' } } }] };
    const calls = extractVapiToolCalls(message);
    expect(calls[0].name).toBe('request_dnc');
    expect(calls[0].arguments.reason).toBe('asked to be removed');
  });

  it('ignores malformed entries (missing function/name) instead of throwing', () => {
    const message = { toolCallList: [{ id: 'tc3' }, null, { function: {} }] };
    expect(extractVapiToolCalls(message)).toHaveLength(0);
  });

  it('returns an empty list when there is no tool-call data at all', () => {
    expect(extractVapiToolCalls({})).toEqual([]);
  });

  it('extracts pipecat tool calls from its own webhook body shape', () => {
    const body = { tool_calls: [{ id: 'p1', name: 'schedule_callback', arguments: { scheduled_at: '2026-02-01T15:00:00Z' } }] };
    const calls = extractPipecatToolCalls(body);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('schedule_callback');
  });
});
