/**
 * Call queue views (Queues and Inbound Routes pages):
 *
 * GET  /queues/summary           - what's waiting to be called and what's
 *                                  live: each campaign's outbound queue,
 *                                  due/upcoming callbacks, inbound calls.
 * GET  /queues/inbound-routes    - which campaign/agent answers each number
 *                                  and where calls go if the AI can't.
 * PATCH /queues/inbound-routes/:phoneNumberId - choose the campaign that
 *                                  answers a number's inbound calls.
 *
 * Read-only counts only (head: true) - no heavy aggregation, and nothing
 * here touches the dashboard's own queries or cache.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { ACTIVE_CALL_STATUSES } from '../services/campaignDispatcher.js';
import { configureInboundNumbers } from '../services/inboundCalls.js';

const updateRouteSchema = z.object({ assigned_campaign_id: uuidSchema.nullable() });

export async function queueRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/summary', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const nowIso = new Date().toISOString();
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const { data: campaigns } = await supabase
      .from('campaigns')
      .select('id, name, status, concurrency_limit')
      .eq('organization_id', orgId)
      .in('status', ['running', 'paused', 'scheduled'])
      .order('updated_at', { ascending: false });

    const outbound = await Promise.all(
      (campaigns ?? []).map(async (c: any) => {
        const [due, later, active] = await Promise.all([
          supabase
            .from('campaign_leads')
            .select('id', { count: 'exact', head: true })
            .eq('campaign_id', c.id)
            .in('status', ['pending', 'retry_pending'])
            .or(`next_eligible_at.is.null,next_eligible_at.lte.${nowIso}`),
          supabase.from('campaign_leads').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).in('status', ['pending', 'retry_pending']).gt('next_eligible_at', nowIso),
          supabase.from('calls').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('direction', 'outbound').in('status', ACTIVE_CALL_STATUSES),
        ]);
        return {
          campaign_id: c.id,
          name: c.name,
          status: c.status,
          concurrency_limit: c.concurrency_limit ?? null,
          waiting_now: due.count ?? 0,
          scheduled_later: later.count ?? 0,
          on_call: active.count ?? 0,
        };
      }),
    );

    const [dueCallbacks, upcomingCallbacks, inboundActive, inboundToday, answeringNumbers] = await Promise.all([
      supabase.from('callbacks').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).in('status', ['scheduled', 'pending']).lte('scheduled_at', nowIso),
      supabase
        .from('callbacks')
        .select('id, lead_id, campaign_id, phone_e164, scheduled_at, timezone, status, reason, assigned_to')
        .eq('organization_id', orgId)
        .in('status', ['scheduled', 'pending', 'calling'])
        .order('scheduled_at', { ascending: true })
        .limit(15),
      supabase.from('calls').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('direction', 'inbound').in('status', ACTIVE_CALL_STATUSES),
      supabase.from('calls').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('direction', 'inbound').gte('created_at', startOfDay.toISOString()),
      supabase.from('phone_numbers').select('id, vapi_phone_number_id').eq('organization_id', orgId).eq('status', 'active'),
    ]);

    const callbackRows = (upcomingCallbacks.data ?? []) as any[];
    const leadIds = [...new Set(callbackRows.map((c) => c.lead_id))];
    const { data: leads } = leadIds.length ? await supabase.from('leads').select('id, first_name, last_name').in('id', leadIds) : { data: [] as any[] };
    const leadName = new Map((leads ?? []).map((l: any) => [l.id, [l.first_name, l.last_name].filter(Boolean).join(' ').trim()]));
    const campaignName = new Map((campaigns ?? []).map((c: any) => [c.id, c.name]));

    return ok({
      outbound,
      callbacks: {
        due_now: dueCallbacks.count ?? 0,
        upcoming: callbackRows.map((c) => ({
          ...c,
          lead_name: leadName.get(c.lead_id) || null,
          campaign_name: c.campaign_id ? campaignName.get(c.campaign_id) ?? null : null,
        })),
      },
      inbound: {
        on_call: inboundActive.count ?? 0,
        today: inboundToday.count ?? 0,
        answering_numbers: (answeringNumbers.data ?? []).filter((n: any) => n.vapi_phone_number_id).length,
        total_numbers: (answeringNumbers.data ?? []).length,
      },
    });
  });

  app.get('/inbound-routes', { preHandler: requirePermission('campaigns.view') }, async (req) => {
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    // Four batched lookups for every number at once (was several queries
    // per number) - same routing rule as inboundCalls.campaignForNumber:
    // assigned campaign, else a running campaign dialing from the number,
    // else the most recently updated one dialing from it.
    const [{ data: numbers }, { data: campaigns }] = await Promise.all([
      supabase.from('phone_numbers').select('id, phone_number, friendly_name, provider_key, vapi_phone_number_id, assigned_campaign_id, created_at').eq('organization_id', orgId).eq('status', 'active').order('created_at', { ascending: true }),
      supabase.from('campaigns').select('id, name, status, current_version_id, transfer_number_e164, updated_at').eq('organization_id', orgId).order('updated_at', { ascending: false }),
    ]);
    const numberIds = (numbers ?? []).map((n: any) => n.id);
    const versionIds = (campaigns ?? []).map((c: any) => c.current_version_id).filter(Boolean);
    const [{ data: pool }, { data: versions }] = await Promise.all([
      numberIds.length ? supabase.from('campaign_phone_numbers').select('campaign_id, phone_number_id').in('phone_number_id', numberIds) : Promise.resolve({ data: [] as any[] }),
      versionIds.length ? supabase.from('campaign_versions').select('id, transfer_number_e164').in('id', versionIds) : Promise.resolve({ data: [] as any[] }),
    ]);

    const campaignById = new Map((campaigns ?? []).map((c: any) => [c.id, c]));
    const versionTransfer = new Map((versions ?? []).map((v: any) => [v.id, v.transfer_number_e164 as string | null]));
    const poolByNumber = new Map<string, any[]>();
    for (const row of pool ?? []) {
      const campaign = campaignById.get(row.campaign_id);
      if (!campaign) continue;
      const list = poolByNumber.get(row.phone_number_id) ?? [];
      list.push(campaign);
      poolByNumber.set(row.phone_number_id, list);
    }

    const routes = (numbers ?? []).map((pn: any) => {
      const assigned = pn.assigned_campaign_id ? campaignById.get(pn.assigned_campaign_id) : null;
      const dialing = [...(poolByNumber.get(pn.id) ?? [])].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      const campaign = assigned ?? dialing.find((c) => c.status === 'running') ?? dialing[0] ?? null;
      return {
        phone_number_id: pn.id,
        phone_number: pn.phone_number,
        friendly_name: pn.friendly_name ?? null,
        provider_key: pn.provider_key,
        answering: Boolean(pn.vapi_phone_number_id),
        assigned_campaign_id: pn.assigned_campaign_id ?? null,
        answered_by_campaign: campaign ? { id: campaign.id, name: campaign.name, status: campaign.status } : null,
        fallback_number: campaign ? (versionTransfer.get(campaign.current_version_id) ?? campaign.transfer_number_e164 ?? null) : null,
      };
    });
    return ok({ routes, campaigns: (campaigns ?? []).map((c: any) => ({ id: c.id, name: c.name, status: c.status })) });
  });

  app.patch('/inbound-routes/:phoneNumberId', { preHandler: requirePermission('numbers.manage') }, async (req) => {
    const { phoneNumberId } = req.params as { phoneNumberId: string };
    uuidSchema.parse(phoneNumberId);
    const body = updateRouteSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: pn } = await supabase.from('phone_numbers').select('id, organization_id').eq('id', phoneNumberId).maybeSingle();
    if (!pn || pn.organization_id !== orgId) throw new NotFoundError('Phone number not found.');
    if (body.assigned_campaign_id) {
      const { data: campaign } = await supabase.from('campaigns').select('id, organization_id').eq('id', body.assigned_campaign_id).maybeSingle();
      if (!campaign || campaign.organization_id !== orgId) throw new ValidationError('Campaign not found.');
    }
    const { error } = await supabase.from('phone_numbers').update({ assigned_campaign_id: body.assigned_campaign_id }).eq('id', phoneNumberId);
    if (error) throw error;
    // The fallback number follows the answering campaign's transfer number.
    void configureInboundNumbers(orgId).catch(() => undefined);
    return ok({ phone_number_id: phoneNumberId, assigned_campaign_id: body.assigned_campaign_id });
  });
}
