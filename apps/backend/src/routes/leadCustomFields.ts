import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';
import { createLeadCustomFieldSchema } from '../schemas/leadCustomFields.js';
import { uuidSchema } from '../schemas/common.js';

/** Per-org catalog of custom field keys leads.custom_fields is allowed to
 * hold - used by the import column-mapping UI and by leads.custom_fields
 * validation. See supabase/migrations/00000000000013_lead_custom_fields.sql. */
export async function leadCustomFieldRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/', { preHandler: requirePermission('leads.view') }, async (req) => {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('lead_custom_fields')
      .select('id, organization_id, field_key, field_label, field_type, created_at')
      .eq('organization_id', req.user!.organizationId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return ok(data ?? []);
  });

  app.post('/', { preHandler: requirePermission('leads.edit') }, async (req, reply) => {
    const body = createLeadCustomFieldSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data, error } = await supabase
      .from('lead_custom_fields')
      .insert({
        organization_id: orgId,
        field_key: body.field_key,
        field_label: body.field_label,
        field_type: body.field_type,
      })
      .select('id, organization_id, field_key, field_label, field_type, created_at')
      .single();
    if (error) {
      if ((error as any).code === '23505') throw new ConflictError('A custom field with this key already exists.');
      throw error;
    }

    return reply.status(201).send(ok(data, { message: 'Custom field added.' }));
  });

  app.delete('/:id', { preHandler: requirePermission('leads.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing } = await supabase
      .from('lead_custom_fields')
      .select('id, organization_id')
      .eq('id', id)
      .maybeSingle();
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Custom field not found.');

    const { error } = await supabase.from('lead_custom_fields').delete().eq('id', id);
    if (error) throw error;
    return ok({ deleted: true });
  });
}
