import { describe, expect, it } from 'vitest';
import { normalizePhoneNumber } from './phone.js';

describe('normalizePhoneNumber', () => {
  const validFormats: Array<[string, string]> = [
    ['484-555-1234', '+14845551234'],
    ['(484) 555-1234', '+14845551234'],
    ['4845551234', '+14845551234'],
    ['+14845551234', '+14845551234'],
    ['484.555.1234', '+14845551234'],
    ['1-484-555-1234', '+14845551234'],
    ['1 (484) 555-1234', '+14845551234'],
    ['+1 484 555 1234', '+14845551234'],
    ['  484 555 1234  ', '+14845551234'],
  ];

  it.each(validFormats)('normalizes "%s" to %s', (input, expected) => {
    const result = normalizePhoneNumber(input);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.e164).toBe(expected);
      expect(result.countryCode).toBe('US');
      expect(result.nationalNumber).toBe('4845551234');
      expect(result.original).toBe(input);
    }
  });

  it('normalizes a Canadian number', () => {
    // 416 is a Toronto, ON area code.
    const result = normalizePhoneNumber('416-555-0134');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.e164).toBe('+14165550134');
      expect(result.countryCode).toBe('CA');
    }
  });

  const invalidInputs: Array<[string, string]> = [
    ['', 'empty string'],
    ['   ', 'whitespace only'],
    ['12345', 'too short'],
    ['555-1234', 'missing area code'],
    ['not a phone number', 'letters'],
    ['484-555-123X', 'trailing letter'],
    ['123-456-7890', 'invalid area code (starts with 1 in area code position is fine, but 123 is a reserved/invalid NANP area code)'],
    ['0000000000', 'all zeros'],
    ['+44 20 7946 0958', 'valid UK number, unsupported country'],
    ['484555123456789012', 'far too many digits'],
  ];

  it.each(invalidInputs)('flags "%s" as invalid (%s)', (input) => {
    const result = normalizePhoneNumber(input);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBeTruthy();
      expect(result.original).toBe(input);
    }
  });

  it('never guesses - invalid input never produces an e164 value', () => {
    const result = normalizePhoneNumber('123-456-7890');
    expect(result).not.toHaveProperty('e164');
  });
});
