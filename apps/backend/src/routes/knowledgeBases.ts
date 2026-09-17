import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createKnowledgeBaseSchema } from '../schemas/knowledgeBases.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';
import { inferFileType } from '../services/extractDocumentText.js';
import { processKnowledgeDocument } from '../services/processKnowledgeDocument.js';

const KB_COLUMNS = 'id, organization_id, agent_id, campaign_id, name, created_at';
const DOC_COLUMNS =
  'id, knowledge_base_id, organization_id, file_name, file_type, storage_path, status, size_bytes, uploaded_by, created_at, processed_at, error_message';

async function getOwnedKnowledgeBase(supabase: ReturnType<typeof getSupabaseAdmin>, id: string, orgId: string) {
  const { data: kb, error } = await supabase.from('knowledge_bases').select(KB_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!kb || kb.organization_id !== orgId) throw new NotFoundError('Knowledge base not found.');
  return kb;
}

export async function knowledgeBaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('agents.manage'));

  // GET /api/v1/knowledge-bases?agent_id=
  app.get('/', async (req) => {
    const query = req.query as { agent_id?: string };
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('knowledge_bases').select(KB_COLUMNS).eq('organization_id', orgId);
    if (query.agent_id) builder = builder.eq('agent_id', query.agent_id);
    builder = builder.order('created_at', { ascending: false });

    const { data, error } = await builder;
    if (error) throw error;
    return ok(data ?? []);
  });

  // GET /api/v1/knowledge-bases/:id
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const kb = await getOwnedKnowledgeBase(supabase, id, req.user!.organizationId);
    return ok(kb);
  });

  // POST /api/v1/knowledge-bases - scoped to an agent (agent_id optional
  // for a future campaign-level KB in Phase 7, per the schema's nullable
  // campaign_id)
  app.post('/', async (req, reply) => {
    const body = createKnowledgeBaseSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    if (body.agent_id) {
      const { data: agent } = await supabase.from('ai_agents').select('id, organization_id').eq('id', body.agent_id).maybeSingle();
      if (!agent || agent.organization_id !== orgId) throw new NotFoundError('Agent not found.');
    }

    const { data: kb, error } = await supabase
      .from('knowledge_bases')
      .insert({ organization_id: orgId, agent_id: body.agent_id ?? null, name: body.name })
      .select(KB_COLUMNS)
      .single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.KNOWLEDGE_BASE_CREATED,
      entityType: 'knowledge_base',
      entityId: kb.id,
      newValue: { name: body.name, agent_id: body.agent_id ?? null },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok(kb, { message: 'Knowledge base created.' }));
  });

  // GET /api/v1/knowledge-bases/:id/documents
  app.get('/:id/documents', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedKnowledgeBase(supabase, id, orgId);

    const { data: docs, error } = await supabase
      .from('knowledge_documents')
      .select(DOC_COLUMNS)
      .eq('knowledge_base_id', id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return ok(docs ?? []);
  });

  // POST /api/v1/knowledge-bases/:id/documents - multipart upload.
  // Creates a knowledge_documents row (status=uploaded) then hands off to
  // services/processKnowledgeDocument.ts asynchronously via setImmediate,
  // same pattern as Phase 2's lead import (see that service's header
  // comment) - this request returns immediately.
  app.post('/:id/documents', async (req, reply) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedKnowledgeBase(supabase, id, orgId);

    if (!req.isMultipart()) {
      throw new ValidationError('Upload must be sent as multipart/form-data with a "file" field.');
    }
    const file = await req.file({ limits: { fileSize: 25 * 1024 * 1024 } });
    if (!file) throw new ValidationError('No file was uploaded.');

    const fileType = inferFileType(file.filename);
    if (!fileType) {
      throw new ValidationError('Only .pdf, .docx, .txt, .csv and .md files are supported.');
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) throw new ValidationError('The uploaded file is empty.');

    const { data: doc, error } = await supabase
      .from('knowledge_documents')
      .insert({
        knowledge_base_id: id,
        organization_id: orgId,
        file_name: file.filename,
        file_type: fileType,
        storage_path: `memory:${orgId}/${id}/${file.filename}`,
        status: 'uploaded',
        size_bytes: buffer.length,
        uploaded_by: req.user!.id,
      })
      .select(DOC_COLUMNS)
      .single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.KNOWLEDGE_DOCUMENT_UPLOADED,
      entityType: 'knowledge_document',
      entityId: doc.id,
      newValue: { file_name: file.filename, file_type: fileType },
      ipAddress: req.ip,
    });

    setImmediate(() => {
      processKnowledgeDocument(doc.id, buffer).catch((err) => {
        req.log.error({ err, documentId: doc.id }, 'Knowledge document processing failed');
      });
    });

    return reply.status(202).send(ok(doc, { message: 'Upload received. Processing started.' }));
  });

  // DELETE /api/v1/knowledge-bases/:id/documents/:docId
  app.delete('/:id/documents/:docId', async (req) => {
    const { id, docId } = req.params as { id: string; docId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(docId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedKnowledgeBase(supabase, id, orgId);

    const { data: doc, error: docError } = await supabase
      .from('knowledge_documents')
      .select('id, organization_id, knowledge_base_id, file_name')
      .eq('id', docId)
      .maybeSingle();
    if (docError) throw docError;
    if (!doc || doc.organization_id !== orgId || doc.knowledge_base_id !== id) {
      throw new NotFoundError('Document not found.');
    }

    await supabase.from('knowledge_chunks').delete().eq('document_id', docId);
    const { error } = await supabase.from('knowledge_documents').delete().eq('id', docId);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.KNOWLEDGE_DOCUMENT_DELETED,
      entityType: 'knowledge_document',
      entityId: docId,
      oldValue: { file_name: doc.file_name },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });

  // POST /api/v1/knowledge-bases/:id/documents/:docId/reprocess - Phase 3
  // has no real object storage (see storage_path's synthetic locator, same
  // pattern as Phase 2's import_jobs.file_storage_path), so there is no
  // original file bytes to re-read; reprocessing therefore requires the
  // original file to be re-uploaded (this endpoint resets status to
  // 'uploaded' and clears the error so the frontend can prompt for a
  // fresh upload) - never fabricates chunks from nothing.
  app.post('/:id/documents/:docId/reprocess', async (req) => {
    const { id, docId } = req.params as { id: string; docId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(docId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedKnowledgeBase(supabase, id, orgId);

    const { data: doc, error: docError } = await supabase
      .from('knowledge_documents')
      .select(DOC_COLUMNS)
      .eq('id', docId)
      .maybeSingle();
    if (docError) throw docError;
    if (!doc || doc.organization_id !== orgId || doc.knowledge_base_id !== id) {
      throw new NotFoundError('Document not found.');
    }

    await supabase
      .from('knowledge_documents')
      .update({ status: 'uploaded', error_message: null, processed_at: null })
      .eq('id', docId);

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.KNOWLEDGE_DOCUMENT_REPROCESSED,
      entityType: 'knowledge_document',
      entityId: docId,
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('knowledge_documents').select(DOC_COLUMNS).eq('id', docId).single();
    return ok(updated, { message: 'Marked for reprocessing. Re-upload the file to regenerate its chunks.' });
  });
}
