import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone normalization (Phase 2, master spec section 55/58).
 *
 * Every phone number a lead/DNC entry stores is normalized to strict
 * E.164 (`+1XXXXXXXXXX` for US/Canada) before it is ever compared,
 * deduped or persisted as `phone_normalized`. `phone_original` always
 * keeps exactly what the user typed/imported, for audit and re-review.
 *
 * This module intentionally never "best guesses" an ambiguous number -
 * anything that libphonenumber-js cannot parse as a valid US/Canada
 * number is returned with `valid: false` and a human-readable reason, so
 * callers (single add, bulk add, CSV import) can flag the row instead of
 * silently storing a bad number.
 */

export interface NormalizedPhone {
  valid: true;
  /** Exactly what was supplied, untouched. */
  original: string;
  /** Strict E.164, e.g. "+14845551234". */
  e164: string;
  /** ISO country code, e.g. "US". */
  countryCode: string;
  /** The national significant number, e.g. "4845551234". */
  nationalNumber: string;
}

export interface InvalidPhone {
  valid: false;
  original: string;
  reason: string;
}

export type PhoneNormalizationResult = NormalizedPhone | InvalidPhone;

/**
 * Normalizes a single phone number string. Defaults to assuming US/Canada
 * (`+1`) when no country code is present in the input, since Phase 2's
 * leads/DNC data is US-market per the spec - a bare 10-digit number like
 * "4845551234" is treated as a US number, not silently accepted as some
 * other country's number.
 */
export function normalizePhoneNumber(input: string): PhoneNormalizationResult {
  const original = input;
  const trimmed = (input ?? '').trim();

  if (!trimmed) {
    return { valid: false, original, reason: 'Phone number is empty.' };
  }

  // Reject obviously non-phone input early (letters, etc.) - libphonenumber
  // will sometimes still "parse" garbage down to nothing useful.
  if (!/^[+()\-.\s\d]+$/.test(trimmed)) {
    return { valid: false, original, reason: 'Phone number contains invalid characters.' };
  }

  const digitCount = trimmed.replace(/\D/g, '').length;
  if (digitCount < 10) {
    return { valid: false, original, reason: 'Phone number has too few digits.' };
  }
  if (digitCount > 15) {
    return { valid: false, original, reason: 'Phone number has too many digits.' };
  }

  let parsed;
  try {
    parsed = parsePhoneNumberFromString(trimmed, 'US');
  } catch {
    return { valid: false, original, reason: 'Phone number could not be parsed.' };
  }

  if (!parsed || !parsed.isValid()) {
    return { valid: false, original, reason: 'Phone number is not a valid, dialable number.' };
  }

  // Phase 2 scope is US/Canada dialing; a validly-formatted-but-foreign
  // number is flagged rather than silently normalized, since the rest of
  // the platform (DIDs, dialer) assumes NANP numbers for now.
  if (parsed.country !== 'US' && parsed.country !== 'CA') {
    return {
      valid: false,
      original,
      reason: `Phone number resolves to ${parsed.country ?? 'a non-US/Canada'} country code, which is not supported yet.`,
    };
  }

  return {
    valid: true,
    original,
    e164: parsed.number,
    countryCode: parsed.country ?? 'US',
    nationalNumber: parsed.nationalNumber,
  };
}

export function isValidNormalizedPhone(result: PhoneNormalizationResult): result is NormalizedPhone {
  return result.valid;
}
