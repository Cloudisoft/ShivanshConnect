import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import {
  importPhoneNumberSchema,
  listPhoneNumbersQuerySchema,
  telephonyProviderKeySchema,
  updatePhoneNumberSchema,
} from '../schemas/phoneNumbers.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, TELEPHONY_PROVIDER_LABELS, type TelephonyProviderKey } from '@shivanshconnect/shared';
import { isValidNormalizedPhone, normalizePhoneNumber } from '../lib/phone.js';
import type { EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { encryptCredentials } from '../lib/crypto/credentials.js';
import { createTelephonyProviderAdapter, type PhoneNumberCapabilities } from '../lib/telephony/index.js';
import { toAdapterCredentials } from './phoneNumberProviders.js';

const PHONE_NUMBER_COLUMNS =
  'id, organization_id, provider_key, provider_number_id, phone_number, friendly_name, capabilities, status, assigned_agent_id, assigned_campaign_id, sip_trunk_metadata, created_by, created_at, updated_at';

function toApiCapabilities(caps: PhoneNumberCapabilities) {
  return { voice_inbound: caps.voiceInbound, voice_outbound: caps.voiceOutbound, sms: caps.sms };
}

/** Strips any secret out of sip_trunk_metadata before it ever leaves the
 * server - the password field is stored as an encrypted envelope and must
 * never be echoed back, even encrypted. */
function sanitizeRow<T extends { sip_trunk_metadata: Record<string, unknown> | null }>(row: T): T {
  if (!row.sip_trunk_metadata) return row;
  const { host, username } = row.sip_trunk_metadata as { host?: string; username?: string };
  return { ...row, sip_trunk_metadata: { host, username } };
}

async function getOwnedNumber(supabase: ReturnType<typeof getSupabaseAdmin>, id: string, orgId: string) {
  const { data: row, error } = await supabase.from('phone_numbers').select(PHONE_NUMBER_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!row || row.organization_id !== orgId) throw new NotFoundError('Phone number not found.');
  return row;
}

async function getAdapterForOrgProvider(supabase: ReturnType<typeof getSupabaseAdmin>, orgId: string, providerKey: 'twilio' | 'telnyx') {
  const { data: credRow, error } = await supabase
    .from('phone_number_provider_credentials')
    .select('encrypted_credentials')
    .eq('organization_id', orgId)
    .eq('provider_key', providerKey)
    .maybeSingle();
  if (error) throw error;
  if (!credRow) {
    throw new ValidationError(
      `${TELEPHONY_PROVIDER_LABELS[providerKey]} is not connected for this organization. Add credentials under Phone Providers first.`,
    );
  }
  const credentials = toAdapterCredentials(providerKey, credRow.encrypted_credentials as EncryptedEnvelope);
  return createTelephonyProviderAdapter(providerKey, credentials);
}

export async function phoneNumberRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('numbers.manage'));

  // GET /api/v1/phone-numbers
  app.get('/', async (req) => {
    const query = listPhoneNumbersQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('phone_numbers').select(PHONE_NUMBER_COLUMNS, { count: 'exact' }).eq('organization_id', orgId);
    if (query.provider_key) builder = builder.eq('provider_key', query.provider_key);
    if (query.status) builder = builder.eq('status', query.status);
    if (query.assigned_agent_id) builder = builder.eq('assigned_agent_id', query.assigned_agent_id);
    if (query.unassigned) builder = builder.is('assigned_agent_id', null);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;

    return ok(
      (data ?? []).map((row) => sanitizeRow({ ...row, capabilities: row.capabilities })),
      { pagination: paginationMeta(query.page, query.page_size, count ?? 0) },
    );
  });

  // POST /api/v1/phone-numbers/sync/:providerKey - calls listNumbers() on
  // the org's connected Twilio/Telnyx adapter and upserts into
  // phone_numbers, deduped on (organization_id, provider_key,
  // provider_number_id). Never duplicates: a remote number already
  // registered for this org under a *different* provider (same E.164) is
  // skipped and reported, not silently overwritten.
  app.post('/sync/:providerKey', async (req) => {
    const { providerKey: rawKey } = req.params as { providerKey: string };
    const providerKey = telephonyProviderKeySchema.parse(rawKey);
    if (providerKey === 'byon') {
      throw new ValidationError('BYON has no provider to sync from - use POST /phone-numbers/import to declare a number manually.');
    }

    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const adapter = await getAdapterForOrgProvider(supabase, orgId, providerKey);
    const remoteNumbers = await adapter.listNumbers();

    const { data: existingRows } = await supabase.from('phone_numbers').select('id, provider_number_id, phone_number').eq('organization_id', orgId);
    const byProviderNumberId = new Map(
      (existingRows ?? []).filter((r) => r.provider_number_id).map((r) => [r.provider_number_id as string, r.id as string]),
    );
    const byPhoneNumber = new Map((existingRows ?? []).map((r) => [r.phone_number as string, r.id as string]));

    let created = 0;
    let updated = 0;
    let skippedConflicts = 0;
    for (const n of remoteNumbers) {
      const normalized = normalizePhoneNumber(n.phoneNumber);
      if (!isValidNormalizedPhone(normalized)) {
        skippedConflicts += 1;
        continue;
      }
      const e164 = normalized.e164;
      const existingByProviderId = n.providerNumberId ? byProviderNumberId.get(n.providerNumberId) : undefined;

      const row = {
        organization_id: orgId,
        provider_key: providerKey,
        provider_number_id: n.providerNumberId,
        phone_number: e164,
        friendly_name: n.friendlyName,
        capabilities: toApiCapabilities(n.capabilities),
        created_by: req.user!.id,
      };

      if (existingByProviderId) {
        const { error } = await supabase.from('phone_numbers').update(row).eq('id', existingByProviderId);
        if (error) throw error;
        updated += 1;
        continue;
      }

      // Not previously synced under this provider id - but if this exact
      // E.164 is already registered for this org (e.g. imported manually,
      // or owned under a different provider record), never create a
      // second row for it.
      if (byPhoneNumber.has(e164)) {
        skippedConflicts += 1;
        continue;
      }

      const { data: inserted, error } = await supabase.from('phone_numbers').insert(row).select('id').single();
      if (error) throw error;
      byPhoneNumber.set(e164, inserted.id);
      if (n.providerNumberId) byProviderNumberId.set(n.providerNumberId, inserted.id);
      created += 1;
    }

    await supabase
      .from('phone_number_provider_credentials')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('organization_id', orgId)
      .eq('provider_key', providerKey);

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.PHONE_NUMBER_SYNCED,
      entityType: 'phone_number_provider_credentials',
      entityId: null,
      newValue: { provider_key: providerKey, created, updated, skipped_conflicts: skippedConflicts, total_remote: remoteNumbers.length },
      ipAddress: req.ip,
    });

    return ok(
      { provider_key: providerKey, created, updated, skipped_conflicts: skippedConflicts, total_remote: remoteNumbers.length },
      { message: `Synced ${remoteNumbers.length} number(s) from ${TELEPHONY_PROVIDER_LABELS[providerKey]}.` },
    );
  });

  // POST /api/v1/phone-numbers/import - BYON manual declaration (no
  // external call), or a single Twilio/Telnyx number import by provider id
  // (a real, individual provider API call - useful outside a full sync).
  app.post('/import', async (req) => {
    const body = importPhoneNumberSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let imported;
    if (body.provider_key === 'byon') {
      const adapter = createTelephonyProviderAdapter('byon');
      try {
        imported = await adapter.importNumber({
          e164: body.phone_number,
          friendlyName: body.friendly_name ?? null,
          capabilities: {
            voiceInbound: body.capabilities.voice_inbound,
            voiceOutbound: body.capabilities.voice_outbound,
            sms: body.capabilities.sms,
          },
        });
      } catch (err) {
        // A BYON import failure is always a bad user input (invalid E.164
        // or missing capability), never a provider outage - map it to a
        // client-actionable 422 rather than a 502.
        throw new ValidationError(err instanceof Error ? err.message : 'Invalid phone number declaration.');
      }
    } else {
      const adapter = await getAdapterForOrgProvider(supabase, orgId, body.provider_key);
      imported = await adapter.importNumber({ providerNumberId: body.provider_number_id });
    }

    const { data: existing } = await supabase.from('phone_numbers').select('id').eq('organization_id', orgId).eq('phone_number', imported.phoneNumber).maybeSingle();
    if (existing) {
      throw new ConflictError(`${imported.phoneNumber} is already registered for this organization.`);
    }

    let sipTrunkMetadata: Record<string, unknown> | null = null;
    if (body.provider_key === 'byon' && body.sip_trunk_metadata) {
      sipTrunkMetadata = {
        host: body.sip_trunk_metadata.host,
        username: body.sip_trunk_metadata.username,
        encrypted_password: encryptCredentials({ password: body.sip_trunk_metadata.password }),
      };
    }

    const { data: created, error } = await supabase
      .from('phone_numbers')
      .insert({
        organization_id: orgId,
        provider_key: body.provider_key,
        provider_number_id: imported.providerNumberId,
        phone_number: imported.phoneNumber,
        friendly_name: imported.friendlyName,
        capabilities: toApiCapabilities(imported.capabilities),
        sip_trunk_metadata: sipTrunkMetadata,
        created_by: req.user!.id,
      })
      .select(PHONE_NUMBER_COLUMNS)
      .single();
    if (error) throw error;

    if (body.provider_key !== 'byon') {
      await supabase
        .from('phone_number_provider_credentials')
        .update({ last_synced_at: new Date().toISOString() })
        .eq('organization_id', orgId)
        .eq('provider_key', body.provider_key);
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.PHONE_NUMBER_IMPORTED,
      entityType: 'phone_number',
      entityId: created.id,
      newValue: { provider_key: body.provider_key, phone_number: created.phone_number },
      ipAddress: req.ip,
    });

    return ok(sanitizeRow(created), { message: `${imported.phoneNumber} imported.` });
  });

  // PATCH /api/v1/phone-numbers/:id - assign/unassign to an agent, rename,
  // activate/deactivate.
  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updatePhoneNumberSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const existing = await getOwnedNumber(supabase, id, orgId);

    if (body.assigned_agent_id) {
      const { data: agent, error } = await supabase.from('ai_agents').select('id, organization_id').eq('id', body.assigned_agent_id).maybeSingle();
      if (error) throw error;
      if (!agent || agent.organization_id !== orgId) throw new ValidationError('That agent does not belong to your organization.');
    }

    const patch: Record<string, unknown> = {};
    if ('friendly_name' in body) patch.friendly_name = body.friendly_name;
    if (body.status) patch.status = body.status;
    if ('assigned_agent_id' in body) patch.assigned_agent_id = body.assigned_agent_id;
    if ('assigned_campaign_id' in body) patch.assigned_campaign_id = body.assigned_campaign_id;

    const { data: updated, error } = await supabase.from('phone_numbers').update(patch).eq('id', id).select(PHONE_NUMBER_COLUMNS).single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.PHONE_NUMBER_UPDATED,
      entityType: 'phone_number',
      entityId: id,
      oldValue: { friendly_name: existing.friendly_name, status: existing.status, assigned_agent_id: existing.assigned_agent_id },
      newValue: patch,
      ipAddress: req.ip,
    });

    return ok(sanitizeRow(updated), { message: 'Phone number updated.' });
  });

  // DELETE /api/v1/phone-numbers/:id - releases the number from
  // ShivanshConnect's own registry ONLY. For Twilio/Telnyx numbers this
  // NEVER calls the carrier to release/delete the real number - see
  // TwilioProvider/TelnyxProvider's disconnect() doc comment. Releasing a
  // real number from the carrier account is a deliberate, separate action
  // an org takes directly with Twilio/Telnyx, never a side effect of a DB
  // delete here.
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const existing = await getOwnedNumber(supabase, id, orgId);

    const { error } = await supabase.from('phone_numbers').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.PHONE_NUMBER_DELETED,
      entityType: 'phone_number',
      entityId: id,
      oldValue: { phone_number: existing.phone_number, provider_key: existing.provider_key },
      ipAddress: req.ip,
    });

    const carrierNote =
      existing.provider_key === 'byon'
        ? undefined
        : `This only removed ${existing.phone_number} from ShivanshConnect - it was NOT released from your ${TELEPHONY_PROVIDER_LABELS[existing.provider_key as TelephonyProviderKey]} account. Release it there directly if you no longer want to be billed for it.`;

    return ok({ deleted: true }, { message: carrierNote ?? 'Phone number removed.' });
  });
}
