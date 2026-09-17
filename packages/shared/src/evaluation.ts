/**
 * Phase 11: AI call evaluator + improvement queue types (master spec
 * sections 24/49/86). See
 * supabase/migrations/00000000000038_phase11_call_evaluations.sql and
 * 00000000000039_phase11_agent_improvements_alter.sql for the schema
 * these mirror.
 */

/** The exact rubric category list from spec section 24. Every
 * call_evaluations.scores object has (at minimum) these keys, each a
 * 0-100 numeric sub-score. */
export const EVALUATION_SCORE_CATEGORIES = [
  'opening',
  'introduction',
  'listening',
  'understanding',
  'accuracy',
  'knowledge_usage',
  'objection_handling',
  'tone',
  'empathy',
  'professionalism',
  'script_adherence',
  'sop_adherence',
  'compliance',
  'call_control',
  'transfer_handling',
  'closing',
  'disposition_accuracy',
] as const;
export type EvaluationScoreCategory = (typeof EVALUATION_SCORE_CATEGORIES)[number];

export const EVALUATION_SCORE_CATEGORY_LABELS: Record<EvaluationScoreCategory, string> = {
  opening: 'Opening',
  introduction: 'Introduction',
  listening: 'Listening',
  understanding: 'Understanding',
  accuracy: 'Accuracy',
  knowledge_usage: 'Knowledge usage',
  objection_handling: 'Objection handling',
  tone: 'Tone',
  empathy: 'Empathy',
  professionalism: 'Professionalism',
  script_adherence: 'Script adherence',
  sop_adherence: 'SOP adherence',
  compliance: 'Compliance',
  call_control: 'Call control',
  transfer_handling: 'Transfer handling',
  closing: 'Closing',
  disposition_accuracy: 'Disposition accuracy',
};

export type EvaluationScores = Record<EvaluationScoreCategory, number>;

export interface CallEvaluation {
  id: string;
  call_id: string;
  organization_id: string;
  overall_score: number;
  scores: EvaluationScores;
  what_went_well: string[];
  what_went_poorly: string[];
  missed_opportunities: string[];
  incorrect_statements: string[];
  customer_objections: string[];
  recommended_improvement: string | null;
  llm_provider: string;
  llm_model: string;
  evaluated_at: string;
  created_at: string;
}

/** Honest "not evaluated" states GET /calls/:id/evaluation can return
 * instead of a CallEvaluation, per the hard "never fabricate" rule. */
export type CallEvaluationState =
  | { state: 'evaluated'; evaluation: CallEvaluation }
  | { state: 'not_evaluated'; reason: string }
  | { state: 'skipped'; reason: string };

export interface AgentEvaluationSummary {
  agent_id: string;
  since: string;
  call_count: number;
  average_overall_score: number | null;
  category_averages: Partial<Record<EvaluationScoreCategory, number>>;
}
