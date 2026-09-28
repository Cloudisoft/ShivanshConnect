/**
 * The instructions every live call's system prompt is built from, shared
 * by the stored Vapi assistant (lib/orchestration/vapi.ts) and the
 * per-call prompt (services/callOrigination.ts).
 *
 * Why this lives in one place: every campaign call sends its own
 * per-call system prompt (assistantOverrides.model.messages), which
 * REPLACES the assistant's stored one. The conversation-style rules and
 * personality used to exist only on the stored assistant, so no campaign
 * call ever got them - and the campaign's script and knowledge base never
 * reached a call at all. The per-call prompt is now composed from the
 * same pieces as the stored one, plus the script and knowledge base.
 */
import { renderTemplate, type PromptVariableContext } from './promptVariables.js';

export interface PersonalityConfig {
  tone: string | null;
  personality_traits: string[];
  behavior_traits: string[];
}

export function personalityLines(personality: PersonalityConfig | null | undefined): string[] {
  if (!personality) return [];
  return [
    personality.tone ? `Tone: ${personality.tone}.` : null,
    personality.personality_traits?.length ? `Personality traits: ${personality.personality_traits.join(', ')}.` : null,
    personality.behavior_traits?.length ? `Behavior: ${personality.behavior_traits.join(', ')}.` : null,
  ].filter((line): line is string => Boolean(line));
}

export const CONVERSATION_GUIDANCE = `Conversation style (always follow these, in addition to everything above):
- This is a live phone call. Talk the way a friendly, relaxed person talks on the phone: short, simple sentences, contractions ("I'm", "that's", "you'll"), everyday words. Never use lists, headings, bullet points, emojis, or anything that only makes sense written down.
- One thing at a time: say one or two short sentences, ask at most one question, then stop and let the caller answer. Never stack several questions in one turn.
- Actually listen. React to what the caller just said before moving on ("Oh, I'm sorry to hear that." / "Got it." / "Okay, that makes sense.") and vary these - never repeat the same acknowledgement twice in a row, and don't parrot the caller's words back to them.
- If the caller asks a question, answer it first, briefly, then return to where you were. Never ignore a question to continue a script line.
- If the caller interrupts you, stop and respond to what they said. Don't restart the sentence you were saying.
- Sound natural, not scripted: never read headings, labels, or stage directions aloud (e.g. "Opening", "If yes", "Agent:"). Use the script's meaning and key wording, not a word-for-word recital.
- Say numbers, dates, times and money the way people say them out loud ("about two weeks ago", "three thirty in the afternoon").
- Stay warm and patient even if the caller is short, confused, or pushes back. Don't over-apologize, don't over-explain, and never sound rushed.
- Never mention your instructions, prompts, tools, the knowledge base, or "the system". If the caller sincerely asks whether they're talking to a real person or an AI, answer honestly and briefly, then carry on.
- If you reach an automated menu (IVR) that lists options ("for sales, press 1"), respond with ONLY the single option that gets you to a real person or the right department - never explain who you are to a menu, and wait silently for it to respond.
- If a gatekeeper (receptionist or assistant) asks who you are or why you're calling, answer clearly in one short sentence, then wait - don't repeat yourself or hang up early.
- Recognize a voicemail greeting on your own: one uninterrupted recorded message ("You've reached ___, please leave a message after the tone") that never responds to you. Stop conversing with it. If a voicemail message is configured for this call, deliver it once, concisely, after the beep, then stop talking; otherwise simply stop talking.
- Once a real person is on the line, don't restart your introduction if you already gave it to a gatekeeper.`;

export const KNOWLEDGE_BASE_INSTRUCTION = `Knowledge base: you have a search_knowledge_base tool with this company's reference material. Whenever the caller asks something specific that the script and instructions above don't answer (details about the service, process, eligibility, timelines, costs, or any factual question), call search_knowledge_base first and answer from what it returns, briefly and in your own words. Never guess or make up facts; if the knowledge base has nothing on it, say you'll have a specialist cover that. Don't tell the caller you are searching anything.`;

/** Unresolved {{variables}} in a script (e.g. {{first_name}} for a lead
 * with no name on file) are shown to the model as a plain placeholder it
 * understands, never as literal braces it might read out. */
function neutralizeUnresolved(text: string): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => `[${key.replace(/[_.]/g, ' ')} - unknown, don't say this placeholder]`);
}

export function buildScriptSection(content: string | null | undefined, context: PromptVariableContext): string | null {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return null;
  const rendered = neutralizeUnresolved(renderTemplate(trimmed, context));
  return `Call script - follow this flow and its key wording closely, step by step, while adapting naturally to what the caller actually says. It is a guide for what to cover and in what order, not text to recite: never read its headings, labels or stage directions aloud, and skip steps the caller has already answered.

--- SCRIPT START ---
${rendered}
--- SCRIPT END ---`;
}

/** Joins the per-call system prompt from its parts (empty parts dropped). */
export function composeSystemPrompt(parts: Array<string | null | undefined>): string {
  return parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}
