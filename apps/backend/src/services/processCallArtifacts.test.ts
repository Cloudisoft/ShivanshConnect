import { describe, expect, it } from 'vitest';
import { parseFlatTranscript } from './processCallArtifacts.js';

describe('processCallArtifacts.parseFlatTranscript - realistic Vapi-shaped flat transcript parsing', () => {
  it('splits a realistic AI/User-labeled transcript into ordered speaker segments', () => {
    const raw = [
      'AI: Hi, this is Alex calling from Acme Insurance. Do you have a moment?',
      'User: Sure, what is this about?',
      'AI: I wanted to see if you are still interested in getting a quote.',
      'User: Yes, go ahead.',
    ].join('\n');

    const segments = parseFlatTranscript(raw);

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ speaker: 'ai', text: 'Hi, this is Alex calling from Acme Insurance. Do you have a moment?' });
    expect(segments[1]).toMatchObject({ speaker: 'caller', text: 'Sure, what is this about?' });
    expect(segments[2].speaker).toBe('ai');
    expect(segments[3].speaker).toBe('caller');
  });

  it('recognizes Assistant/Caller/Customer/Bot labels too, case-insensitively', () => {
    const raw = 'assistant: Hello there.\nCustomer: Hi.\nBot: How can I help?\ncaller: I have a question.';
    const segments = parseFlatTranscript(raw);
    expect(segments.map((s) => s.speaker)).toEqual(['ai', 'caller', 'ai', 'caller']);
  });

  it('appends an unlabeled continuation line to the previous segment rather than dropping or misattributing it', () => {
    const raw = 'AI: This is a long sentence that\ncontinues on the next line.\nUser: Got it.';
    const segments = parseFlatTranscript(raw);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('This is a long sentence that continues on the next line.');
  });

  it('returns no invented timing - every segment starts at 0/null when the source has no real per-segment timestamps', () => {
    const segments = parseFlatTranscript('AI: Hello.\nUser: Hi.');
    expect(segments.every((s) => s.startMs === 0 && s.endMs === null)).toBe(true);
  });

  it('returns an empty array for blank input', () => {
    expect(parseFlatTranscript('   \n  \n')).toEqual([]);
  });
});
