import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok, paginationMeta } from '../lib/response.js';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import {
  agentPreviewRequestSchema,
  createAgentSchema,
  createAgentVersionSchema,
  knowledgeSearchRequestSchema,
  listAgentsQuerySchema,
  updateAgentSchema,
  updateAgentVersionSchema,
} from '../schemas/agents.js';
import { evaluationSummaryQuerySchema, listAgentImprovementsQuerySchema } from '../schemas/agentImprovements.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS, DEFAULT_AGENT_PERSONALITY, DEFAULT_CALL_ENDING_RULES, DEFAULT_TRANSFER_RULES } from '@shivanshconnect/shared';
import { getLlmProvider, LlmNotConfiguredError } from '../lib/llm/index.js';
import { renderTemplate } from '../lib/promptVariables.js';
import { buildAssistantConfig, getOrgVapiProvider } from '../services/callOrigination.js';

const AGENT_COLUMNS = 'id, organization_id, name, description, role, status, current_version_id, created_by, created_at, updated_at';
const VERSION_COLUMNS =
  'id, agent_id, organization_id, version_number, personality, language, accent, greeting_template, system_prompt, fallback_behavior, transfer_rules, call_ending_rules, llm_provider, llm_model, llm_temperature, llm_max_tokens, voice_id, status, published_at, vapi_assistant_id, created_by, created_at';

async function getOwnedAgent(supabase: ReturnType<typeof getSupabaseAdmin>, id: string, orgId: string) {
  const { data: agent, error } = await supabase.from('ai_agents').select(AGENT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!agent || agent.organization_id !== orgId) throw new NotFoundError('Agent not found.');
  return agent;
}

async function getOwnedVersion(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  agentId: string,
  versionId: string,
  orgId: string,
) {
  const { data: version, error } = await supabase
    .from('ai_agent_versions')
    .select(VERSION_COLUMNS)
    .eq('id', versionId)
    .maybeSingle();
  if (error) throw error;
  if (!version || version.organization_id !== orgId || version.agent_id !== agentId) {
    throw new NotFoundError('Agent version not found.');
  }
  return version;
}

/** Creates a new DRAFT version for an agent, copying every field from
 * `source` except any keys present in `overrides`. Used by both
 * POST /:id/versions/:versionId/restore (no overrides - an exact copy)
 * and Phase 11's POST /agent-improvements/:id/apply (overrides the
 * relevant prompt field) - the ONE place a new agent_versions row is
 * actually inserted from an existing version, so every "create a draft
 * from this config" path (restore, apply-improvement) shares the exact
 * same version-numbering and field-copy logic. Never marks the result
 * anything but 'draft' - publishing is always a separate, explicit human
 * action (POST /:id/versions/:versionId/publish).
 */
