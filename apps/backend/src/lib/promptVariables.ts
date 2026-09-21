/**
 * Renders {{variable}} placeholders (first_name, last_name,
 * phone, email, custom_field.<key>) in a system prompt / greeting /
 * script against a sample lead-shaped payload. Any variable not present
 * in the payload is left as its literal `{{...}}` text rather than
 * silently becoming an empty string, so a preview or a real call clearly
 * shows an unmapped variable instead of hiding it.
 */

export interface PromptVariableContext {
  first_name?: string;
  last_name?: string;
  phone?: string;
  email?: string;
  custom_field?: Record<string, string>;
}

export function renderTemplate(template: string, context: PromptVariableContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (match, rawKey: string) => {
    if (rawKey.startsWith('custom_field.')) {
      const key = rawKey.slice('custom_field.'.length);
      const value = context.custom_field?.[key];
      return value !== undefined ? value : match;
    }
    const value = (context as Record<string, unknown>)[rawKey];
    return typeof value === 'string' && value.length > 0 ? value : match;
  });
}
