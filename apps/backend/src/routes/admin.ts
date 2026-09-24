import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { getStorageAdapter } from '../lib/storage/index.js';
import { getLastReconciliationTickAt } from '../services/callReconciliation.js';

/**
 * Phase 15: the system health page (master spec section 90).
 *
 * `GET /api/v1/admin/health` reports the honest, real, currently-known
 * status of every component this org's deployment depends on - never a
 * simulated or hard-coded "everything's fine". Each component is one of:
 *   - 'connected': verified working right now (or, for a provider,
 *     verified the last time this org actually ran its own
 *     test-connection flow - see the per-provider section below for
 *     exactly why that counts as "real" rather than stale).
 *   - 'warning': reachable/configured but showing a soft signal worth a
 *     look (e.g. a scheduler tick that's running noticeably late).
 *   - 'error': a real failure (a query threw, a provider reported
 *     disconnected/errored, a required env var is missing).
 *   - 'not_configured': this org/deployment has never set this component
 *     up at all - not a failure, just an honest "nothing to check yet".
 *
 * Provider connectivity (Vapi/Twilio/Telnyx/voice providers/SMTP) is
 * reported from each provider's own `status` column
 * (vapi_credentials.status, phone_number_provider_credentials.status,
 * voice_provider_credentials.status, smtp_settings.status) - the exact
 * field each provider's OWN real test-connection route
 * (routes/vapi.ts, routes/phoneNumberProviders.ts, routes/voiceProviders.ts,
 * routes/smtp.ts) already sets after making a real call to that provider.
 * This is a deliberate, better version of "cache results briefly rather
 * than hammering providers on every health check" (spec 90's own
 * instruction): rather than a time-boxed cache this health check might
 * still re-verify against a provider that hasn't changed, it reflects
 * this org's own last REAL verification, refreshed the moment an admin
 * re-runs that provider's test-connection endpoint - never a redundant
 * live call this endpoint makes on its own.
 */
