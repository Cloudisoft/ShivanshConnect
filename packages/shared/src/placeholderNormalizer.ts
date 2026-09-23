/**
 * Scripts/prompts pasted or uploaded from elsewhere often use placeholder
 * conventions other than this app's `{{first_name}}` style - `[First Name]`,
 * `<Phone Number>`, `%email%`, `{FirstName}`, and similar. normalizePlaceholders()
 * detects the common ones and rewrites them into this app's canonical
 * `{{variable}}` syntax, so a pasted or uploaded script becomes usable
 * (rendered by lib/promptVariables.ts on the backend) without manual editing.
 *
 * Anything already written in this app's own `{{...}}` syntax with a
 * snake_case-ish identifier (`{{first_name}}`, `{{city}}`,
 * `{{custom_field.account_number}}`) is left completely untouched - those
 * are assumed intentional, including org-specific variables we don't know
 * about. Only a `{{...}}` whose inner text looks like a human-readable
 * label ("{{First Name}}") gets its casing normalized, same as the other
 * delimiter styles below.
 */

const ALIAS_MAP: Record<'first_name' | 'last_name' | 'phone' | 'email', string[]> = {
  first_name: ['first name', 'firstname', 'first_name', 'fname', 'given name'],
  last_name: ['last name', 'lastname', 'last_name', 'lname', 'surname', 'family name'],
  phone: [
    'phone',
    'phone number',
    'phone_number',
    'mobile',
    'mobile number',
    'mobile_number',
    'cell',
    'cell phone',
    'contact number',
    'telephone',
    'tel',
  ],
  email: ['email', 'email address', 'email_address', 'e-mail', 'e mail'],
};

const FULL_NAME_ALIASES = ['full name', 'fullname', 'full_name', 'name', 'customer name', 'contact name', 'lead name', 'caller name', 'client name'];

function slug(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, ' ').trim();
}

function resolveAlias(rawInner: string): string | null {
  const key = slug(rawInner);
  for (const [canonical, aliases] of Object.entries(ALIAS_MAP)) {
    if (aliases.includes(key)) return `{{${canonical}}}`;
  }
  if (FULL_NAME_ALIASES.includes(key)) return '{{first_name}} {{last_name}}';
  return null;
}

/** Already this app's own syntax - a plain snake_case identifier (optionally `custom_field.<key>`) inside `{{ }}`. */
function isAlreadyCanonicalToken(inner: string): boolean {
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)?$/.test(inner.trim());
}

// Ordered longest/most-specific delimiter first within each alternative so
// the regex engine can't misparse e.g. `{{x}}` as a single-brace `{x}`
// match sitting inside it - the canonical `{{...}}` form is its own,
// highest-priority alternative.
const PLACEHOLDER_REGEX =
  /\{\{\s*([^{}]+?)\s*\}\}|<<\s*([^<>]+?)\s*>>|%%\s*([^%]+?)\s*%%|\{\s*([^{}]+?)\s*\}|\[\s*([^[\]]+?)\s*\]|<\s*([^<>]+?)\s*>|%\s*([^%]+?)\s*%/g;

export interface PlaceholderNormalizationResult {
  text: string;
  /** Non-canonical placeholders that were auto-converted, e.g. "[First Name]" -> "{{first_name}}". */
  replaced: Array<{ original: string; canonical: string }>;
  /** Bracket-like placeholders that looked intentional but couldn't be confidently mapped - left as-is for manual review. */
  unrecognized: string[];
}

export function normalizePlaceholders(input: string): PlaceholderNormalizationResult {
  const replaced: Array<{ original: string; canonical: string }> = [];
  const unrecognizedSet = new Set<string>();

  const text = input.replace(PLACEHOLDER_REGEX, (match: string, ...rest: unknown[]) => {
    // Capture groups: [0]=`{{ }}` inner, [1..6]=the other delimiters' inner text.
    const groups = rest.slice(0, 7) as Array<string | undefined>;
    const isCanonicalWrapper = groups[0] !== undefined;
    const inner = groups.find((g) => g !== undefined) ?? '';

    if (isCanonicalWrapper && isAlreadyCanonicalToken(inner)) {
      return match;
    }

    const canonical = resolveAlias(inner);
    if (canonical) {
      if (canonical !== match) replaced.push({ original: match, canonical });
      return canonical;
    }

    if (!isCanonicalWrapper) {
      const looksLikePlaceholder = inner.trim().length > 0 && inner.trim().length <= 40 && !/[.!?\n]/.test(inner);
      if (looksLikePlaceholder) unrecognizedSet.add(match);
    }
    return match;
  });

  return { text, replaced, unrecognized: [...unrecognizedSet] };
}
