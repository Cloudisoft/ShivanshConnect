import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { telephonyProviderKeySchema, telnyxCredentialsSchema, twilioCredentialsSchema } from '../schemas/phoneNumbers.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, TELEPHONY_PROVIDER_LABELS, type TelephonyProviderKey, type TelephonyProviderSummary } from '@shivanshconnect/shared';
import { decryptCredentials, encryptCredentials, maskSecret, type EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { createTelephonyProviderAdapter, type TelephonyProviderCredentials } from '../lib/telephony/index.js';

/** Decrypts a stored credential row into the shape lib/telephony/index.ts's
 * createTelephonyProviderAdapter expects. */
function toAdapterCredentials(providerKey: 'twilio' | 'telnyx', encrypted: EncryptedEnvelope): TelephonyProviderCredentials {
  const plaintext = decryptCredentials<Record<string, string>>(encrypted);
  if (providerKey === 'twilio') {
    return { account_sid: plaintext.account_sid, auth_token: plaintext.auth_token };
  }
  return { api_key: plaintext.api_key };
}

function maskedPreview(providerKey: 'twilio' | 'telnyx', encrypted: EncryptedEnvelope): string {
  const plaintext = decryptCredentials<Record<string, string>>(encrypted);
  if (providerKey === 'twilio') {
    return `${maskSecret(plaintext.account_sid)} / ${maskSecret(plaintext.auth_token)}`;
  }
  return maskSecret(plaintext.api_key);
}

export async function phoneNumberProviderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('numbers.manage'));

  // GET /api/v1/phone-number-providers - the 3-provider catalog + this
  // org's connection status. BYON never has connection state - it is
  // always shown as manual-only with no masked credential. Raw secrets
  // are never returned, only a masked preview derived after decrypting
  // server-side.
  app.get('/', async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: credRows, error } = await supabase
      .from('phone_number_provider_credentials')
      .select('provider_key, encrypted_credentials, status, last_synced_at, last_error')
      .eq('organization_id', orgId);
    if (error) throw error;

    const byKey = new Map((credRows ?? []).map((r) => [r.provider_key as TelephonyProviderKey, r]));

    const summaries: TelephonyProviderSummary[] = (Object.keys(TELEPHONY_PROVIDER_LABELS) as TelephonyProviderKey[]).map((key) => {
      if (key === 'byon') {
        return {
          key,
          display_name: TELEPHONY_PROVIDER_LABELS[key],
          is_manual_only: true,
          status: 'not_connected',
          masked_credential: null,
          last_synced_at: null,
          last_error: null,
        };
      }
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
        display_name: TELEPHONY_PROVIDER_LABELS[key],
        is_manual_only: false,
        status: (row?.status as TelephonyProviderSummary['status']) ?? 'not_connected',
        masked_credential: masked,
        last_synced_at: row?.last_synced_at ?? null,
        last_error: row?.last_error ?? null,
      };
    });

    return ok(summaries);
  });

  // POST /api/v1/phone-number-providers/:key/credentials
  app.post('/:key/credentials', async (req, reply) => {
    const { key } = req.params as { key: string };
    const providerKey = telephonyProviderKeySchema.parse(key);

    if (providerKey === 'byon') {
      throw new ValidationError('BYON has no provider credentials - use "Import" on Phone Numbers to declare a number directly.');
    }

    const plaintext =
      providerKey === 'twilio' ? twilioCredentialsSchema.parse(req.body) : telnyxCredentialsSchema.parse(req.body);
    const encrypted = encryptCredentials(plaintext);

    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing } = await supabase
      .from('phone_number_provider_credentials')
      .select('id')
      .eq('organization_id', orgId)
      .eq('provider_key', providerKey)
      .maybeSingle();

    let saved;
    if (existing) {
      const { data, error } = await supabase
        .from('phone_number_provider_credentials')
        .update({ encrypted_credentials: encrypted, status: 'not_connected', last_error: null })
        .eq('id', existing.id)
        .select('id, provider_key, status, last_synced_at')
        .single();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('phone_number_provider_credentials')
        .insert({
          organization_id: orgId,
          provider_key: providerKey,
          encrypted_credentials: encrypted,
          status: 'not_connected',
          created_by: req.user!.id,
        })
        .select('id, provider_key, status, last_synced_at')
        .single();
      if (error) throw error;
      saved = data;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.TELEPHONY_PROVIDER_CREDENTIALS_SAVED,
      entityType: 'phone_number_provider_credentials',
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

  // POST /api/v1/phone-number-providers/:key/test-connection - actually
  // calls the adapter to verify the stored credentials work, and persists
  // the real pass/fail result.
  app.post('/:key/test-connection', async (req) => {
    const { key } = req.params as { key: string };
    const providerKey = telephonyProviderKeySchema.parse(key);
    if (providerKey === 'byon') {
      throw new ValidationError('BYON has no provider connection to test - it is a manual declaration, not an API integration.');
    }

    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: credRow, error } = await supabase
      .from('phone_number_provider_credentials')
      .select('id, encrypted_credentials')
      .eq('organization_id', orgId)
      .eq('provider_key', providerKey)
      .maybeSingle();
    if (error) throw error;
    if (!credRow) {
      throw new NotFoundError(`No credentials are stored for ${TELEPHONY_PROVIDER_LABELS[providerKey]} yet.`);
    }

    const credentials = toAdapterCredentials(providerKey, credRow.encrypted_credentials as EncryptedEnvelope);
    const adapter = createTelephonyProviderAdapter(providerKey, credentials);

    let status: 'connected' | 'error' = 'connected';
    let message = 'Connection verified.';
    let lastError: string | null = null;

    try {
      await adapter.connect(credentials as unknown as Record<string, string>);
    } catch (err) {
      status = 'error';
      message = err instanceof Error ? err.message : 'Connection failed.';
      lastError = message;
    }

    const { data: updated, error: updateError } = await supabase
      .from('phone_number_provider_credentials')
      .update({ status, last_error: lastError })
      .eq('id', credRow.id)
      .select('provider_key, status, last_synced_at, last_error')
      .single();
    if (updateError) throw updateError;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.TELEPHONY_PROVIDER_CONNECTION_TESTED,
      entityType: 'phone_number_provider_credentials',
      entityId: credRow.id,
      newValue: { provider_key: providerKey, status },
      ipAddress: req.ip,
    });

    return ok({ success: status === 'connected', ...updated }, { message });
  });
}

export { toAdapterCredentials };
