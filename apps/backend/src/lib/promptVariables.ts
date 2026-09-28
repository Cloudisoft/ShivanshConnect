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
 * VOICE's own name (the campaign's selected voice when one is set,
 * otherwise the agent version's own default voice) - the voice is the
 * real source of truth for who the caller actually hears introduce
 * themselves as, never the AI agent's internal configured name
 * (ai_agents.name, a separate record label unrelated to what the caller
 * hears). Matches the platform's own pre-existing no-lead-name fallback
 * greeting (callOrigination.ts), which already used the voice's name for
 * this exact reason.
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

/** A voice's name as the AI should say it on a call. Provider voice
 * catalogs name voices with a description after the person's name
 * ("Ray - Conversationalist", "Tina - Customer Ally", "Mitchell
 * (ElevenLabs)"); the caller should only ever hear "Ray", "Tina",
 * "Mitchell". Real catalog labels include tab separators ("Alexei\t-
 * Articulate Analyst") and versions ("Barry 2.0 - Helper"). */
export function spokenVoiceName(name: string | null | undefined): string | null {
  const full = (name ?? '').trim();
  if (!full) return null;
  const spoken = full
    .split(/\s+[-–—|:]\s*|\s*[-–—|:]\s+/)[0]
    .replace(/\s*[([].*$/, '')
    // "Barry 2.0", "Wade 2.0" - a catalog version, not part of the name.
    .replace(/\s+v?\d+(\.\d+)*$/i, '')
    .trim();
  return spoken || full;
}
