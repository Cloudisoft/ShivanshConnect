/**
 * Auto-transfer backstop, per explicit request: "when the AI says
 * transferring now it should transfer automatically to the transfer
 * number without waiting".
 *
 * The primary path is the transferCall tool every Vapi call now carries
 * (lib/orchestration/vapi.ts createCall()). This covers the case where
 * the model announces a transfer but never calls the tool: when an AI
 * utterance says it is transferring the caller, and a few seconds later
 * the call is still in progress with no transfer under way (checked
 * against Vapi itself too), the backend transfers the call to its own
 * server-resolved destination (calls.transfer_destination_e164) through
 * the same control-URL transfer the supervisor button uses.
 */
import { getSupabaseAdmin } from '../lib/supabase.js';
import { transitionCallState } from '../lib/callStateMachine.js';
import { resolveProviderForCall } from '../lib/orchestration/resolveProvider.js';

type Supabase = ReturnType<typeof getSupabaseAdmin>;

/** How long the transferCall tool gets to fire on its own first. */
const AUTO_TRANSFER_DELAY_MS = Number.parseInt(process.env.AUTO_TRANSFER_DELAY_MS ?? '', 10) || 3000;

const TRANSFER_ANNOUNCEMENT =
  /\b(transferring (you|the call|your call|now)|transfer(ring)? you (now|over|to|through)|i('| a)m (going to |gonna )?transfer(ring)? you|let me transfer you|i('| wi)ll transfer you|connect(ing)? you (now|with|to)|putting you through|i('| a)m (going to |gonna )?connect(ing)? you)\b/i;

const TRANSFERABLE_STATUSES = new Set(['answered', 'in_progress']);

const scheduled = new Set<string>();

export function announcesTransfer(text: string): boolean {
  return TRANSFER_ANNOUNCEMENT.test(text);
}

export async function performAutoTransfer(supabase: Supabase, callId: string): Promise<'transferred' | 'skipped'> {
  const { data: call } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
  if (!call || !call.transfer_destination_e164 || !TRANSFERABLE_STATUSES.has(call.status)) return 'skipped';
  const providerCallId = call.engine === 'vapi' ? call.vapi_call_id : call.pipecat_call_id;
  if (!providerCallId) return 'skipped';

  const provider = await resolveProviderForCall(supabase, call);
  if (call.engine === 'vapi') {
    // The transferCall tool may already have fired (Vapi status
    // 'forwarding') before our own status webhook landed.
    const live = await provider.getCall(providerCallId);
    if (live.status !== 'in-progress') return 'skipped';
  }

  const transition = await transitionCallState(supabase, call.id, 'transfer_pending', {
    transfer_status: 'pending',
    transfer_initiated_by: 'ai',
  });
  if (!transition.applied) return 'skipped';

  try {
    await provider.transferCall(providerCallId, call.transfer_destination_e164);
  } catch (err) {
    await supabase.from('calls').update({ transfer_status: 'failed' }).eq('id', call.id);
    throw err;
  }
  return 'transferred';
}

/** Called for every final AI utterance; schedules at most one backstop
 * transfer per call. Never throws. */
export function scheduleAutoTransferIfAnnounced(supabase: Supabase, call: Record<string, any>, speaker: 'ai' | 'caller', text: string): void {
  if (speaker !== 'ai' || !call.transfer_destination_e164 || scheduled.has(call.id) || !announcesTransfer(text)) return;
  scheduled.add(call.id);
  const timer = setTimeout(() => {
    performAutoTransfer(supabase, call.id)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('autoTransfer failed for call', call.id, err);
      })
      .finally(() => {
        // Allow a later announcement to retry if this one did nothing.
        setTimeout(() => scheduled.delete(call.id), 30_000).unref?.();
      });
  }, AUTO_TRANSFER_DELAY_MS);
  timer.unref?.();
}
