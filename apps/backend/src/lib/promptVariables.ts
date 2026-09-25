/**
 * Renders {{variable}} placeholders (first_name, last_name, phone,
 * email, agent_name, custom_field.<key>) in a system prompt / greeting /
 * script against a sample lead-shaped payload. Any variable not present
 * in the payload is left as its literal `{{...}}` text rather than
 * silently becoming an empty string, so a preview or a real call clearly
 * shows an unmapped variable instead of hiding it.
 *
 * agent_name was missing here even though the platform's own built-in
 * script templates (packages/shared/src/agent.ts) use {{agent_name}} -
 * on any real call it was never substituted at all, so the AI would
 * literally have to say the raw text "agent_name" out loud, or an LLM
 * reading it in the system prompt would have to guess. Resolves to the
 * AI agent's own configured name (ai_agents.name) - the persona name the
 * assistant introduces itself as - never the TTS voice's own name (a
 * technical/provider detail, e.g. "Rachel" from ElevenLabs, unrelated to
 * what character the agent is speaking as).
 */

export interface PromptVariableContext {
  first_name?: string;
  last_name?: string;
  phone?: string;
  email?: string;
  agent_name?: string;
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
