import { describe, expect, it } from 'vitest';
import { parseSummaryResponse } from './generateCallSummary.js';

describe('generateCallSummary.parseSummaryResponse - LLM JSON parsing with malformed-response handling', () => {
  it('parses a well-formed JSON object', () => {
    const raw = JSON.stringify({
      summary: 'Caller asked about pricing and agreed to a follow-up.',
      key_points: ['Asked about pricing', 'Agreed to follow-up'],
      customer_intent: 'Get a quote',
      objections: ['Price seems high'],
      questions: ['Do you offer discounts?'],
      next_action: 'Send pricing sheet',
      outcome: 'Follow-up scheduled',
    });

    const parsed = parseSummaryResponse(raw);
    expect(parsed.summary).toBe('Caller asked about pricing and agreed to a follow-up.');
    expect(parsed.key_points).toEqual(['Asked about pricing', 'Agreed to follow-up']);
    expect(parsed.objections).toEqual(['Price seems high']);
    expect(parsed.next_action).toBe('Send pricing sheet');
  });

  it('unwraps a markdown code fence around the JSON (a common LLM habit despite instructions)', () => {
    const raw = '```json\n{"summary": "Short call, no answer.", "key_points": []}\n```';
    const parsed = parseSummaryResponse(raw);
    expect(parsed.summary).toBe('Short call, no answer.');
    expect(parsed.key_points).toEqual([]);
  });

  it('defaults missing array fields to empty/null rather than throwing', () => {
    const parsed = parseSummaryResponse(JSON.stringify({ summary: 'Minimal response.' }));
    expect(parsed.key_points).toEqual([]);
    expect(parsed.objections).toBeNull();
    expect(parsed.questions).toBeNull();
    expect(parsed.customer_intent).toBeNull();
    expect(parsed.next_action).toBeNull();
    expect(parsed.outcome).toBeNull();
  });

  it('throws on genuinely malformed JSON - never silently coerces garbage into a fake summary', () => {
    expect(() => parseSummaryResponse('not json at all')).toThrow();
  });

  it('throws when the required "summary" field is missing or empty', () => {
    expect(() => parseSummaryResponse(JSON.stringify({ key_points: [] }))).toThrow();
    expect(() => parseSummaryResponse(JSON.stringify({ summary: '' }))).toThrow();
  });
});
