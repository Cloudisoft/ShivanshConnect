import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError } from '../lib/errors.js';
import { vapiCredentialsSchema } from '../schemas/orchestration.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, type VapiCredentialSummary } from '@shivanshconnect/shared';
import { decryptCredentials, encryptCredentials, maskSecret, type EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { createOrchestrationProvider } from '../lib/orchestration/index.js';
import { VapiProvider } from '../lib/orchestration/vapi.js';
import { getEnv } from '../env.js';

function decryptApiKey(encrypted: EncryptedEnvelope): string {
  return decryptCredentials<{ api_key: string }>(encrypted).api_key;
}

export async function vapiRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('agents.manage'));

  // GET /api/v1/vapi/credentials - this org's Vapi connection status.
  // Never returns the raw API key, only a masked preview.
  app.get('/credentials', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: row, error } = await supabase
      .from('vapi_credentials')
      .select('encrypted_credentials, status, last_verified_at, last_error, webhook_url')
      .eq('organization_id', orgId)
      .maybeSingle();
    if (error) throw error;

    if (!row) {
      const summary: VapiCredentialSummary = { status: 'not_connected', masked_credential: null, last_verified_at: null, last_error: null, webhook_url: null };
      return ok(summary);
    }

    let masked: string | null = null;
    try {
      masked = maskSecret(decryptApiKey(row.encrypted_credentials as EncryptedEnvelope));
    } catch {
      masked = null; // decryption/key issue - never leak a raw envelope or throw the whole read
    }

    const summary: VapiCredentialSummary = {
      status: row.status,
      masked_credential: masked,
      last_verified_at: row.last_verified_at,
      last_error: row.last_error,
      webhook_url: row.webhook_url,
    };
    return ok(summary);
  });

  // POST /api/v1/vapi/credentials
  app.post('/credentials', async (req, reply) => {
    const body = vapiCredentialsSchema.parse(req.body);
    const encrypted = encryptCredentials(body);

    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing } = await supabase.from('vapi_credentials').select('id').eq('organization_id', orgId).maybeSingle();

    let saved;
    if (existing) {
      const { data, error } = await supabase
        .from('vapi_credentials')
        .update({ encrypted_credentials: encrypted, status: 'not_connected', last_error: null })
        .eq('id', existing.id)
        .select('id, status, last_verified_at, webhook_url')
        .single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('vapi_credentials')
        .insert({ organization_id: orgId, encrypted_credentials: encrypted, status: 'not_connected', created_by: req.user!.id })
        .select('id, status, last_verified_at, webhook_url')
        .single();
      if (error) throw error;
      saved = data;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.VAPI_CREDENTIALS_SAVED,
      entityType: 'vapi_credentials',
      entityId: saved.id,
      ipAddress: req.ip,
    });

    const summary: VapiCredentialSummary = {
      status: saved.status,
      masked_credential: maskSecret(body.api_key),
      last_verified_at: saved.last_verified_at,
      last_error: null,
      webhook_url: saved.webhook_url,
    };
    return reply.status(200).send(ok(summary, { message: 'Vapi credentials saved.' }));
  });

  // POST /api/v1/vapi/test-connection - real check against the Vapi API
  // (a lightweight authenticated read: listing assistants), and persists
  // the genuine pass/fail result.
  app.post('/test-connection', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: credRow, error } = await supabase
      .from('vapi_credentials')
      .select('id, encrypted_credentials')
      .eq('organization_id', orgId)
      .maybeSingle();
    if (error) throw error;
    if (!credRow) {
      throw new NotFoundError('No Vapi credentials are stored yet. Add an API key under Settings > Integrations first.');
    }

    const apiKey = decryptApiKey(credRow.encrypted_credentials as EncryptedEnvelope);
    const provider = createOrchestrationProvider('vapi', { api_key: apiKey }) as VapiProvider;

    let status: 'connected' | 'error' = 'connected';
    let message = 'Connection verified.';
    let lastError: string | null = null;
    let webhookUrl: string | null = null;

    try {
      await provider.ping();

      // Vapi delivers call-status/end-of-call/transcript events to a
      // server URL set per-assistant (there is no account-wide webhook
      // API - see lib/orchestration/vapi.ts's header comment) - it has no
      // way to discover ours on its own, so every successful connection
      // re-registers it on every assistant already in this org's Vapi
      // account. Idempotent, and it means a connection that "works"
      // always also means "will actually deliver call updates", rather
      // than depending on new agents happening to be republished after
      // this was fixed.
      const env = getEnv();
      if (env.BACKEND_PUBLIC_URL) {
        webhookUrl = `${env.BACKEND_PUBLIC_URL.replace(/\/+$/, '')}/api/v1/webhooks/vapi`;
        try {
          await provider.registerWebhook(webhookUrl);
        } catch (err) {
          // The connection itself is still good even if registering the
          // webhook fails (e.g. a transient Vapi API error) - surface it
          // as the connection's error instead of silently dropping it.
          status = 'error';
          message = `Connected, but failed to register the call-status webhook: ${err instanceof Error ? err.message : 'unknown error'}`;
          lastError = message;
          webhookUrl = null;
        }
      } else {
        // BACKEND_PUBLIC_URL missing used to silently skip webhook
        // registration entirely while still reporting 'connected' - every
        // call placed under that state got stuck at 'dialing' forever
        // (Vapi has nowhere to send status-update/end-of-call-report
        // events), with nothing in System Health or here to explain why.
        // This is a real deployment misconfiguration, not a soft warning.
        status = 'error';
        message = 'Connected to Vapi, but BACKEND_PUBLIC_URL is not configured, so the call-status webhook could not be registered - every call would get stuck at "dialing" with no status updates. Set BACKEND_PUBLIC_URL in the backend service\'s environment variables, then test the connection again.';
        lastError = message;
      }
    } catch (err) {
      status = 'error';
      message = err instanceof Error ? err.message : 'Connection failed.';
      lastError = message;
    }

    const { data: updated, error: updateError } = await supabase
      .from('vapi_credentials')
      .update({
        status,
        last_error: lastError,
        last_verified_at: status === 'connected' ? new Date().toISOString() : null,
        ...(webhookUrl ? { webhook_url: webhookUrl } : {}),
      })
      .eq('id', credRow.id)
      .select('status, last_verified_at, last_error, webhook_url')
      .single();
    if (updateError) throw updateError;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.VAPI_CONNECTION_TESTED,
      entityType: 'vapi_credentials',
      entityId: credRow.id,
      newValue: { status },
      ipAddress: req.ip,
    });

    return ok({ success: status === 'connected', ...updated }, { message });
  });
}
