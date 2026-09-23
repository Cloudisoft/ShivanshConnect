import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createScriptSchema, listScriptsQuerySchema, updateScriptSchema } from '../schemas/scripts.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, normalizePlaceholders, SCRIPT_TEMPLATES } from '@shivanshconnect/shared';
import { extractDocumentText, inferFileType } from '../services/extractDocumentText.js';

const SCRIPT_COLUMNS = 'id, organization_id, agent_id, campaign_id, name, content, version, source, created_by, created_at, updated_at';

export async function scriptRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('agents.manage'));

  // GET /api/v1/scripts?agent_id=&search=
  app.get('/', async (req) => {
    const query = listScriptsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('scripts').select(SCRIPT_COLUMNS, { count: 'exact' }).eq('organization_id', orgId);
    if (query.search) builder = builder.ilike('name', `%${query.search}%`);
    if (query.agent_id) builder = builder.eq('agent_id', query.agent_id);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data: scripts, error, count } = await builder;
    if (error) throw error;
    return ok(scripts ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // GET /api/v1/scripts/templates - the starter templates offered on create
  app.get('/templates', async () => ok(SCRIPT_TEMPLATES));

  // GET /api/v1/scripts/:id
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: script, error } = await supabase.from('scripts').select(SCRIPT_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!script || script.organization_id !== orgId) throw new NotFoundError('Script not found.');
    return ok(script);
  });

  // POST /api/v1/scripts - editor content, or template_key to clone a
  // starter template's content verbatim as an editable copy.
  app.post('/', async (req, reply) => {
    const body = createScriptSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let content = body.content;
    if (body.source === 'template') {
      const template = SCRIPT_TEMPLATES.find((t) => t.key === body.template_key);
      if (!template) throw new ValidationError('Unknown template_key.');
      content = template.content;
    }

    const { data: script, error } = await supabase
      .from('scripts')
      .insert({
        organization_id: orgId,
        agent_id: body.agent_id ?? null,
        name: body.name,
        content,
        version: 1,
        source: body.source,
        created_by: req.user!.id,
      })
      .select(SCRIPT_COLUMNS)
      .single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.SCRIPT_CREATED,
      entityType: 'script',
      entityId: script.id,
      newValue: { name: body.name, source: body.source },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok(script, { message: 'Script created.' }));
  });

  // POST /api/v1/scripts/upload - multipart upload, parsed the same way
  // as knowledge-base document ingestion (plain text/docx/pdf -> content).
  app.post('/upload', async (req, reply) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    if (!req.isMultipart()) {
      throw new ValidationError('Upload must be sent as multipart/form-data with a "file" field.');
    }
    const file = await req.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!file) throw new ValidationError('No file was uploaded.');

    const fileType = inferFileType(file.filename);
    if (!fileType || !['pdf', 'docx', 'txt', 'md'].includes(fileType)) {
      throw new ValidationError('Only .txt, .md, .docx and .pdf files are supported for script upload.');
    }

    const buffer = await file.toBuffer();
    if (buffer.length === 0) throw new ValidationError('The uploaded file is empty.');

    const extracted = await extractDocumentText(buffer, fileType);
    // Uploaded scripts commonly use whatever placeholder convention their
    // source system used ([First Name], <Phone Number>, %email%, ...) -
    // auto-convert the recognizable ones to this app's {{variable}} syntax
    // so the script is usable for calls without manual find-and-replace.
    const { text: content, replaced, unrecognized } = normalizePlaceholders(extracted);
    const nameField = (file.fields?.name as any)?.value as string | undefined;
    const name = (nameField && nameField.trim()) || file.filename.replace(/\.[^.]+$/, '');

    const { data: script, error } = await supabase
      .from('scripts')
      .insert({
        organization_id: orgId,
        name,
        content,
        version: 1,
        source: 'upload',
        created_by: req.user!.id,
      })
      .select(SCRIPT_COLUMNS)
      .single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.SCRIPT_CREATED,
      entityType: 'script',
      entityId: script.id,
      newValue: { name, source: 'upload', file_name: file.filename },
      ipAddress: req.ip,
    });

    let message = 'Script uploaded.';
    if (replaced.length > 0) message += ` Converted ${replaced.length} placeholder${replaced.length === 1 ? '' : 's'} to {{variable}} format.`;
    if (unrecognized.length > 0) message += ` ${unrecognized.length} placeholder-like value${unrecognized.length === 1 ? '' : 's'} could not be auto-mapped - review before use: ${unrecognized.join(', ')}.`;

    return reply.status(201).send(ok(script, { message }));
  });

  // PATCH /api/v1/scripts/:id
  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateScriptSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing, error: existingError } = await supabase.from('scripts').select(SCRIPT_COLUMNS).eq('id', id).maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Script not found.');

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.agent_id !== undefined) patch.agent_id = body.agent_id;
    if (body.content !== undefined) {
      patch.content = body.content;
      patch.version = existing.version + 1;
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('scripts').update(patch).eq('id', id);
      if (error) throw error;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.SCRIPT_UPDATED,
      entityType: 'script',
      entityId: id,
      oldValue: { content: existing.content, version: existing.version },
      newValue: patch,
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('scripts').select(SCRIPT_COLUMNS).eq('id', id).single();
    return ok(updated);
  });

  // DELETE /api/v1/scripts/:id
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing, error: existingError } = await supabase.from('scripts').select('id, organization_id, name').eq('id', id).maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Script not found.');

    const { error } = await supabase.from('scripts').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.SCRIPT_DELETED,
      entityType: 'script',
      entityId: id,
      oldValue: { name: existing.name },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });
}
