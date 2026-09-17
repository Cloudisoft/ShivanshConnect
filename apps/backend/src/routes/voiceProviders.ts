import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { saveProviderCredentialsSchema, voiceProviderKeySchema } from '../schemas/voices.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, VOICE_PROVIDER_LABELS, type VoiceProviderKey, type VoiceProviderSummary } from '@shivanshconnect/shared';
import { decryptCredentials, encryptCredentials, maskSecret, type EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { createVoiceProviderAdapter, type VoiceProviderCredentials } from '../lib/voice/index.js';
import { VoiceProviderNotConfiguredError } from '../lib/voice/types.js';

const SELF_HOSTED_PROVIDERS: VoiceProviderKey[] = ['omnivoice', 'voxcpm'];

function requiresExternalHosting(key: VoiceProviderKey): boolean {
  return SELF_HOSTED_PROVIDERS.includes(key);
}

/** Decrypts a stored credential row into the shape lib/voice/index.ts's
 * createVoiceProviderAdapter expects. Returns undefined if there is no
 * credential row (adapter then falls back to its env var default, same
 * as lib/llm's pattern). */
function toAdapterCredentials(
  providerKey: VoiceProviderKey,
  encrypted: EncryptedEnvelope,
): VoiceProviderCredentials {
  const plaintext = decryptCredentials<Record<string, string>>(encrypted);
  if (requiresExternalHosting(providerKey)) {
    return { endpoint_url: plaintext.endpoint_url, api_key: plaintext.api_key };
  }
  return { api_key: plaintext.api_key };
}

function maskedPreview(providerKey: VoiceProviderKey, encrypted: EncryptedEnvelope): string {
  const plaintext = decryptCredentials<Record<string, string>>(encrypted);
  if (requiresExternalHosting(providerKey)) {
    return `${plaintext.endpoint_url} (${maskSecret(plaintext.api_key)})`;
  }
  return maskSecret(plaintext.api_key);
}

export async function voiceProviderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('voices.manage'));

  // GET /api/v1/voice-providers - the 4-provider catalog + this org's
  // connection status per provider. Never returns a raw secret - only a
  // masked preview derived after decrypting server-side.
  app.get('/', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: credRows, error } = await supabase
      .from('voice_provider_credentials')
      .select('provider_key, encrypted_credentials, status, last_verified_at, last_error')
      .eq('organization_id', orgId);
    if (error) throw error;

    const byKey = new Map((credRows ?? []).map((r) => [r.provider_key as VoiceProviderKey, r]));

    const summaries: VoiceProviderSummary[] = (Object.keys(VOICE_PROVIDER_LABELS) as VoiceProviderKey[]).map((key) => {
      const row = byKey.get(key);
      let masked: string | null = null;
      if (row) {
        try {
          masked = maskedPreview(key, row.encrypted_credentials as EncryptedEnvelope);
        } catch {
          masked = null; // decryption/key issue - never leak a raw envelope or throw the whole list
        }
      }
      return {
        key,
        display_name: VOICE_PROVIDER_LABELS[key],
        requires_external_hosting: requiresExternalHosting(key),
        status: (row?.status as VoiceProviderSummary['status']) ?? 'not_connected',
        masked_credential: masked,
        last_verified_at: row?.last_verified_at ?? null,
        last_error: row?.last_error ?? null,
      };
    });

    return ok(summaries);
  });

  // POST /api/v1/voice-providers/:key/credentials
  app.post('/:key/credentials', async (req, reply) => {
    const { key } = req.params as { key: string };
    const providerKey = voiceProviderKeySchema.parse(key);
    const body = saveProviderCredentialsSchema.parse(req.body);

    const isSelfHosted = requiresExternalHosting(providerKey);
    if (isSelfHosted && body.kind !== 'endpoint') {
      throw new ValidationError(`${VOICE_PROVIDER_LABELS[providerKey]} requires an endpoint URL and API key, not a plain API key.`);
    }
    if (!isSelfHosted && body.kind !== 'api_key') {
      throw new ValidationError(`${VOICE_PROVIDER_LABELS[providerKey]} takes a plain API key, not an endpoint URL.`);
    }

    const plaintext = body.kind === 'endpoint' ? { endpoint_url: body.endpoint_url, api_key: body.api_key } : { api_key: body.api_key };
    const encrypted = encryptCredentials(plaintext);

    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing } = await supabase
      .from('voice_provider_credentials')
      .select('id')
      .eq('organization_id', orgId)
      .eq('provider_key', providerKey)
      .maybeSingle();

    let saved;
    if (existing) {
      const { data, error } = await supabase
        .from('voice_provider_credentials')
        .update({ encrypted_credentials: encrypted, status: 'not_connected', last_error: null })
        .eq('id', existing.id)
        .select('id, provider_key, status, last_verified_at')
        .single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('voice_provider_credentials')
        .insert({
          organization_id: orgId,
          provider_key: providerKey,
          encrypted_credentials: encrypted,
          status: 'not_connected',
          created_by: req.user!.id,
        })
        .select('id, provider_key, status, last_verified_at')
        .single();
      if (error) throw error;
      saved = data;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.VOICE_PROVIDER_CREDENTIALS_SAVED,
      entityType: 'voice_provider_credentials',
      entityId: saved.id,
      newValue: { provider_key: providerKey },
      ipAddress: req.ip,
    });

    return reply.status(200).send(
      ok(
        {
          provider_key: saved.provider_key,
          status: saved.status,
          masked_credential: maskedPreview(providerKey, encrypted),
        },
        { message: 'Credentials saved.' },
      ),
    );
  });

  // POST /api/v1/voice-providers/:key/test-connection - actually calls
  // the adapter to verify the stored credentials work, and persists the
  // real pass/fail result.
  app.post('/:key/test-connection', async (req) => {
    const { key } = req.params as { key: string };
    const providerKey = voiceProviderKeySchema.parse(key);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: credRow, error } = await supabase
      .from('voice_provider_credentials')
      .select('id, encrypted_credentials')
      .eq('organization_id', orgId)
      .eq('provider_key', providerKey)
      .maybeSingle();
    if (error) throw error;
    if (!credRow) {
      throw new NotFoundError(`No credentials are stored for ${VOICE_PROVIDER_LABELS[providerKey]} yet.`);
    }

    const credentials = toAdapterCredentials(providerKey, credRow.encrypted_credentials as EncryptedEnvelope);
    const adapter = createVoiceProviderAdapter(providerKey, credentials);

    let status: 'connected' | 'error' = 'connected';
    let message = 'Connection verified.';
    let lastError: string | null = null;

    try {
      if (adapter.requiresExternalHosting) {
        // No fixed voice catalog exists to list against for a self-hosted
        // endpoint - the closest real end-to-end check is a tiny
        // synthesis call, which genuinely exercises auth + reachability.
        await adapter.previewVoice('connection-test-voice', 'Connection test.');
      } else {
        await adapter.listVoices();
      }
    } catch (err) {
      if (err instanceof VoiceProviderNotConfiguredError) throw err;
      status = 'error';
      message = err instanceof Error ? err.message : 'Connection failed.';
      lastError = message;
    }

    const { data: updated, error: updateError } = await supabase
      .from('voice_provider_credentials')
      .update({ status, last_verified_at: new Date().toISOString(), last_error: lastError })
      .eq('id', credRow.id)
      .select('provider_key, status, last_verified_at, last_error')
      .single();
    if (updateError) throw updateError;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.VOICE_PROVIDER_CONNECTION_TESTED,
      entityType: 'voice_provider_credentials',
      entityId: credRow.id,
      newValue: { provider_key: providerKey, status },
      ipAddress: req.ip,
    });

    return ok({ success: status === 'connected', ...updated }, { message });
  });
}

export { toAdapterCredentials };