export async function createDraftVersionFromSource(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  agentId: string,
  orgId: string,
  source: Record<string, any>,
  createdBy: string | null,
  overrides: Record<string, unknown> = {},
) {
  const { data: existingVersions } = await supabase
    .from('ai_agent_versions')
    .select('version_number')
    .eq('agent_id', agentId)
    .order('version_number', { ascending: false });
  const nextVersionNumber = ((existingVersions ?? [])[0]?.version_number ?? 0) + 1;

  const { data: created, error } = await supabase
    .from('ai_agent_versions')
    .insert({
      agent_id: agentId,
      organization_id: orgId,
      version_number: nextVersionNumber,
      personality: source.personality,
      language: source.language,
      accent: source.accent,
      greeting_template: source.greeting_template,
      system_prompt: source.system_prompt,
      fallback_behavior: source.fallback_behavior,
      transfer_rules: source.transfer_rules,
      call_ending_rules: source.call_ending_rules,
      llm_provider: source.llm_provider,
      llm_model: source.llm_model,
      llm_temperature: source.llm_temperature,
      llm_max_tokens: source.llm_max_tokens,
      voice_id: source.voice_id,
      status: 'draft',
      created_by: createdBy,
      ...overrides,
    })
    .select(VERSION_COLUMNS)
    .single();
  if (error) throw error;
  return { version: created, versionNumber: nextVersionNumber };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('agents.manage'));

  // ---------------------------------------------------------------
  // GET /api/v1/agents
  // ---------------------------------------------------------------
  app.get('/', async (req) => {
    const query = listAgentsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    let builder = supabase.from('ai_agents').select(AGENT_COLUMNS, { count: 'exact' }).eq('organization_id', orgId);
    if (query.search) builder = builder.ilike('name', `%${query.search}%`);
    if (query.status) builder = builder.eq('status', query.status);

    const from = (query.page - 1) * query.page_size;
    const to = from + query.page_size - 1;
    builder = builder.order('created_at', { ascending: false }).range(from, to);

    const { data: agents, error, count } = await builder;
    if (error) throw error;

    return ok(agents ?? [], { pagination: paginationMeta(query.page, query.page_size, count ?? 0) });
  });

  // ---------------------------------------------------------------
  // GET /api/v1/agents/:id - agent + its current (published) version
  // ---------------------------------------------------------------
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const agent = await getOwnedAgent(supabase, id, req.user!.organizationId);

    let currentVersion = null;
    if (agent.current_version_id) {
      const { data } = await supabase
        .from('ai_agent_versions')
        .select(VERSION_COLUMNS)
        .eq('id', agent.current_version_id)
        .maybeSingle();
      currentVersion = data ?? null;
    }

    return ok({ ...agent, current_version: currentVersion });
  });

  // ---------------------------------------------------------------
  // POST /api/v1/agents
  // ---------------------------------------------------------------
  app.post('/', { preHandler: requirePermission('agents.manage') }, async (req, reply) => {
    const body = createAgentSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const { data: agent, error } = await supabase
      .from('ai_agents')
      .insert({
        organization_id: orgId,
        name: body.name,
        description: body.description ?? null,
        role: body.role,
        status: 'draft',
        created_by: req.user!.id,
      })
      .select(AGENT_COLUMNS)
      .single();
    if (error) {
      if ((error as any).code === '23505') throw new ConflictError('An agent with this name already exists.');
      throw error;
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_CREATED,
      entityType: 'ai_agent',
      entityId: agent.id,
      newValue: { name: body.name, role: body.role },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok({ ...agent, current_version: null }, { message: 'Agent created.' }));
  });

  // ---------------------------------------------------------------
  // PATCH /api/v1/agents/:id
  // ---------------------------------------------------------------
  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateAgentSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const existing = await getOwnedAgent(supabase, id, orgId);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.description !== undefined) patch.description = body.description;
    if (body.role !== undefined) patch.role = body.role;
    if (body.status !== undefined) {
      if (body.status === 'active' && !existing.current_version_id) {
        throw new ValidationError('Publish a version before activating this agent.');
      }
      patch.status = body.status;
    }

    if (Object.keys(patch).length > 0) {
      const { error } = await supabase.from('ai_agents').update(patch).eq('id', id);
      if (error) {
        if ((error as any).code === '23505') throw new ConflictError('An agent with this name already exists.');
        throw error;
      }
    }

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_UPDATED,
      entityType: 'ai_agent',
      entityId: id,
      oldValue: existing,
      newValue: patch,
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('ai_agents').select(AGENT_COLUMNS).eq('id', id).single();
    return ok(updated);
  });

  // ---------------------------------------------------------------
  // DELETE /api/v1/agents/:id
  // ---------------------------------------------------------------
  app.delete('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const existing = await getOwnedAgent(supabase, id, orgId);

    const { error } = await supabase.from('ai_agents').delete().eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_DELETED,
      entityType: 'ai_agent',
      entityId: id,
      oldValue: { name: existing.name },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });

  // =================================================================
  // Versions
  // =================================================================

  // GET /api/v1/agents/:id/versions - list, newest first
  app.get('/:id/versions', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);

    const { data: versions, error } = await supabase
      .from('ai_agent_versions')
      .select(VERSION_COLUMNS)
      .eq('agent_id', id)
      .order('version_number', { ascending: false });
    if (error) throw error;
    return ok(versions ?? []);
  });

  // GET /api/v1/agents/:id/versions/:versionId
  app.get('/:id/versions/:versionId', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(versionId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);
    const version = await getOwnedVersion(supabase, id, versionId, orgId);
    return ok(version);
  });

  // POST /api/v1/agents/:id/versions - create a new draft version
  app.post('/:id/versions', async (req, reply) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = createAgentVersionSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);

    const { data: existingVersions } = await supabase
      .from('ai_agent_versions')
      .select('version_number')
      .eq('agent_id', id)
      .order('version_number', { ascending: false });
    const nextVersionNumber = ((existingVersions ?? [])[0]?.version_number ?? 0) + 1;

    const { data: version, error } = await supabase
      .from('ai_agent_versions')
      .insert({
        agent_id: id,
        organization_id: orgId,
        version_number: nextVersionNumber,
        personality: body.personality ?? DEFAULT_AGENT_PERSONALITY,
        language: body.language ?? 'en-US',
        accent: body.accent ?? null,
        greeting_template: body.greeting_template ?? '',
        system_prompt: body.system_prompt ?? '',
        fallback_behavior: body.fallback_behavior ?? null,
        transfer_rules: body.transfer_rules ?? DEFAULT_TRANSFER_RULES,
        call_ending_rules: body.call_ending_rules ?? DEFAULT_CALL_ENDING_RULES,
        llm_provider: body.llm_provider ?? 'openai',
        llm_model: body.llm_model ?? 'gpt-4o-mini',
        llm_temperature: body.llm_temperature ?? 0.7,
        llm_max_tokens: body.llm_max_tokens ?? 800,
        voice_id: body.voice_id ?? null,
        status: 'draft',
        created_by: req.user!.id,
      })
      .select(VERSION_COLUMNS)
      .single();
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_VERSION_CREATED,
      entityType: 'ai_agent_version',
      entityId: version.id,
      newValue: { agent_id: id, version_number: nextVersionNumber },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok(version, { message: 'Draft version created.' }));
  });

  // PATCH /api/v1/agents/:id/versions/:versionId - edit a draft (never a
  // published/archived version - those are immutable history)
  app.patch('/:id/versions/:versionId', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(versionId);
    const body = updateAgentVersionSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);
    const existing = await getOwnedVersion(supabase, id, versionId, orgId);

    if (existing.status !== 'draft') {
      throw new ValidationError('Only a draft version can be edited. Publish creates history; restore a version to edit it again.');
    }

    const patch: Record<string, unknown> = { ...body };

    const { error } = await supabase.from('ai_agent_versions').update(patch).eq('id', versionId);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_VERSION_UPDATED,
      entityType: 'ai_agent_version',
      entityId: versionId,
      oldValue: existing,
      newValue: patch,
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('ai_agent_versions').select(VERSION_COLUMNS).eq('id', versionId).single();
    return ok(updated);
  });

  // DELETE /api/v1/agents/:id/versions/:versionId - draft/archived history
  // only; the published version is the live one and must be replaced via
  // publish, never deleted out from under a running agent.
  app.delete('/:id/versions/:versionId', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(versionId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);
    const existing = await getOwnedVersion(supabase, id, versionId, orgId);

    if (existing.status === 'published') {
      throw new ValidationError('The published version cannot be deleted - publish a different version first.');
    }

    const { count: callCount } = await supabase
      .from('calls')
      .select('id', { count: 'exact', head: true })
      .eq('ai_agent_version_id', versionId);
    if (callCount && callCount > 0) {
      throw new ConflictError(`This version was used for ${callCount} call${callCount === 1 ? '' : 's'} and can't be deleted - its call history depends on it.`);
    }

    const { error } = await supabase.from('ai_agent_versions').delete().eq('id', versionId);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_VERSION_DELETED,
      entityType: 'ai_agent_version',
      entityId: versionId,
      oldValue: { agent_id: id, version_number: existing.version_number, status: existing.status },
      ipAddress: req.ip,
    });

    return ok({ deleted: true });
  });

  // POST /api/v1/agents/:id/versions/:versionId/publish
  app.post('/:id/versions/:versionId/publish', async (req) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(versionId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const agent = await getOwnedAgent(supabase, id, orgId);
    const version = await getOwnedVersion(supabase, id, versionId, orgId);

    if (version.status === 'archived') {
      throw new ValidationError('An archived version cannot be republished directly - restore it into a new draft first.');
    }

    // Archive whatever was previously published for this agent so
    // history is never overwritten - there is at most one 'published'
    // version per agent at a time.
    const { data: previouslyPublished } = await supabase
      .from('ai_agent_versions')
      .select('id')
      .eq('agent_id', id)
      .eq('status', 'published');
    for (const prev of previouslyPublished ?? []) {
      if (prev.id !== versionId) {
        await supabase.from('ai_agent_versions').update({ status: 'archived' }).eq('id', prev.id);
      }
    }

    const publishedAt = new Date().toISOString();
    const { error: versionError } = await supabase
      .from('ai_agent_versions')
      .update({ status: 'published', published_at: publishedAt })
      .eq('id', versionId);
    if (versionError) throw versionError;

    const { error: agentError } = await supabase
      .from('ai_agents')
      .update({ current_version_id: versionId, status: 'active' })
      .eq('id', id);
    if (agentError) throw agentError;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_VERSION_PUBLISHED,
      entityType: 'ai_agent_version',
      entityId: versionId,
      oldValue: { current_version_id: agent.current_version_id },
      newValue: { current_version_id: versionId },
      ipAddress: req.ip,
    });

    const { data: updatedVersion } = await supabase.from('ai_agent_versions').select(VERSION_COLUMNS).eq('id', versionId).single();

    // Best-effort: creates/updates this version's Vapi assistant right
    // away so it's call-ready without waiting on the lazy create-on-
    // first-call path in services/callOrigination.ts. Never fails
    // publishing itself - Vapi may not be connected yet, and a campaign
    // call still builds its own per-call assistant regardless (see
    // originateCall()'s campaignId/voiceOverride branch), so this is
    // purely a head start for a plain manual call against this agent.
    let vapiAssistantId: string | null = null;
    try {
      const provider = await getOrgVapiProvider(supabase, orgId);
      if (provider && updatedVersion) {
        const assistantConfig = await buildAssistantConfig(supabase, orgId, agent, updatedVersion, null, null);
        const result = updatedVersion.vapi_assistant_id
          ? await provider.updateAssistant(updatedVersion.vapi_assistant_id, assistantConfig)
          : await provider.createAssistant(assistantConfig);
        vapiAssistantId = result.providerAssistantId;
        await supabase.from('ai_agent_versions').update({ vapi_assistant_id: vapiAssistantId }).eq('id', versionId);
      }
    } catch {
      // best-effort - the version is still published either way
    }

    return ok(
      { ...updatedVersion, vapi_assistant_id: vapiAssistantId ?? updatedVersion?.vapi_assistant_id ?? null },
      { message: vapiAssistantId ? 'Version published and synced with Vapi.' : 'Version published.' },
    );
  });

  // POST /api/v1/agents/:id/versions/:versionId/restore - creates a NEW
  // draft version copying the target version's config; never mutates
  // history.
  app.post('/:id/versions/:versionId/restore', async (req, reply) => {
    const { id, versionId } = req.params as { id: string; versionId: string };
    uuidSchema.parse(id);
    uuidSchema.parse(versionId);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);
    const source = await getOwnedVersion(supabase, id, versionId, orgId);

    const { version: restored, versionNumber: nextVersionNumber } = await createDraftVersionFromSource(
      supabase,
      id,
      orgId,
      source,
      req.user!.id,
    );

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_VERSION_RESTORED,
      entityType: 'ai_agent_version',
      entityId: restored.id,
      oldValue: { restored_from_version_id: versionId },
      newValue: { new_version_id: restored.id, version_number: nextVersionNumber },
      ipAddress: req.ip,
    });

    return reply.status(201).send(ok(restored, { message: `Restored as new draft version ${nextVersionNumber}.` }));
  });

  // =================================================================
  // Improvements (Phase 11: real data, mined by services/
  // aggregateAgentImprovements.ts after every evaluated call)
  // =================================================================
  app.get('/:id/improvements', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const query = listAgentImprovementsQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);

    let builder = supabase.from('ai_agent_improvements').select('*').eq('agent_id', id);
    if (query.status) builder = builder.eq('status', query.status);
    const { data: improvements, error } = await builder.order('created_at', { ascending: false });
    if (error) throw error;
    return ok(improvements ?? []);
  });

  // GET /api/v1/agents/:id/evaluation-summary - aggregate view (spec
  // section 24/86): real GROUP BY/AVG over call_evaluations via
  // agent_evaluation_summary() (00000000000041), not client-computed from
  // a full row dump. Defaults to the last 30 days, trend-friendly.
  app.get('/:id/evaluation-summary', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const query = evaluationSummaryQuerySchema.parse(req.query);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);

    const sinceDays = query.days ?? 30;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase.rpc('agent_evaluation_summary', {
      match_organization_id: orgId,
      match_agent_id: id,
      match_since: since,
    });
    if (error) throw error;
    const row = (data ?? [])[0] ?? { call_count: 0, average_overall_score: null, category_averages: {} };

    return ok({
      agent_id: id,
      since,
      call_count: Number(row.call_count ?? 0),
      average_overall_score: row.average_overall_score === null ? null : Number(row.average_overall_score),
      category_averages: row.category_averages ?? {},
    });
  });

  // =================================================================
  // Preview - text-based simulated conversation against the published
  // system prompt. Implemented as POST (a body carrying the sample lead
  // payload + optional message/history is not practical to express in a
  // GET query string).
  // =================================================================
  app.post('/:id/preview', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = agentPreviewRequestSchema.parse(req.body ?? {});
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    const agent = await getOwnedAgent(supabase, id, orgId);

    if (!agent.current_version_id) {
      throw new ValidationError('This agent has no published version yet. Publish a version before previewing it.');
    }
    const version = await getOwnedVersion(supabase, id, agent.current_version_id, orgId);

    const provider = getLlmProvider();
    if (!provider.isConfigured) {
      throw new LlmNotConfiguredError(
        'AI Agent preview requires an LLM provider to be configured in Settings.',
      );
    }

    // agent_name is never part of the client-supplied sample lead payload
    // (it isn't lead data) - inject it here so a preview shows the SAME
    // {{agent_name}} resolution a real call gets (the voice's own name,
    // not the AI agent's internal configured name - see
    // lib/promptVariables.ts's header comment for why), rather than
    // leaving it as literal text only in preview.
    let previewVoiceName = 'your assistant';
    if (version.voice_id) {
      const { data: voice } = await supabase.from('voices').select('name').eq('id', version.voice_id).maybeSingle();
      if (voice?.name) previewVoiceName = voice.name;
    }
    const previewContext = { ...(body.lead ?? {}), agent_name: previewVoiceName };
    const renderedSystemPrompt = renderTemplate(version.system_prompt, previewContext);
    const renderedGreeting = version.greeting_template ? renderTemplate(version.greeting_template, previewContext) : '';

    const messages = [
      { role: 'system' as const, content: renderedSystemPrompt || 'You are a helpful AI voice agent.' },
      ...(renderedGreeting ? [{ role: 'assistant' as const, content: renderedGreeting }] : []),
      ...(body.history ?? []),
      ...(body.message ? [{ role: 'user' as const, content: body.message }] : []),
    ];

    const result = await provider.generateText({
      model: version.llm_model,
      messages,
      temperature: Number(version.llm_temperature),
      maxTokens: version.llm_max_tokens,
    });

    return ok({ reply: result.text, model: result.model });
  });

  // =================================================================
  // Knowledge search - real retrieval via pgvector cosine similarity,
  // strictly scoped to organization_id (see
  // supabase/migrations/00000000000023_knowledge_chunk_search_fn.sql).
  // =================================================================
  app.post('/:id/knowledge/search', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = knowledgeSearchRequestSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;
    await getOwnedAgent(supabase, id, orgId);

    const provider = getLlmProvider();
    if (!provider.isConfigured) {
      throw new LlmNotConfiguredError(
        'Knowledge base search requires an embedding provider to be configured in Settings.',
      );
    }

    const { embeddings } = await provider.embedText([body.query]);
    const queryEmbedding = embeddings[0];
    if (!queryEmbedding) throw new ValidationError('Could not embed the search query.');

    const { data: matches, error } = await supabase.rpc('match_knowledge_chunks', {
      query_embedding: queryEmbedding,
      match_organization_id: orgId,
      match_agent_id: id,
      match_count: body.top_k,
    });
    if (error) throw error;

    const documentIds = [...new Set((matches ?? []).map((m: any) => m.document_id))];
    const fileNames = new Map<string, string>();
    if (documentIds.length > 0) {
      const { data: docs } = await supabase
        .from('knowledge_documents')
        .select('id, file_name, organization_id')
        .in('id', documentIds);
      for (const d of docs ?? []) {
        if (d.organization_id === orgId) fileNames.set(d.id, d.file_name);
      }
    }

    const results = (matches ?? [])
      .filter((m: any) => fileNames.has(m.document_id))
      .map((m: any) => ({
        id: m.id,
        document_id: m.document_id,
        document_file_name: fileNames.get(m.document_id) ?? '',
        chunk_index: m.chunk_index,
        content: m.content,
        similarity: m.similarity,
      }));

    return ok(results);
  });
}
