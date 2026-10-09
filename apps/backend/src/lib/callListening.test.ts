import { describe, expect, it } from 'vitest';
import { CONVERSATION_GUIDANCE, buildCallerDetailsSection, buildListeningKeyterms } from './callGuidance.js';

describe('call guidance - transfers, money, listening', () => {
  it('transfers a caller who asks for a person right away, never "one more question"', () => {
    expect(CONVERSATION_GUIDANCE).toMatch(/asks to speak to a person/);
    expect(CONVERSATION_GUIDANCE).toMatch(/transfer them right away/);
    expect(CONVERSATION_GUIDANCE).toMatch(/Never ask "one more quick question" first/);
    // The qualification rule no longer holds a transfer request back.
    expect(CONVERSATION_GUIDANCE).toMatch(/unless the caller asks for a person/);
  });

  it('says money in full words, never "K"', () => {
    expect(CONVERSATION_GUIDANCE).toMatch(/"120K" or "120,000" is "one hundred and twenty thousand dollars"/);
    expect(CONVERSATION_GUIDANCE).toMatch(/Never say "K"/);
  });

  it('lists only the caller details the lead has', () => {
    expect(buildCallerDetailsSection({ first_name: 'Fakruddin', last_name: 'Patel', email: 'f@example.com', phone: '+19419409896' })).toBe(
      "Caller details on file (confirm these with the caller - don't ask for them from scratch, and never read them out before you know you're speaking to this person):\n- Name: Fakruddin Patel\n- Email: f@example.com\n- Phone: +19419409896",
    );
    expect(buildCallerDetailsSection({ first_name: 'Ann' })).toContain('- Name: Ann');
    expect(buildCallerDetailsSection({ first_name: 'Ann' })).not.toContain('Email');
    expect(buildCallerDetailsSection({})).toBeNull();
  });

  it('builds listening keyterms from names, deduplicated', () => {
    expect(buildListeningKeyterms(['Fakruddin', 'Patel', 'Debt Help', 'Ray', null, 'patel', 'A'])).toEqual(['Fakruddin', 'Patel', 'Debt', 'Help', 'Ray']);
  });
});