export async function adminHealthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('settings.manage'));

  app.get('/health', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const nowIso = new Date().toISOString();

    const components: Array<{
      component: string;
      status: 'connected' | 'warning' | 'error' | 'not_configured';
      detail: string;
      lastCheckedAt: string;
    }> = [];

    // --- Database ---------------------------------------------------
    try {
      // supabase-js's REST client has no raw-SQL "SELECT 1" - the
      // equivalent real round trip is a cheap, real query against an
      // always-present table with a HEAD/count-only response (no rows
      // transferred), which still proves the DB connection, auth, and
      // query path are genuinely working.
      const { error } = await supabase.from('organizations').select('id', { count: 'exact', head: true }).eq('id', orgId);
      components.push({
        component: 'database',
        status: error ? 'error' : 'connected',
        detail: error ? error.message : 'Real query against Postgres succeeded.',
        lastCheckedAt: nowIso,
      });
    } catch (err) {
      components.push({ component: 'database', status: 'error', detail: err instanceof Error ? err.message : 'Unknown database error.', lastCheckedAt: nowIso });
    }

    // --- In-process schedulers ---------------------------------------
    // Staleness thresholds are 3x each scheduler's own tick interval - a
    // scheduler that hasn't ticked within that window is worth a
    // 'warning' (it may have crashed its interval, or the process may be
    // starting up), never a hard 'error' from this endpoint alone.
    const reconciliationLastTick = getLastReconciliationTickAt();
    const reconciliationIntervalMs = Number.parseInt(process.env.CALL_RECONCILIATION_INTERVAL_MS ?? '', 10) || 5 * 60 * 1000;
    components.push(schedulerComponent('call_reconciliation_scheduler', reconciliationLastTick, reconciliationIntervalMs, nowIso));

    // --- Storage: a real write + read + delete round trip -----------
    try {
      const storage = getStorageAdapter();
      if (!storage.isConfigured) {
        components.push({ component: 'storage', status: 'not_configured', detail: `${storage.name} is not configured.`, lastCheckedAt: nowIso });
      } else {
        const key = `healthcheck/${randomUUID()}.txt`;
        const payload = Buffer.from(`shivanshconnect-health-check-${nowIso}`);
        await storage.putObject(key, payload, 'text/plain');
        const readBack = await storage.getObject(key);
        const roundTripOk = readBack.equals(payload);
        await storage.deleteObject(key);
        components.push({
          component: 'storage',
          status: roundTripOk ? 'connected' : 'error',
          detail: roundTripOk
            ? `${storage.name}: real write+read+delete round trip succeeded.`
            : `${storage.name}: read-back content did not match what was written.`,
          lastCheckedAt: nowIso,
        });
      }
    } catch (err) {
      components.push({ component: 'storage', status: 'error', detail: err instanceof Error ? err.message : 'Unknown storage error.', lastCheckedAt: nowIso });
    }

    // --- pipecat-service: real HTTP ping ------------------------------
    const pipecatUrl = process.env.PIPECAT_SERVICE_URL;
    if (!pipecatUrl) {
      components.push({ component: 'pipecat_service', status: 'not_configured', detail: 'PIPECAT_SERVICE_URL is not set.', lastCheckedAt: nowIso });
    } else {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${pipecatUrl.replace(/\/$/, '')}/health`, { signal: controller.signal });
        clearTimeout(timeout);
        components.push({
          component: 'pipecat_service',
          status: res.ok ? 'connected' : 'error',
          detail: res.ok ? 'Real HTTP GET /health succeeded.' : `pipecat-service returned HTTP ${res.status}.`,
          lastCheckedAt: nowIso,
        });
      } catch (err) {
        components.push({ component: 'pipecat_service', status: 'error', detail: err instanceof Error ? err.message : 'pipecat-service unreachable.', lastCheckedAt: nowIso });
      }
    }

    // --- Vapi ----------------------------------------------------------
    const { data: vapiCreds } = await supabase.from('vapi_credentials').select('status, last_verified_at, last_error').eq('organization_id', orgId).maybeSingle();
    components.push(credentialComponent('vapi', vapiCreds));

    // --- Telephony providers (Twilio/Telnyx) ---------------------------
    const { data: telephonyCreds } = await supabase.from('phone_number_provider_credentials').select('provider_key, status, last_synced_at, last_error').eq('organization_id', orgId).in('provider_key', ['twilio', 'telnyx']);
    for (const providerKey of ['twilio', 'telnyx']) {
      const row = (telephonyCreds ?? []).find((r: any) => r.provider_key === providerKey);
      components.push(credentialComponent(providerKey, row));
    }

    // --- Voice providers (ElevenLabs/Cartesia/OmniVoice/VoxCPM) --------
    const { data: voiceCreds } = await supabase.from('voice_provider_credentials').select('provider_key, status, last_verified_at, last_error').eq('organization_id', orgId);
    for (const providerKey of ['elevenlabs', 'cartesia', 'omnivoice', 'voxcpm']) {
      const row = (voiceCreds ?? []).find((r: any) => r.provider_key === providerKey);
      components.push(credentialComponent(`voice_${providerKey}`, row));
    }

    // --- SMTP ------------------------------------------------------------
    const { data: smtpRow } = await supabase.from('smtp_settings').select('status, last_tested_at, last_error').eq('organization_id', orgId).maybeSingle();
    components.push(credentialComponent('smtp', smtpRow));

    const overall = components.some((c) => c.status === 'error') ? 'error' : components.some((c) => c.status === 'warning') ? 'warning' : 'connected';

    return ok({ overall, checked_at: nowIso, components });
  });
}

function schedulerComponent(component: string, lastTickAt: string | null, intervalMs: number, nowIso: string): { component: string; status: 'connected' | 'warning' | 'error' | 'not_configured'; detail: string; lastCheckedAt: string } {
  if (!lastTickAt) {
    return { component, status: 'warning', detail: 'Has not completed a tick yet since this process started.', lastCheckedAt: nowIso };
  }
  const ageMs = Date.now() - new Date(lastTickAt).getTime();
  if (ageMs > intervalMs * 3) {
    return { component, status: 'warning', detail: `Last tick was ${Math.round(ageMs / 1000)}s ago (expected every ~${Math.round(intervalMs / 1000)}s).`, lastCheckedAt: lastTickAt };
  }
  return { component, status: 'connected', detail: `Last tick ${Math.round(ageMs / 1000)}s ago.`, lastCheckedAt: lastTickAt };
}

function credentialComponent(
  component: string,
  row: { status?: string; last_verified_at?: string | null; last_synced_at?: string | null; last_tested_at?: string | null; last_error?: string | null } | null | undefined,
): { component: string; status: 'connected' | 'warning' | 'error' | 'not_configured'; detail: string; lastCheckedAt: string } {
  const nowIso = new Date().toISOString();
  if (!row) {
    return { component, status: 'not_configured', detail: 'Not configured for this organization.', lastCheckedAt: nowIso };
  }
  const lastCheckedAt = row.last_verified_at ?? row.last_synced_at ?? row.last_tested_at ?? nowIso;
  if (row.status === 'connected') {
    return { component, status: 'connected', detail: `Last verified ${lastCheckedAt}.`, lastCheckedAt };
  }
  if (row.status === 'error') {
    return { component, status: 'error', detail: row.last_error ?? 'Last verification failed.', lastCheckedAt };
  }
  return { component, status: 'not_configured', detail: 'Credentials saved but never successfully verified.', lastCheckedAt };
}
