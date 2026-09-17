import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import {
  cloneVoiceMetadataSchema,
  listVoicesQuerySchema,
  previewVoiceSchema,
  voiceProviderKeySchema,
} from '../schemas/voices.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, VOICE_PROVIDER_LABELS, type VoiceProviderKey } from '@shivanshconnect/shared';
import type { EncryptedEnvelope } from '../lib/crypto/credentials.js';
import { createVoiceProviderAdapter } from '../lib/voice/index.js';
import { VoiceCloningNotSupportedError, VoiceProviderNotConfiguredError } from '../lib/voice/types.js';
import { getStorageAdapter } from '../lib/storage/index.js';
import { StorageNotConfiguredError } from '../lib/storage/types.js';
import { toAdapterCredentials } from './voiceProviders.js';
import { randomUUID } from 'node:crypto';

const VOICE_COLUMNS =
  'id, organization_id, provider_key, provider_voice_id, name, gender, language, accent, description, status, is_cloned, source_sample_storage_path, clone_status, consent_confirmed, created_by, created_at, updated_at';

const SELF_HOSTED_PROVIDERS: VoiceProviderKey[] = ['omnivoice', 'voxcpm'];

function withHostingFlag<T extends { provider_key: string }>(voice: T) {
  return { ...voice, requires_external_hosting: SELF_HOSTED_PROVIDERS.includes(voice.provider_key as VoiceProviderKey) };
}

async function getOwnedVoice(supabase: ReturnType<typeof getSupabaseAdmin>, id: string, orgId: string) {
  const { data: voice, error } = await supabase.from('voices').select(VOICE_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!voice || voice.organization_id !== orgId) throw new NotFoundError('Voice not found.');
  return voice;
}

async function getAdapterForOrgProvider(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  providerKey: VoiceProviderKey,
) {
  const { data: credRow, error } = await supabase
    .from('voice_provider_credentials')
    .select('encrypted_credentials')
    .eq('organization_id', orgId)
    .eq('provider_key', providerKey)
    .maybeSingle();
  if (error) throw error;
  if (!credRow) {
    throw new VoiceProviderNotConfiguredError(
      `${VOICE_PROVIDER_LABELS[providerKey]} is not connected for this organization. Add credentials under Voice Providers first.`,
    );
  }
  const credentials = toAdapterCredentials(providerKey, credRow.encrypted_credentials as EncryptedEnvelope);
  return createVoiceProviderAdapter(providerKey, credentials);
}

