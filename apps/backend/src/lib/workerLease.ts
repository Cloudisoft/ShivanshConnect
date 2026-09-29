/**
 * Only one backend process runs the background workers at a time - see
 * supabase/migrations/00000000000064_worker_leases.sql. During a deploy the
 * old and new containers overlap; before this, both ran the campaign dialer
 * and campaigns went over their concurrency limit.
 *
 * waitForWorkerLease() resolves once this process holds the lease (the old
 * container releases it on shutdown, or it expires LEASE_TTL_SECONDS after
 * that container stops renewing). The holder renews every RENEW_MS; if it
 * ever finds another process holding the lease, it exits so it can never
 * dial alongside it (Railway restarts it as a standby).
 */
import { randomUUID } from 'node:crypto';
import { getSupabaseAdmin } from './supabase.js';

const LEASE_NAME = 'background-workers';
const LEASE_TTL_SECONDS = 20;
const RENEW_MS = 5000;

const holderId = `${process.env.RAILWAY_DEPLOYMENT_ID ?? 'local'}:${randomUUID()}`;
let held = false;
let renewTimer: ReturnType<typeof setInterval> | null = null;

async function claim(): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().rpc('claim_worker_lease', {
    p_name: LEASE_NAME,
    p_holder: holderId,
    p_ttl_seconds: LEASE_TTL_SECONDS,
  });
  if (error) throw error;
  return data === true;
}

export function holdsWorkerLease(): boolean {
  return held;
}

export async function waitForWorkerLease(log: (msg: string) => void): Promise<void> {
  let announced = false;
  for (;;) {
    try {
      if (await claim()) break;
      if (!announced) {
        log('worker lease held by another backend process - waiting to take over');
        announced = true;
      }
    } catch (err) {
      log(`worker lease claim failed, retrying: ${(err as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RENEW_MS));
  }
  held = true;
  log(`worker lease acquired (${holderId})`);
  renewTimer = setInterval(() => {
    claim()
      .then((ok) => {
        if (!ok && held) {
          log('worker lease lost to another backend process - exiting so only one runs the workers');
          process.exit(1);
        }
      })
      // A failed renewal (database blip) is retried on the next beat; the
      // lease only moves once it has gone unrenewed for LEASE_TTL_SECONDS.
      .catch((err) => log(`worker lease renewal failed: ${(err as Error).message}`));
  }, RENEW_MS);
  renewTimer.unref?.();
}

/** Called on shutdown, so the new container takes over at once. */
export async function releaseWorkerLease(): Promise<void> {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
  if (!held) return;
  held = false;
  await getSupabaseAdmin().rpc('release_worker_lease', { p_name: LEASE_NAME, p_holder: holderId });
}
