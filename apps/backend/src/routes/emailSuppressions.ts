import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { createEmailSuppressionSchema, listEmailSuppressionsQuerySchema } from '../schemas/emailSuppressions.js';
import { uuidSchema } from '../schemas/common.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

/**
 * Email opt-out management (spec section 60's "opt-out handling",
 * per-channel - see supabase/migrations/00000000000046's header for why
 * this is deliberately separate from dnc_entries). Gated on
 * `messaging.manage`, mirroring routes/dnc.ts's shape for the phone
 * equivalent.
 */
export async function emailSuppressionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('messaging.manage'));

  app.get('/', async (req) => {
    const query = listEmailSuppressionsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    let builder = supabase.from('email_suppressions').select('*', { count: 'exact' }).or(`organization_id.eq.${orgId},organization_id.is.null`);
    if (query.search) builder = builder.ilike('email', `%${query.search}%`);
    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);
    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  app.post('/', async (req, reply) => {
    const body = createEmailSuppressionSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const { data: entry, error } = await supabase
      .from('email_suppressions')
      .insert({ organization_id: orgId, email: body.email, reason: body.reason ?? null, source: 'manual', created_by: req.user!.id })
      .select('*')
      .single();
    if (error) {
      if ((error as any).code === '23505') throw new ConflictError('This email address has already opted out.');
      throw error;
    }
    await writeAuditLog({ organizationId: orgId, userId: req.user!.id, action: AUDIT_ACTIONS.EMAIL_CAMPAIGN_UPDATED, entityType: 'email_suppression', entityId: entry.id, newValue: { email: body.email }, ipAddress: req.ip });
    return reply.status(201).send(ok(entry, { message: 'Email address added to the opt-out list.' }));
  });

  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const { data: existing } = await supabase.from('email_suppressions').select('id, organization_id, email').eq('id', id).maybeSingle();
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Suppression entry not found.');
    const { error } = await supabase.from('email_suppressions').delete().eq('id', id);
    if (error) throw error;
    return ok({ deleted: true });
  });
}
