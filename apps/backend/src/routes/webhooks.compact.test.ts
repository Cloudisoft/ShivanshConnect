import { describe, expect, it } from 'vitest';
import { compactVapiMessage } from './webhooks.js';

describe('compactVapiMessage', () => {
  it('drops the bulky parts of an end-of-call report but keeps everything the handler and dispositions read', () => {
    const message = {
      type: 'end-of-call-report',
      endedReason: 'voicemail',
      durationSeconds: 22.4,
      cost: 0.02,
      recordingUrl: 'https://example.test/r.wav',
      artifact: { messages: new Array(200).fill({ role: 'bot', message: 'x'.repeat(200) }) },
      messages: [{ role: 'user' }],
      transcript: 'AI: hi',
      assistant: { model: { messages: [{ role: 'system', content: 'long prompt' }] } },
      analysis: { summary: 'Left voicemail', structuredData: { big: true } },
      call: { id: 'vapi-1', status: 'ended', assistant: { huge: true }, monitor: { controlUrl: 'x' } },
    };
    const compact = compactVapiMessage(message);
    expect(compact).toEqual({
      type: 'end-of-call-report',
      endedReason: 'voicemail',
      durationSeconds: 22.4,
      cost: 0.02,
      recordingUrl: 'https://example.test/r.wav',
      analysis: { summary: 'Left voicemail', successEvaluation: undefined },
      call: { id: 'vapi-1', status: 'ended', type: undefined, endedReason: undefined, startedAt: undefined, endedAt: undefined, phoneNumberId: undefined },
    });
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(message).length / 20);
  });

  it('leaves other message types untouched (tool calls need their full payload)', () => {
    const message = { type: 'tool-calls', toolCallList: [{ id: 't1' }], call: { id: 'vapi-1', assistant: { a: 1 } } };
    expect(compactVapiMessage(message)).toBe(message);
  });
});
