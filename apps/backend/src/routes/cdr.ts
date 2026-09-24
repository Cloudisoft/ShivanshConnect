/**
 * Phase 9: CDR API (master spec section 21).
 *
 * GET /cdr                          - paginated, filtered CDR list
 * GET /cdr/:callId                  - full CDR detail + transcript + a
 *                                      recording playback reference +
 *                                      summary
 * GET /cdr/:callId/recording/download - real audio bytes (re-encoded to
 *                                      MP3 via ffmpeg when available and
 *                                      the source isn't already MP3 - see
 *                                      maybeTranscodeToMp3()'s comment for
 *                                      exactly what happens when ffmpeg
 *                                      isn't installed)
 * GET /cdr/search-transcript          - full-text search across
 *                                      call_transcripts (Postgres tsvector
 *                                      + ts_rank via search_call_transcripts())
 * POST /cdr/export                    - queues a background export job
 *                                      (see services/cdrExport.ts) -
 *                                      routes/exports.ts serves its status/
 *                                      download.
 *
 * Every route here requires `cdr.view` (export additionally requires
 * `cdr.export`) and scopes every query to the caller's own
 * organization_id server-side, on top of RLS.
 */
import type { FastifyInstance } from 'fastify';
import { spawn } from 'node:child_process';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createExportSchema, listCdrQuerySchema, searchTranscriptQuerySchema } from '../schemas/cdr.js';
import { buildCdrRows, fetchCdrCallsPage, type CdrFilters } from '../services/cdrQuery.js';
import { queueCdrExport } from '../services/cdrExport.js';
import { getStorageAdapter, StorageObjectNotFoundError } from '../lib/storage/index.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

function extractFilters(query: Record<string, unknown>): CdrFilters {
  return {
    date_from: query.date_from as string | undefined,
    date_to: query.date_to as string | undefined,
    campaign_id: query.campaign_id as string | undefined,
    ai_agent_id: query.ai_agent_id as string | undefined,
    disposition: query.disposition as string | undefined,
    phone: query.phone as string | undefined,
    lead_id: query.lead_id as string | undefined,
    status: query.status as string | undefined,
  };
}

/** Re-encodes a local audio file to MP3 via a real `ffmpeg` child process
 * when one is available on PATH. Phase 9's build sandbox did not have
 * ffmpeg installed; Phase 14 re-checked this in a fresh sandbox and found
 * ffmpeg 6.1.1 IS now installed and on PATH (see README's Phase 14 note)
 * - this function's real-transcode branch now genuinely engages rather
 * than always hitting the fallback, proven by
 * `cdr.mp3Transcode.test.ts`'s real ffmpeg child-process test. When
 * ffmpeg is unavailable (ENOENT) or fails, the ORIGINAL bytes/format are
 * served as-is rather than faking a conversion, and the response's
 * Content-Type reflects the real source format - that fallback path is
 * unchanged from Phase 9. */
export async function maybeTranscodeToMp3(sourceBuffer: Buffer, sourceFormat: string): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
  if (sourceFormat === 'mp3') {
    return { buffer: sourceBuffer, contentType: 'audio/mpeg', extension: 'mp3' };
  }

  try {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      // Reads the source from stdin rather than a file path - the source
      // bytes now come from the storage adapter (local disk in tests,
      // Supabase Storage in production), not necessarily a real path on
      // this machine's filesystem.
      const proc = spawn('ffmpeg', ['-y', '-i', 'pipe:0', '-f', 'mp3', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (c) => chunks.push(c));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      proc.stdin.on('error', () => {
        // A write to a already-dead/erroring ffmpeg process throws EPIPE
        // here - the 'error'/'close' handlers above already reject this
        // promise for that same failure, so this only prevents an
        // unhandled 'error' event from crashing the process.
      });
      proc.stdin.end(sourceBuffer);
    });
    return { buffer, contentType: 'audio/mpeg', extension: 'mp3' };
  } catch {
    // ffmpeg not installed (ENOENT) or failed - serve the real source
    // bytes/format rather than fabricating an mp3.
    return { buffer: sourceBuffer, contentType: sourceFormat === 'wav' ? 'audio/wav' : 'audio/mpeg', extension: sourceFormat };
  }
}

