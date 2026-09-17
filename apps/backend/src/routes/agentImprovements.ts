/**
 * Phase 11: human-in-the-loop workflow for AI agent improvements (master
 * spec sections 24/49). Registered at /api/v1/agent-improvements.
 *
 * PATCH /:id moves an improvement through detected -> under_review ->
 * approved/rejected. POST /:id/apply is the ONLY path from approved to
 * applied, and it never touches production behavior directly: it creates
 * a brand-new DRAFT agent version (via routes/agents.ts's
 * createDraftVersionFromSource(), the same version-creation logic
 * restore() uses) with the suggested_change folded into the system
 * prompt, and leaves publishing to a human via the existing
 * POST /agents/:id/versions/:versionId/publish endpoint. The improvement
 * row's own affected_version_id then points at that new draft.
 */
import type { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { getSupabaseAdmin } from '../lib/supabase.js';
import { ok } from '../lib/response.js';
import { NotFoundError, ValidationError } from '../lib/errors.js';
import { uuidSchema } from '../schemas/common.js';
import { updateAgentImprovementSchema } from '../schemas/agentImprovements.js';
import { writeAuditLog } from '../lib/audit.js';
import { AUDIT_ACTIONS } from '@shivanshconnect/shared';
import { createDraftVersionFromSource } from './agents.js';

/** Allowed forward transitions only - a human can never skip a review
 * step or move an improvement backwards through this endpoint (spec
 * section 24/49's explicit human-in-the-loop requirement). */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  detected: ['under_review'],
  under_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
  applied: [],
};

async function getOwnedImprovement(supabase: ReturnType<typeof getSupabaseAdmin>, id: string, orgId: string) {
  const { data: improvement, error } = await supabase.from('ai_agent_improvements').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!improvement || improvement.organization_id !== orgId) throw new NotFoundError('Improvement not found.');
  return improvement;
}

export async function agentImprovementRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.addHook('preHandler', requirePermission('agents.manage'));

  // PATCH /api/v1/agent-improvements/:id
  app.patch('/:id', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const body = updateAgentImprovementSchema.parse(req.body);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const existing = await getOwnedImprovement(supabase, id, orgId);
    const allowed = ALLOWED_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(body.status)) {
      throw new ValidationError(`Cannot move an improvement from "${existing.status}" to "${body.status}".`);
    }

    const { error } = await supabase
      .from('ai_agent_improvements')
      .update({ status: body.status, reviewed_by: req.user!.id, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_IMPROVEMENT_STATUS_CHANGED,
      entityType: 'ai_agent_improvement',
      entityId: id,
      oldValue: { status: existing.status },
      newValue: { status: body.status },
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('ai_agent_improvements').select('*').eq('id', id).single();
    return ok(updated);
  });

  // POST /api/v1/agent-improvements/:id/apply - ONLY from 'approved'.
  // Creates a new DRAFT agent version incorporating the suggested change
  // by appending it as its own clearly-labeled section to the system
  // prompt (a concrete, auditable text diff - never a silent rewrite of
  // the existing prompt body). Never publishes it.
  app.post('/:id/apply', async (req) => {
    const { id } = req.params as { id: string };
    uuidSchema.parse(id);
    const supabase = getSupabaseAdmin();
    const orgId = req.user!.organizationId;

    const improvement = await getOwnedImprovement(supabase, id, orgId);
    if (improvement.status !== 'approved') {
      throw new ValidationError('Only an approved improvement can be applied. Approve it first via PATCH.');
    }

    const { data: agent, error: agentError } = await supabase.from('ai_agents').select('*').eq('id', improvement.agent_id).maybeSingle();
    if (agentError) throw agentError;
    if (!agent || agent.organization_id !== orgId) throw new NotFoundError('Agent not found.');
    if (!agent.current_version_id) {
      throw new ValidationError('This agent has no published version to base a draft on. Publish a version first.');
    }

    const { data: sourceVersion, error: versionError } = await supabase
      .from('ai_agent_versions')
      .select('*')
      .eq('id', agent.current_version_id)
      .maybeSingle();
    if (versionError) throw versionError;
    if (!sourceVersion || sourceVersion.organization_id !== orgId) throw new NotFoundError('Source version not found.');

    const oldPrompt = sourceVersion.system_prompt ?? '';
    const addendumHeading = `\n\n[AI Evaluator suggestion - applied ${new Date().toISOString().slice(0, 10)}, from improvement "${improvement.issue}"]\n`;
    const newPrompt = `${oldPrompt}${addendumHeading}${improvement.suggested_change}`;

    const { version: draft } = await createDraftVersionFromSource(supabase, improvement.agent_id, orgId, sourceVersion, req.user!.id, {
      system_prompt: newPrompt,
    });

    const { error: updateError } = await supabase
      .from('ai_agent_improvements')
      .update({ status: 'applied', affected_version_id: draft.id, reviewed_by: req.user!.id, reviewed_at: new Date().toISOString() })
      .eq('id', id);
    if (updateError) throw updateError;

    await writeAuditLog({
      organizationId: orgId,
      userId: req.user!.id,
      action: AUDIT_ACTIONS.AGENT_IMPROVEMENT_APPLIED,
      entityType: 'ai_agent_improvement',
      entityId: id,
      oldValue: { system_prompt: oldPrompt, version_id: sourceVersion.id },
      newValue: { system_prompt: newPrompt, draft_version_id: draft.id },
      ipAddress: req.ip,
    });

    const { data: updated } = await supabase.from('ai_agent_improvements').select('*').eq('id', id).single();
    return ok({ improvement: updated, draft_version: draft }, { message: `Created draft version ${draft.version_number}. It remains unpublished until you publish it explicitly.` });
  });
}