export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('voices.manage'));

  // GET /api/v1/voices
  app.get('/', async (req) => {
    const query = listVoicesQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('voices').select(VOICE_COLUMNS, { count: 'exact' }).eq('organization_id', orgId);
    if (query.provider_key) builder = builder.eq('provider_key', query.provider_key);
    if (query.language) builder = builder.eq('language', query.language);
    if (query.gender) builder = builder.eq('gender', query.gender);
    if (query.status) builder = builder.eq('status', query.status);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;

    return ok((data ?? []).map(withHostingFlag), { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // POST /api/v1/voices/sync/:providerKey - calls listVoices() on the
  // org's connected adapter and upserts into voices, deduped on
  // (organization_id, provider_key, provider_voice_id).
  app.post('/sync/:providerKey', async (req) => {
    const { providerKey: rawKey } = req.params as { providerKey: string };
    const providerKey = voiceProviderKeySchema.parse(rawKey);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const adapter = await getAdapterForOrgProvider(supabase, orgId, providerKey);
    const remoteVoices = await adapter.listVoices();

    const { data: existingRows } = await supabase
      .from('voices')
      .select('id, provider_voice_id')
      .eq('organization_id', orgId)
      .eq('provider_key', providerKey);
    const existingByProviderVoiceId = new Map((existingRows ?? []).map((r) => [r.provider_voice_id as string, r.id as string]));

    let created = 0;
    let updated = 0;
    for (const v of remoteVoices) {
      const existingId = existingByProviderVoiceId.get(v.providerVoiceId);
      const row = {
        organization_id: orgId,
        provider_key: providerKey,
        provider_voice_id: v.providerVoiceId,
        name: v.name,
        gender: v.gender ?? 'unknown',
        language: v.language ?? null,
        accent: v.accent ?? null,
        description: v.description ?? null,
        is_cloned: false,
        clone_status: 'n/a' as const,
        consent_confirmed: false,
        created_by: req.user!.id,
      };
      if (existingId) {
        const { error } = await supabase.from('voices').update(row).eq('id', existingId);
        if (error) throw error;
        updated += 1;
      } else {
        const { error } = await supabase.from('voices').insert(row);
        if (error) throw error;
        created += 1;
      }
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.VOICE_SYNCED,
      entityType: 'voice_provider_credentials',
      entityId: null,
      newValue: { provider_key: providerKey, created, updated, total_remote: remoteVoices.length },
      ipAddress: req.ip,
    });

    return ok(
      { provider_key: providerKey, created, updated, total_remote: remoteVoices.length },
      { message: `Synced ${remoteVoices.length} voice(s) from ${VOICE_PROVIDER_LABELS[providerKey]}.` },
    );
  });

  // POST /api/v1/voices/:id/preview
  app.post('/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = previewVoiceSchema.parse(req.body ?? {});
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const voice = await getOwnedVoice(supabase, id, orgId);
    const providerKey = voice.provider_key as VoiceProviderKey;
    const adapter = await getAdapterForOrgProvider(supabase, orgId, providerKey);

    // For a cloned voice on a self-hosted provider, provider_voice_id IS
    // the reference-sample URL (see lib/voice/voxcpm.ts / omnivoice.ts's
    // createVoice()) - previewVoice() already knows how to use that as a
    // ref_audio/reference_audio_url value, so it's passed through as-is.
    const { audio, contentType } = await adapter.previewVoice(voice.provider_voice_id, body.sample_text);

    const storage = getStorageAdapter();
    if (!storage.isConfigured) {
      throw new StorageNotConfiguredError('Object storage is not configured - generated preview audio cannot be saved.');
    }
    const extension = contentType.includes('wav') ? 'wav' : 'mp3';
    const { url } = await storage.putObject(`${randomUUID()}.${extension}`, audio, contentType);

    return reply.status(200).send(ok({ url, content_type: contentType }, { message: 'Preview generated.' }));
  });

  // POST /api/v1/voices/clone
  app.post('/clone', async (req, reply) => {
    if (!req.isMultipart()) {
      throw new ValidationError('Voice cloning must be sent as multipart/form-data with a "sample" file field and metadata fields.');
    }

    const fields: Record<string, string> = {};
    let sampleBuffer: Buffer | null = null;
    let sampleFileName = '';
    let sampleContentType = '';

    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'sample') continue;
        sampleBuffer = await part.toBuffer();
        sampleFileName = part.filename;
        sampleContentType = part.mimetype;
      } else {
        fields[part.fieldname] = part.value as string;
      }
    }

    if (!sampleBuffer || sampleBuffer.length === 0) {
      throw new ValidationError('A reference audio sample ("sample" field) is required to clone a voice.');
    }
    if (!/\.(mp3|wav|m4a)$/i.test(sampleFileName)) {
      throw new ValidationError('Only .mp3, .wav and .m4a reference samples are supported.');
    }

    // consent_confirmed must arrive as the literal string "true" over
    // multipart form fields - Zod's z.literal(true) below rejects
    // anything else, including a missing field, per the hard compliance
    // rule that cloning is opt-in and explicit.
    const parsedMeta = cloneVoiceMetadataSchema.safeParse({
      ...fields,
      consent_confirmed: fields.consent_confirmed === 'true' ? true : fields.consent_confirmed,
    });
    if (!parsedMeta.success) {
      throw new ValidationError('Invalid voice cloning request.', parsedMeta.error.flatten());
    }
    const meta = parsedMeta.data;

    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const adapter = await getAdapterForOrgProvider(supabase, orgId, meta.provider_key);
    if (!adapter.supportsCloning || !adapter.createVoice) {
      throw new VoiceCloningNotSupportedError(VOICE_PROVIDER_LABELS[meta.provider_key]);
    }

    const storage = getStorageAdapter();
    if (!storage.isConfigured) {
      throw new StorageNotConfiguredError('Object storage is not configured - the reference sample cannot be saved.');
    }
    const extension = sampleFileName.split('.').pop() ?? 'wav';
    const { path: storagePath, url: storageUrl } = await storage.putObject(
      `${randomUUID()}.${extension}`,
      sampleBuffer,
      sampleContentType,
    );

    const apiOrigin = `${req.protocol}://${req.headers.host}`;
    const sampleAudioUrl = `${apiOrigin}${storageUrl}`;

    const { data: voice, error } = await supabase
      .from('voices')
      .insert({
        organization_id: orgId,
        provider_key: meta.provider_key,
        provider_voice_id: `pending-${randomUUID()}`,
        name: meta.name,
        description: meta.description ?? null,
        language: meta.language ?? null,
        accent: meta.accent ?? null,
        gender: meta.gender ?? 'unknown',
        is_cloned: true,
        source_sample_storage_path: storagePath,
        clone_status: 'pending',
        consent_confirmed: true,
        created_by: req.user!.id,
      })
      .select(VOICE_COLUMNS)
      .single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.VOICE_CLONE_REQUESTED,
      entityType: 'voice',
      entityId: voice.id,
      newValue: { provider_key: meta.provider_key, name: meta.name },
      ipAddress: req.ip,
    });

    // Async hand-off, same setImmediate pattern as Phase 2's lead import
    // and Phase 3's knowledge-document processing - the request returns
    // immediately with clone_status=pending; the frontend polls GET
    // /voices for it to reach ready/failed.
    setImmediate(() => {
      (async () => {
        await supabase.from('voices').update({ clone_status: 'processing' }).eq('id', voice.id);
        try {
          const result = await adapter.createVoice!({
            name: meta.name,
            sampleAudio: sampleBuffer!,
            sampleFileName,
            sampleContentType,
            sampleAudioUrl,
            description: meta.description,
          });
          await supabase
            .from('voices')
            .update({ provider_voice_id: result.providerVoiceId, clone_status: result.status })
            .eq('id', voice.id);
        } catch (err) {
          req.log.error({ err, voiceId: voice.id }, 'Voice cloning failed');
          await supabase.from('voices').update({ clone_status: 'failed' }).eq('id', voice.id);
        }
      })().catch((err) => req.log.error({ err, voiceId: voice.id }, 'Voice cloning hand-off failed'));
    });

    return reply.status(202).send(ok(withHostingFlag(voice), { message: 'Voice cloning started.' }));
  });

  // DELETE /api/v1/voices/:id
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const voice = await getOwnedVoice(supabase, id, orgId);

    const { error } = await supabase.from('voices').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.VOICE_DELETED,
      entityType: 'voice',
      entityId: id,
      oldValue: { name: voice.name, provider_key: voice.provider_key },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });
}
