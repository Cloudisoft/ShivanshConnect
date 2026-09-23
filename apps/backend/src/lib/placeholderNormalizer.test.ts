import { describe, expect, it } from 'vitest';
import { normalizePlaceholders } from '@shivanshconnect/shared';

describe('normalizePlaceholders', () => {
  it('leaves this app\'s own {{snake_case}} placeholders untouched', () => {
    const input = 'Hi {{first_name}}, calling about {{custom_field.account_number}} in {{city}}.';
    const result = normalizePlaceholders(input);
    expect(result.text).toBe(input);
    expect(result.replaced).toEqual([]);
    expect(result.unrecognized).toEqual([]);
  });

  it('converts square-bracket, angle-bracket and percent placeholders to canonical form', () => {
    const result = normalizePlaceholders('Hi [First Name] [Last Name], is this <Phone Number>? Reach you at %email%?');
    expect(result.text).toBe('Hi {{first_name}} {{last_name}}, is this {{phone}}? Reach you at {{email}}?');
    expect(result.replaced).toHaveLength(4);
  });

  it('converts single-brace and double-angle/double-percent placeholders', () => {
    const result = normalizePlaceholders('Hi {FirstName}, your order for <<email>> is at %%phone number%%.');
    expect(result.text).toBe('Hi {{first_name}}, your order for {{email}} is at {{phone}}.');
  });

  it('normalizes a human-readable label inside double braces without changing the delimiter', () => {
    const result = normalizePlaceholders('Hi {{First Name}}, following up.');
    expect(result.text).toBe('Hi {{first_name}}, following up.');
    expect(result.replaced).toEqual([{ original: '{{First Name}}', canonical: '{{first_name}}' }]);
  });

  it('maps common "full name" aliases to first_name + last_name', () => {
    const result = normalizePlaceholders('Hi [Customer Name], this is a call from...');
    expect(result.text).toBe('Hi {{first_name}} {{last_name}}, this is a call from...');
  });

  it('flags unrecognized bracket-like placeholders for manual review without altering them', () => {
    const result = normalizePlaceholders('Reference: [Account Number]. Notes: [internal use only].');
    expect(result.text).toBe('Reference: [Account Number]. Notes: [internal use only].');
    expect(result.unrecognized).toEqual(['[Account Number]', '[internal use only]']);
  });

  it('does not flag ordinary bracketed sentences as placeholders', () => {
    const result = normalizePlaceholders('Say this exactly: [Please hold while I transfer your call.]');
    expect(result.unrecognized).toEqual([]);
  });

  it('is idempotent - normalizing already-normalized text is a no-op', () => {
    const once = normalizePlaceholders('Hi [First Name], call at <Phone Number>.');
    const twice = normalizePlaceholders(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.replaced).toEqual([]);
  });
});
