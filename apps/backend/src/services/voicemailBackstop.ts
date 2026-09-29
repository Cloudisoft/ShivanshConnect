/**
 * Voicemail backstop, per explicit report: "calls don't detect VMs
 * properly and keep talking with VM".
 *
 * The primary path is Vapi's own voicemailDetection (lib/orchestration/
 * vapi.ts). This covers the calls it misses: when the other side's first
 * few lines are unmistakably a voicemail greeting ("please leave a message
 * after the tone", "the person you are trying to reach is not available"),
 * the backend records the call as voicemail, leaves the campaign's
 * voicemail script when it has one (per explicit request: "it should leave
 * VM after a beep as per VM script"), and hangs up.
 *
 * Only the other side's first lines count, and only early in the call, so a
 * real conversation that later mentions voicemail is never cut off.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { resolveProviderForCall } from '../lib/orchestration/resolveProvider.js';
import { transitionCallState } from '../lib/callStateMachine.js';
import { renderTemplate, spokenVoiceName } from '../lib/promptVariables.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** Phrases a live person answering a call essentially never says in their
 * first few lines, but voicemail greetings and carrier recordings do. */
const VOICEMAIL_GREETING = [
  /\b(leave|record) (me |us )?(a |your )?(brief |short |detailed )?(message|name and (phone )?number|name|number)\b/i,
  /\b(after|at) the (tone|beep)\b/i,
  /\bvoice ?mail\b/i,
  /\bmail ?box\b/i,
  /\bvoice messaging\b/i,
  /\b(not|isn'?t|is not|currently un|un)available\b.{0,40}\b(right now|at the moment|at this time|to take|to answer|to come)\b/i,
  /\b(can'?t|cannot|unable to) (come to|get to|answer|take) (the phone|your call|the call)\b/i,
  /\bthe (person|party|number|subscriber|customer) you (are|were|have) (trying to reach|called|dialed|dialled|reached)\b/i,
  /\bget back to you\b/i,
];

/** How much of the call's start the backstop watches. */
const MAX_SECONDS_FROM_START = 45;
/** How many of the other side's lines it looks at. */
const MAX_CALLER_LINES = 3;
/** Gives Vapi's own detector a moment to act first, and the beep time to
 * sound after the greeting's last words. */
const BACKSTOP_DELAY_MS = Number.parseInt(process.env.VOICEMAIL_BACKSTOP_DELAY_MS ?? '', 10) || 1500;

const ACTIVE_STATUSES = new Set(['answered', 'in_progress']);

interface CallWatch {
  callerLines: number;
  handled: boolean;
  aiText: string[];
}

const watches = new Map<string, CallWatch>();

function watchFor(callId: string): CallWatch {
  let w = watches.get(callId);
  if (!w) {
    w = { callerLines: 0, handled: false, aiText: [] };
    watches.set(callId, w);
    // A call never lasts this long in the watch window; drop the state.
    setTimeout(() => watches.delete(callId), 10 * 60_000).unref?.();
  }
  return w;
}

export function isVoicemailGreeting(text: string): boolean {
  return VOICEMAIL_GREETING.some((re) => re.test(text));
}

/** Rough speaking time for the voicemail script, so the call ends after it
 * has been said, not in the middle of it. */
export function speakingTimeMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round((words / 2.5) * 1000) + 2500;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the assistant has already started the voicemail script - Vapi's
 * own detector caught the voicemail and is leaving it. */
export function alreadyLeavingMessage(aiText: string[], message: string | null): boolean {
  if (!message) return false;
  const start = normalise(message).split(' ').slice(0, 5).join(' ');
  return start.length > 0 && aiText.some((t) => normalise(t).includes(start));
}

/** Fills {{agent_name}}, {{first_name}}... in the voicemail script for this
 * call, the same way the call's own opening is personalized. */
async function renderVoicemailScript(supabase: Supabase, call: Record<string, any>, script: string): Promise<string> {
  const [{ data: voice }, { data: lead }] = await Promise.all([
    call.voice_id ? supabase.from('voices').select('name').eq('id', call.voice_id).maybeSingle() : Promise.resolve({ data: null }),
    call.lead_id ? supabase.from('leads').select('first_name, last_name, phone_normalized, email, custom_fields').eq('id', call.lead_id).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  return renderTemplate(script, {
    first_name: lead?.first_name || undefined,
    last_name: lead?.last_name || undefined,
    phone: lead?.phone_normalized || undefined,
    email: lead?.email || undefined,
    agent_name: spokenVoiceName(voice?.name ?? null) ?? 'your assistant',
    custom_field: (lead?.custom_fields as Record<string, string> | undefined) ?? undefined,
  });
}

/** Vapi's answer when the call has already ended by the time we act. */
function isCallAlreadyEnded(err: unknown): boolean {
  return err instanceof Error && /not active/i.test(err.message);
}

export async function handleVoicemailBackstop(supabase: Supabase, callId: string, aiText: string[] = []): Promise<'ended' | 'skipped'> {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (!call || !ACTIVE_STATUSES.has(call.status)) return 'skipped';
  const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
  if (!providerCallId) return 'skipped';

  let message: string | null = null;
  if (call.campaign_id) {
    const { data: campaign } = await supabase.from('campaigns').select('leave_voicemail, voicemail_message').eq('id', call.campaign_id).maybeSingle();
    if (campaign?.leave_voicemail && typeof campaign.voicemail_message === 'string' && campaign.voicemail_message.trim()) {
      message = await renderVoicemailScript(supabase, call, campaign.voicemail_message.trim());
    }
  }
  if (alreadyLeavingMessage(aiText, message)) return 'skipped';

  const provider = await resolveProviderForCall(supabase, call);
  if (call.engine === 'vapi') {
    const live = await provider.getCall(providerCallId);
    if (live.status !== 'in-progress') return 'skipped';
  }

  // Recorded first, so the call is disposed as VOICEMAIL however it ends -
  // but never allowed to stop the hang-up below. (The transition context is
  // written onto the calls row, so it must only carry real columns: an
  // unknown one failed every backstop hang-up on 29 Sep.)
  try {
    await supabase.from('call_events').insert({
      call_id: call.id,
      organization_id: call.organization_id,
      event_type: 'call.amd_detected',
      payload: { amd: true, source: 'transcript_backstop' },
    });
    if (call.status === 'in_progress') {
      await transitionCallState(supabase, call.id, 'voicemail');
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('voicemailBackstop: could not mark call as voicemail', call.id, err);
  }

  const sayer = provider as unknown as { say?: (id: string, text: string) => Promise<void> };
  if (message && typeof sayer.say === 'function') {
    try {
      await sayer.say(providerCallId, message);
      await new Promise((resolve) => setTimeout(resolve, speakingTimeMs(message!)));
    } catch (err) {
      // Vapi's own detector usually gets there first and has already ended
      // the call ("Not Active") - nothing left to do.
      if (isCallAlreadyEnded(err)) return 'skipped';
      // Couldn't leave it - still hang up rather than keep talking to a recording.
      // eslint-disable-next-line no-console
      console.error('voicemailBackstop: could not leave the voicemail script', call.id, err);
    }
  }
  try {
    await provider.endCall(providerCallId);
  } catch (err) {
    if (isCallAlreadyEnded(err)) return 'skipped';
    throw err;
  }
  return 'ended';
}

/** Called for every finished line on a live call. Never throws. */
export function checkForVoicemail(
  supabase: Supabase,
  call: Record<string, any>,
  speaker: 'ai' | 'caller',
  text: string,
  secondsFromStart: number | null,
): void {
  if (call.direction && call.direction !== 'outbound') return;
  const w = watchFor(call.id);
  if (w.handled) return;
  if (speaker === 'ai') {
    w.aiText.push(text);
    return;
  }
  w.callerLines += 1;
  if (w.callerLines > MAX_CALLER_LINES) return;
  if (secondsFromStart != null && secondsFromStart > MAX_SECONDS_FROM_START) return;
  if (!isVoicemailGreeting(text)) return;
  w.handled = true;
  const timer = setTimeout(() => {
    handleVoicemailBackstop(supabase, call.id, w.aiText)
      .then((result) => {
        if (result === 'ended') {
          // eslint-disable-next-line no-console
          console.info('voicemailBackstop ended call', call.id);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('voicemailBackstop failed for call', call.id, err);
      });
  }, BACKSTOP_DELAY_MS);
  timer.unref?.();
}

/** Test hook. */
export function resetVoicemailWatches(): void {
  watches.clear();
}
