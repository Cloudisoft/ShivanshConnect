import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { createCallSchema, listCallsQuerySchema } from '../schemas/orchestration.js';
import { isValidNormalizedPhone, normalizePhoneNumber } from '../lib/phone.js';
import { originateCall, resolveDefaultEngine } from '../services/callOrigination.js';

const CALL_COLUMNS =
  'id, organization_id, engine, vapi_call_id, pipecat_call_id, ai_agent_id, ai_agent_version_id, campaign_id, lead_id, phone_number_id, direction, customer_number, status, started_at, answered_at, ended_at, duration_seconds, talk_duration_seconds, ended_reason, transfer_destination_e164, transfer_status, cost, created_by, created_at, updated_at';

export async function callRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/v1/calls
  app.get('/', { preHandler: requirePermission('calls.manage') }, async (req) => {
    const query = listCallsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('calls').select(CALL_COLUMNS, { count: 'exact' }).eq('organization_id', orgId);
    if (query.status) builder = builder.eq('status', query.status);
    if (query.engine) builder = builder.eq('engine', query.engine);
    if (query.ai_agent_id) builder = builder.eq('ai_agent_id', query.ai_agent_id);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data, error, count } = await builder;
    if (error) throw error;
    return ok(data ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // GET /api/v1/calls/:id
  app.get('/:id', { preHandler: requirePermission('calls.manage') }, async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: call, error } = await supabase.from('calls').select(CALL_COLUMNS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!call || call.organization_id !== orgId) throw new NotFoundError('Call not found.');

    const { data: events } = await supabase
      .from('call_events')
      .select('id, event_type, payload, occurred_at')
      .eq('call_id', id)
      .order('occurred_at', { ascending: true });

    return ok({ ...call, events: events ?? [] });
  });

  // POST /api/v1/calls - internal call-origination endpoint. This handler
  // resolves/authorizes the request; the actual origination logic lives
  // in services/callOrigination.ts's originateCall(), which is the SAME
  // function Phase 7's campaign dispatcher (services/campaignDispatcher.ts)
  // calls directly (not through HTTP) to place campaign-driven calls
  // against a campaign version's own snapshot rather than an agent's
  // live current_version_id.
  app.post('/', { preHandler: requirePermission('calls.manage') }, async (req) => {
    const body = createCallSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: agent, error: agentError } = await supabase.from('ai_agents').select('id, organization_id, current_version_id').eq('id', body.agent_id).maybeSingle();
    if (agentError) throw agentError;
    if (!agent || agent.organization_id !== orgId) throw new NotFoundError('Agent not found.');
    if (!agent.current_version_id) throw new ValidationError('This agent has no published version yet - publish one before placing calls.');

    const { data: version, error: versionError } = await supabase.from('ai_agent_versions').select('*').eq('id', agent.current_version_id).maybeSingle();
    if (versionError) throw versionError;
    if (!version) throw new NotFoundError('Published agent version not found.');

    const { data: phoneNumber, error: phoneError } = await supabase.from('phone_numbers').select('*').eq('id', body.phone_number_id).maybeSingle();
    if (phoneError) throw phoneError;
    if (!phoneNumber || phoneNumber.organization_id !== orgId) throw new NotFoundError('Phone number not found.');
    if (phoneNumber.status !== 'active') throw new ValidationError('This phone number is not active.');

    let customerNumber: string;
    let leadId: string | null = null;
    if (body.lead_id) {
      const { data: lead, error: leadError } = await supabase.from('leads').select('id, organization_id, phone_normalized, is_dnc').eq('id', body.lead_id).maybeSingle();
      if (leadError) throw leadError;
      if (!lead || lead.organization_id !== orgId) throw new NotFoundError('Lead not found.');
      if (lead.is_dnc) throw new ValidationError('This lead is on the Do Not Call list - calls cannot be placed to it.');
      customerNumber = lead.phone_normalized;
      leadId = lead.id;
    } else if (body.customer_number) {
      const normalized = normalizePhoneNumber(body.customer_number);
      if (!isValidNormalizedPhone(normalized)) throw new ValidationError('customer_number is not a valid phone number.');
      customerNumber = normalized.e164;
    } else {
      throw new ValidationError('Either lead_id or customer_number is required.');
    }

    const engine = body.engine ?? (await resolveDefaultEngine(supabase, orgId));

    const { call } = await originateCall({
      organizationId: orgId,
      engine,
      agent: { id: agent.id },
      version,
      phoneNumber,
      customerNumber,
      leadId,
      campaignId: null,
      createdBy: req.user!.id,
    });

    return ok(call, { message: 'Call placed.' });
  });
}
