import { z } from 'zod';

/** POST /calls/:id/whisper. `text` is the supervisor's guidance/message -
 * see routes/liveMonitor.ts's header comment for exactly how this is
 * realized differently on Vapi (a real 'say' control message) vs pipecat
 * (a real control-channel message the pipeline mixes into the outbound
 * TTS leg). `action` lets the frontend explicitly end an in-progress
 * pipecat whisper session (closing the injection channel) without
 * sending more text. */
export const whisperCallSchema = z.object({
  text: z.string().trim().min(1).max(2000).optional(),
  action: z.enum(['start', 'message', 'end']).default('message'),
});
export type WhisperCallInput = z.infer<typeof whisperCallSchema>;

/** POST /calls/:id/barge. See routes/liveMonitor.ts for the honest
 * distinction between Vapi (listen + say composed) and pipecat (real
 * three-way audio mixing) this drives. */
export const bargeCallSchema = z.object({
  action: z.enum(['start', 'end']).default('start'),
});
export type BargeCallInput = z.infer<typeof bargeCallSchema>;

/** POST /calls/:id/transfer (supervisor-triggered manual transfer). The
 * destination is NEVER freely editable - it must equal this call's own
 * server-resolved `transfer_destination_e164` (set at call-creation time
 * from the campaign/agent's own configuration, spec 19/8L). Accepting it
 * here at all (rather than requiring no body) exists only so the
 * frontend's confirmation step round-trips the exact number it showed the
 * supervisor, and the route rejects any mismatch outright.
 */
export const supervisorTransferCallSchema = z.object({
  destination_e164: z.string().trim().min(1).max(20),
});
export type SupervisorTransferCallInput = z.infer<typeof supervisorTransferCallSchema>;