export async function cdrRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: requirePermission('cdr.view') }, async (req) => {
    const query = listCdrQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { calls, count } = await fetchCdrCallsPage(supabase, orgId, extractFilters(query), query.page, query.page_size);
    const rows = await buildCdrRows(supabase, orgId, calls);

    return ok(rows, { pagination: paginationMeta(query.page, query.page_size, count) });
  });

  app.get('/search-transcript', { preHandler: requirePermission('cdr.view') }, async (req) => {
    const query = searchTranscriptQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const offset = (query.page - 1) * query.page_size;
    const { data, error } = await supabase.rpc('search_call_transcripts', {
      search_query: query.q,
      match_organization_id: orgId,
      match_count: query.page_size,
      match_offset: offset,
    });
    if (error) throw error;

    const results = (data ?? []) as Array<{ transcript_id: string; call_id: string; full_text: string; rank: number }>;
    return ok(
      results.map((r) => ({
        call_id: r.call_id,
        transcript_id: r.transcript_id,
        rank: r.rank,
        // A short snippet, not the full transcript - the client links
        // through to the call detail for the full view/segments.
        snippet: r.full_text.length > 300 ? `${r.full_text.slice(0, 300)}...` : r.full_text,
      })),
      { pagination: paginationMeta(query.page, query.page_size, results.length + offset) },
    );
  });

  app.post('/export', { preHandler: requirePermission('cdr.export') }, async (req) => {
    const body = createExportSchema.parse(req.body);
    const orgId = req.user!.organizationId;

    const exportRecord = await queueCdrExport(orgId, req.user!.id, body.type, extractFilters(body.filters as Record<string, unknown>));

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.CDR_EXPORT_CREATED,
      entityType: 'export',
      entityId: exportRecord.id,
      newValue: { type: body.type, filters: body.filters },
      ipAddress: req.ip,
    });

    return ok(exportRecord, { message: 'Export queued. Check its status via GET /api/v1/exports/:id.' });
  });

  app.get('/:callId', { preHandler: requirePermission('cdr.view') }, async (req) => {
    const { callId } = req.params as { callId: string };
    uuidSchema.parse(callId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: call, error } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
    if (error) throw error;
    if (!call || call.organization_id !== orgId) throw new NotFoundError('Call not found.');

    const [row] = await buildCdrRows(supabase, orgId, [call]);

    const [{ data: transcript }, { data: recording }, { data: summary }] = await Promise.all([
      supabase.from('call_transcripts').select('*').eq('call_id', callId).maybeSingle(),
      supabase.from('call_recordings').select('*').eq('call_id', callId).maybeSingle(),
      supabase.from('call_summaries').select('*').eq('call_id', callId).maybeSingle(),
    ]);

    let segments: Record<string, any>[] = [];
    if (transcript) {
      const { data } = await supabase
        .from('call_transcript_segments')
        .select('id, speaker, segment_index, start_ms, end_ms, text')
        .eq('transcript_id', transcript.id)
        .order('segment_index', { ascending: true });
      segments = data ?? [];
    }

    return ok({
      ...row,
      transcript: transcript ?? null,
      transcript_segments: segments,
      // The recording endpoint below is authenticated and org-checked -
      // in this local-disk-storage sandbox build there is no real signed-
      // URL mechanism (that needs production S3/Supabase Storage per
      // spec section 22 - see README's Phase 9 note), so the "playback
      // URL" is this API route itself rather than a bearer-token-free
      // signed link.
      recording: recording ? { ...recording, playback_url: recording.status === 'ready' ? `/api/v1/cdr/${callId}/recording/download` : null } : null,
      summary: summary ?? null,
    });
  });

  app.get('/:callId/recording/download', { preHandler: requirePermission('cdr.view') }, async (req, reply) => {
    const { callId } = req.params as { callId: string };
    uuidSchema.parse(callId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: call } = await supabase.from('calls').select('id, organization_id').eq('id', callId).maybeSingle();
    if (!call || call.organization_id !== orgId) throw new NotFoundError('Call not found.');

    const { data: recording } = await supabase.from('call_recordings').select('*').eq('call_id', callId).maybeSingle();
    if (!recording || recording.status !== 'ready' || !recording.storage_path) {
      throw new ValidationError('No recording is available for this call yet.');
    }

    const adapter = getStorageAdapter();
    let sourceBuffer: Buffer;
    try {
      sourceBuffer = await adapter.getObject(recording.storage_path);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        throw new NotFoundError('This recording is marked ready but its stored bytes could not be found.');
      }
      throw err;
    }
    const { buffer, contentType, extension } = await maybeTranscodeToMp3(sourceBuffer, recording.format ?? 'mp3');

    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `attachment; filename="call-${callId}.${extension}"`);
    return reply.send(buffer);
  });
}
