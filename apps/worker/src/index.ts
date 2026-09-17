import 'dotenv/config';

/**
 * ShivanshConnect worker - Phase 1 placeholder.
 *
 * This package exists now purely so the Railway service wiring
 * (apps/worker as its own deployable service, its own env vars, its own
 * scaling) is trivial to turn on later. There is no real work for a
 * worker to do in Phase 1 - no queues, no dialing, no imports, no
 * recording processing exist yet. Those land starting Phase 3
 * (queues/Redis) and Phase 5+ (dialing/telephony).
 *
 * It intentionally does not fake a queue consumer or a polling loop:
 * it logs that it is alive and exits, so `pnpm dev`/CI never blocks on
 * a process with nothing to do, and so nobody mistakes "runs forever"
 * for "processes real jobs".
 */
function main(): void {
  // eslint-disable-next-line no-console
  console.log(
    '[worker] ShivanshConnect worker placeholder started. No job queues exist yet in Phase 1 ' +
      '(queues/Redis land in a later phase) - nothing to process. Exiting.',
  );
}

main();
