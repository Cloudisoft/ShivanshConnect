import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/errors.js';
import {
  bulkAddLeadsSchema,
  createLeadSchema,
  leadBulkActionSchema,
  listLeadsQuerySchema,
  updateLeadSchema,
} from '../schemas/leads.js';
import { uuidSchema } from '../schemas/common.js';
import { normalizePhoneNumber } from '../lib/phone.js';
import { findDncMatches, findExistingLeadPhones, isOnDncList } from '../lib/leadHelpers.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';

const LEAD_COLUMNS =
  'id, organization_id, lead_list_id, first_name, last_name, company, phone_original, phone_normalized, country_code, email, address, city, state, zip, country, status, attempts, last_called_at, last_disposition, next_callback_at, is_dnc, dnc_reason, custom_fields, created_at, updated_at';

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // ---------------------------------------------------------------
  // GET /api/v1/leads - paginated, filterable, sortable. Real
  // server-side pagination - never loads more than page_size rows.
  // ---------------------------------------------------------------
  app.get('/', { preHandler: requirePermission('leads.view') }, async (req) => {
    const query = listLeadsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('leads').select(LEAD_COLUMNS, { count: 'exact' }).eq('organization_id', orgId);
    if (query.lead_list_id) builder = builder.eq('lead_list_id', query.lead_list_id);
    if (query.status) builder = builder.eq('status', query.status);
    if (query.is_dnc !== undefined) builder = builder.eq('is_dnc', query.is_dnc);
    if (query.search) {
      const digitsOnly = query.search.replace(/\D/g, '');
      const term = digitsOnly.length >= 3 ? digitsOnly : query.search;
      builder = builder.or(
        `first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone_normalized.ilike.%${term}%,email.ilike.%${term}%`,
      );
    }

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order(query.sort_by, { ascending: query.sort_dir === 'asc' }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;

    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // ---------------------------------------------------------------
  // GET /api/v1/leads/:id
  // ---------------------------------------------------------------
  app.get('/:id', { preHandler: requirePermission('leads.view') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();

    const { data: lead, error } = await supabase.from('leads').select(LEAD_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!lead || lead.organization_id !== req.user!.organizationId) {
      throw new NotFoundError('Lead not found.');
    }

    const { data: memberships } = await supabase
      .from('lead_list_members')
      .select('lead_list_id, lead_lists(id, name)')
      .eq('lead_id', id);

    const lists = (memberships ?? []).map((m: any) => m.lead_lists).filter(Boolean);

    return ok({ ...lead, lists });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/leads - add a single lead
  // ---------------------------------------------------------------
  app.post('/', { preHandler: requirePermission('leads.create') }, async (req, reply) => {
    const body = createLeadSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const normalized = normalizePhoneNumber(body.phone);
    if (!normalized.valid) {
      throw new ValidationError(normalized.reason, { field: 'phone' });
    }

    const [dnc, existing] = await Promise.all([
      isOnDncList(supabase, orgId, normalized.e164),
      findExistingLeadPhones(supabase, orgId, [normalized.e164]),
    ]);
    if (existing.has(normalized.e164)) {
      throw new ValidationError('A lead with this phone number already exists in your organization.', {
        field: 'phone',
        code: 'DUPLICATE_PHONE',
      });
    }

    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        organization_id: orgId,
        lead_list_id: body.lead_list_id ?? null,
        first_name: body.first_name ?? '',
        last_name: body.last_name ?? '',
        company: body.company ?? null,
        phone_original: body.phone,
        phone_normalized: normalized.e164,
        country_code: normalized.countryCode,
        email: body.email ?? null,
        address: body.address ?? null,
        city: body.city ?? null,
        state: body.state ?? null,
        zip: body.zip ?? null,
        country: body.country ?? 'US',
        custom_fields: body.custom_fields ?? {},
        is_dnc: dnc,
        dnc_reason: dnc ? 'Phone number is on the Do Not Call list.' : null,
        status: dnc ? 'DNC' : 'NEW',
      })
      .select(LEAD_COLUMNS)
      .single();
    if (error) throw error;

    if (body.lead_list_id) {
      await supabase
        .from('lead_list_members')
        .insert({ lead_id: lead.id, lead_list_id: body.lead_list_id, organization_id: orgId });
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_CREATED,
      entityType: 'lead',
      entityId: lead.id,
      newValue: { phone: normalized.e164 },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok(lead, { message: 'Lead added.' }));
  });

  // ---------------------------------------------------------------
  // POST /api/v1/leads/bulk - paste-numbers / small bulk add
  // ---------------------------------------------------------------
  app.post('/bulk', { preHandler: requirePermission('leads.create') }, async (req) => {
    const body = bulkAddLeadsSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const entries = body.numbers ?? (body.raw_text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

    type ParsedEntry = {
      input: string;
      first_name: string;
      last_name: string;
      phone: string;
    };
    const parsedEntries: ParsedEntry[] = entries.map((line) => {
      const parts = line.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
      if (parts.length >= 3) {
        return { input: line, first_name: parts[0], last_name: parts[1], phone: parts.slice(2).join(',') };
      }
      if (parts.length === 2) {
        return { input: line, first_name: parts[0], last_name: '', phone: parts[1] };
      }
      return { input: line, first_name: '', last_name: '', phone: parts[0] ?? line };
    });

    const normalizedResults = parsedEntries.map((entry) => ({
      entry,
      normalized: normalizePhoneNumber(entry.phone),
    }));
    const candidatePhones = normalizedResults
      .filter((r) => r.normalized.valid)
      .map((r) => (r.normalized as any).e164 as string);

    const [dncPhones, existingPhones] = await Promise.all([
      findDncMatches(supabase, orgId, candidatePhones),
      findExistingLeadPhones(supabase, orgId, candidatePhones),
    ]);

    const seen = new Set<string>();
    const results: Array<{
      input: string;
      status: 'added' | 'duplicate' | 'invalid' | 'dnc';
      reason?: string;
      lead_id?: string;
    }> = [];
    const toInsert: Array<{ entry: ParsedEntry; e164: string; countryCode: string }> = [];

    for (const { entry, normalized } of normalizedResults) {
      if (!normalized.valid) {
        results.push({ input: entry.input, status: 'invalid', reason: normalized.reason });
        continue;
      }
      const e164 = normalized.e164;
      if (dncPhones.has(e164)) {
        results.push({ input: entry.input, status: 'dnc', reason: 'On the Do Not Call list.' });
        continue;
      }
      if (existingPhones.has(e164) || seen.has(e164)) {
        results.push({ input: entry.input, status: 'duplicate', reason: 'Already exists.' });
        continue;
      }
      seen.add(e164);
      toInsert.push({ entry, e164, countryCode: normalized.countryCode });
      results.push({ input: entry.input, status: 'added' });
    }

    if (toInsert.length > 0) {
      const { data: inserted, error } = await supabase
        .from('leads')
        .insert(
          toInsert.map(({ entry, e164, countryCode }) => ({
            organization_id: orgId,
            lead_list_id: body.lead_list_id ?? null,
            first_name: entry.first_name,
            last_name: entry.last_name,
            phone_original: entry.phone,
            phone_normalized: e164,
            country_code: countryCode,
            status: 'NEW',
          })),
        )
        .select('id, phone_normalized');
      if (error) throw error;

      const byPhone = new Map((inserted ?? []).map((l: any) => [l.phone_normalized, l.id]));
      for (const r of results) {
        if (r.status !== 'added') continue;
        const match = toInsert.find((t) => t.entry.input === r.input);
        if (match) r.lead_id = byPhone.get(match.e164);
      }

      if (body.lead_list_id && inserted && inserted.length > 0) {
        await supabase.from('lead_list_members').insert(
          inserted.map((l: any) => ({ lead_id: l.id, lead_list_id: body.lead_list_id, organization_id: orgId })),
        );
      }

      await writeAuditLog({
        organizationId: orgId,
        userId: req.user!.id,
        action: AUDIT_ACTIONS.LEAD_CREATED,
        entityType: 'lead',
        entityId: null,
        newValue: { bulk_added: inserted?.length ?? 0 },
        ipAddress: req.ip,
      });
    }

    return ok({
      total: results.length,
      added: results.filter((r) => r.status === 'added').length,
      duplicate: results.filter((r) => r.status === 'duplicate').length,
      invalid: results.filter((r) => r.status === 'invalid').length,
      dnc: results.filter((r) => r.status === 'dnc').length,
      results,
    });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/leads/bulk-actions - delete / move / assign, by
  // explicit id array or by filter ("select all matching").
  // ---------------------------------------------------------------
  app.post('/bulk-actions', async (req) => {
    const body = leadBulkActionSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    if (body.action === 'delete' && !req.user!.permissions.includes('leads.delete')) {
      throw new ForbiddenError('You need the "leads.delete" permission to do that.');
    }
    if (body.action !== 'delete' && !req.user!.permissions.includes('leads.edit')) {
      throw new ForbiddenError('You need the "leads.edit" permission to do that.');
    }

    if (body.lead_list_id) {
      const { data: list } = await supabase
        .from('lead_lists')
        .select('id, organization_id')
        .eq('id', body.lead_list_id)
        .maybeSingle();
      if (!list || list.organization_id !== orgId) {
        throw new ValidationError('That lead list does not exist for your organization.');
      }
    }

    // Resolve the target lead ids, in bounded batches even for a
    // filter-driven "select all matching" selection - the frontend never
    // has to enumerate ids itself.
    const ids = await resolveLeadIds(supabase, orgId, body);

    let affected = 0;
    if (body.action === 'delete') {
      affected = await deleteLeadsByIds(supabase, orgId, ids);
    } else {
      affected = await addLeadsToList(supabase, orgId, ids, body.lead_list_id!, body.action === 'move_to_list');
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_BULK_ACTION,
      entityType: 'lead',
      entityId: null,
      newValue: { action: body.action, affected, lead_list_id: body.lead_list_id ?? null },
      ipAddress: req.ip,
    });

    return ok({ action: body.action, affected });
  });

  // ---------------------------------------------------------------
  // PATCH /api/v1/leads/:id
  // ---------------------------------------------------------------
  app.patch('/:id', { preHandler: requirePermission('leads.edit') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateLeadSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing, error: existingError } = await supabase
      .from('leads')
      .select(LEAD_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Lead not found.');

    const patch: Record<string, unknown> = {};
    for (const key of [
      'first_name',
      'last_name',
      'company',
      'email',
      'address',
      'city',
      'state',
      'zip',
      'country',
      'status',
      'next_callback_at',
      'last_disposition',
      'custom_fields',
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }

    if (body.phone !== undefined) {
      const normalized = normalizePhoneNumber(body.phone);
      if (!normalized.valid) throw new ValidationError(normalized.reason, { field: 'phone' });
      if (normalized.e164 !== existing.phone_normalized) {
        const existingPhones = await findExistingLeadPhones(supabase, orgId, [normalized.e164]);
        if (existingPhones.has(normalized.e164)) {
          throw new ValidationError('Another lead already uses this phone number.', { field: 'phone' });
        }
      }
      patch.phone_original = body.phone;
      patch.phone_normalized = normalized.e164;
      patch.country_code = normalized.countryCode;
    }

    if (body.lead_list_id !== undefined) {
      patch.lead_list_id = body.lead_list_id;
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('leads').update(patch).eq('id', id);
      if (error) throw error;
    }

    if (body.lead_list_id !== undefined) {
      await supabase.from('lead_list_members').delete().eq('lead_id', id);
      if (body.lead_list_id) {
        await supabase
          .from('lead_list_members')
          .insert({ lead_id: id, lead_list_id: body.lead_list_id, organization_id: orgId });
      }
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_UPDATED,
      entityType: 'lead',
      entityId: id,
      oldValue: existing,
      newValue: patch,
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('leads').select(LEAD_COLUMNS).eq('id', id).single();
    return ok(updated);
  });

  // ---------------------------------------------------------------
  // DELETE /api/v1/leads/:id
  // ---------------------------------------------------------------
  app.delete('/:id', { preHandler: requirePermission('leads.delete') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: existing, error: existingError } = await supabase
      .from('leads')
      .select('id, organization_id')
      .eq('id', id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (!existing || existing.organization_id !== orgId) throw new NotFoundError('Lead not found.');

    await supabase.from('lead_list_members').delete().eq('lead_id', id);
    const { error } = await supabase.from('leads').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.LEAD_DELETED,
      entityType: 'lead',
      entityId: id,
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });
}

// -----------------------------------------------------------------
// Bulk-action helpers
// -----------------------------------------------------------------

export async function resolveLeadIds(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  body: { lead_ids?: string[]; filter?: Record<string, unknown> },
): Promise<string[]> {
  if (body.lead_ids) return body.lead_ids;

  const filter = body.filter ?? {};
  const PAGE = 1000;
  const ids: string[] = [];
  let page = 0;
  // Bounded batched fetch of matching ids only (never full rows), so a
  // 10k+ lead "select all matching filter" selection stays memory-safe
  // without the frontend ever enumerating ids itself.
  // A hard cap keeps a single bulk action from running away.
  const MAX_IDS = 50000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = supabase.from('leads').select('id').eq('organization_id', orgId);
    if (filter.lead_list_id) q = q.eq('lead_list_id', filter.lead_list_id as string);
    if (filter.status) q = q.eq('status', filter.status as string);
    if (filter.is_dnc !== undefined) q = q.eq('is_dnc', filter.is_dnc as boolean);
    if (filter.search) {
      const term = filter.search as string;
      q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone_normalized.ilike.%${term}%`);
    }
    q = q.order('id', { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1);

    const { data, error } = await q;
    if (error) throw error;
    const batch = (data ?? []).map((r: any) => r.id as string);
    ids.push(...batch);
    if (batch.length < PAGE || ids.length >= MAX_IDS) break;
    page += 1;
  }
  return ids;
}

async function deleteLeadsByIds(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  let affected = 0;
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await supabase.from('lead_list_members').delete().in('lead_id', batch);
    const { data, error } = await supabase
      .from('leads')
      .delete()
      .eq('organization_id', orgId)
      .in('id', batch)
      .select('id');
    if (error) throw error;
    affected += (data ?? []).length;
  }
  return affected;
}

async function addLeadsToList(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  ids: string[],
  leadListId: string,
  setPrimary: boolean,
): Promise<number> {
  if (ids.length === 0) return 0;
  let affected = 0;
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);

    if (setPrimary) {
      const { error } = await supabase
        .from('leads')
        .update({ lead_list_id: leadListId })
        .eq('organization_id', orgId)
        .in('id', batch);
      if (error) throw error;
    }

    const { data: existingMembers } = await supabase
      .from('lead_list_members')
      .select('lead_id')
      .eq('lead_list_id', leadListId)
      .in('lead_id', batch);
    const already = new Set((existingMembers ?? []).map((m: any) => m.lead_id));
    const toAdd = batch.filter((id) => !already.has(id));

    if (toAdd.length > 0) {
      const { error } = await supabase
        .from('lead_list_members')
        .insert(toAdd.map((leadId) => ({ lead_id: leadId, lead_list_id: leadListId, organization_id: orgId })));
      if (error) throw error;
    }
    affected += batch.length;
  }
  return affected;
}
