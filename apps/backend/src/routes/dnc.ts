import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { createDncEntrySchema, listDncQuerySchema } from '../schemas/dnc.js';
import { uuidSchema } from '../schemas/common.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import { flagExistingLeadsAsDnc } from '../lib/leadHelpers.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

/**
 * DNC (Do Not Call) management. Phase 2's permission catalog has no
 * dedicated `dnc.*` key, so this reuses `leads.view` (read) and
 * `leads.edit` (write) - the closest existing permissions - rather than
 * adding a new one mid-phase; a later phase can split this out if
 * compliance workflows need a separate permission.
 */
export async function dncRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: requirePermission('leads.view') }, async (req) => {
    const query = listDncQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    // Org-scoped entries plus global (organization_id null) entries.
    let builder = supabase
      .from('dnc_entries')
      .select('id, organization_id, phone_normalized, reason, source, created_by, created_at', { count: 'exact' })
      .or(`organization_id.eq.${orgId},organization_id.is.null`);
    if (query.search) {
      const digitsOnly = query.search.replace(/\D/g, '');
      builder = builder.ilike('phone_normalized', `%${digitsOnly || query.search}%`);
    }

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  app.post('/', { preHandler: requirePermission('leads.edit') }, async (req, reply) => {
    const body = createDncEntrySchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const normalized = normalizePhoneNumber(body.phone);
    if (!normalized.valid) throw new ValidationError(normalized.reason, { field: 'phone' });

    const { data: entry, error } = await supabase
      .from('dnc_entries')
      .insert({
        organization_id: orgId,
        phone_normalized: normalized.e164,
        reason: body.reason ?? null,
        source: body.source,
        created_by: req.user!.id,
      })
      .select('id, organization_id, phone_normalized, reason, source, created_by, created_at')
      .single();
    if (error) {
      if ((error as any).code === '23505') {
        throw new ConflictError('This phone number is already on the Do Not Call list.');
      }
      throw error;
    }

    const flagged = await flagExistingLeadsAsDnc(supabase, orgId, normalized.e164, body.reason ?? null);

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.DNC_ENTRY_ADDED,
      entityType: 'dnc_entry',
      entityId: entry.id,
      newValue: { phone: normalized.e164, source: body.source, leads_flagged: flagged },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok({ ...entry, leads_flagged: flagged }, { message: 'Added to Do Not Call list.' }));
  });

  app.delete('/:id', { preHandler: requirePermission('leads.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing, error: existingError } = await supabase
      .from('dnc_entries')
      .select('id, organization_id, phone_normalized')
      .eq('id', id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.organization_id !== orgId) {
      // Global entries (organization_id null) cannot be removed by a
      // single tenant's admin - only org-scoped entries are mutable here.
      throw new NotFoundError('Do Not Call entry not found.');
    }

    const { error } = await supabase.from('dnc_entries').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.DNC_ENTRY_REMOVED,
      entityType: 'dnc_entry',
      entityId: id,
      oldValue: { phone: existing.phone_normalized },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });
}
