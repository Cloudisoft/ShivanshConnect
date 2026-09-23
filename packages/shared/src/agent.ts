/**
 * Phase 3: AI agents, agent versioning, knowledge base (RAG) and scripts
 * types shared between the backend and frontend. See
 * supabase/migrations/00000000000017-22 for the schema these mirror.
 */

export const AGENT_ROLES = [
  'sales_agent',
  'support_agent',
  'front_desk',
  'receptionist',
  'manager',
  'escalation_specialist',
  'appointment_setter',
  'lead_qualification_agent',
  'custom',
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  sales_agent: 'Sales agent',
  support_agent: 'Support agent',
  front_desk: 'Front desk',
  receptionist: 'Receptionist',
  manager: 'Manager',
  escalation_specialist: 'Escalation specialist',
  appointment_setter: 'Appointment setter',
  lead_qualification_agent: 'Lead qualification agent',
  custom: 'Custom',
};

export type AgentStatus = 'draft' | 'active' | 'inactive';
export type AgentVersionStatus = 'draft' | 'published' | 'archived';

/** Personality preset catalog (master spec sections 25/26) - tone is a
 * single choice, personality/behavior traits are multi-select and
 * combinable. Frontend renders these as toggle chips. */
export const PERSONALITY_TONES = [
  'Professional',
  'Friendly',
  'Calm',
  'Empathetic',
  'Confident',
  'Consultative',
  'Energetic',
  'Formal',
  'Warm',
  'Direct',
] as const;
export type PersonalityTone = (typeof PERSONALITY_TONES)[number];

export const PERSONALITY_TRAITS = [
  'Patient',
  'Persuasive',
  'Curious',
  'Reassuring',
  'Detail-oriented',
  'Concise',
  'Proactive',
  'Upbeat',
] as const;

export const BEHAVIOR_TRAITS = [
  'Asks clarifying questions',
  'Handles objections gracefully',
  'Summarizes before ending',
  'Confirms next steps',
  'Escalates on request',
  'Never interrupts',
  'Stays on script',
  'Adapts to caller tone',
] as const;

export interface AgentPersonality {
  tone: PersonalityTone | null;
  personality_traits: string[];
  behavior_traits: string[];
}

export const DEFAULT_AGENT_PERSONALITY: AgentPersonality = {
  tone: null,
  personality_traits: [],
  behavior_traits: [],
};

export interface AgentTransferRules {
  on_no_match: 'end_call' | 'transfer' | 'voicemail';
  transfer_to: string | null;
  conditions: string[];
}

export const DEFAULT_TRANSFER_RULES: AgentTransferRules = {
  on_no_match: 'end_call',
  transfer_to: null,
  conditions: [],
};

export interface AgentCallEndingRules {
  max_call_duration_seconds: number | null;
  end_phrases: string[];
  summarize_before_ending: boolean;
}

export const DEFAULT_CALL_ENDING_RULES: AgentCallEndingRules = {
  max_call_duration_seconds: null,
  end_phrases: [],
  summarize_before_ending: true,
};

/** Vapi's own real, currently-documented `model.provider` enum
 * (https://docs.vapi.ai - Assistant.model.provider). llm_provider was
 * previously a free-text field, so any value that didn't match this exact
 * list (or was just missing on an override) made the call origination
 * itself fail: "Vapi request failed (400 POST /call):
 * assistantOverrides.model.provider must be one of the following
 * values: ...". Constraining it here, in both the create/edit form and
 * the backend schema, is what actually prevents that at the source. */
export const LLM_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'azure-openai',
  'groq',
  'together-ai',
  'openrouter',
  'perplexity-ai',
  'deepinfra',
  'anyscale',
  'custom-llm',
  'baseten',
  'runpod',
  'vapi',
  'anthropic-bedrock',
  'anthropic-vertex',
  'minimax',
  'xai',
  'inflection-ai',
  'cerebras',
  'deep-seek',
  'mistral',
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'azure-openai': 'Azure OpenAI',
  groq: 'Groq',
  'together-ai': 'Together AI',
  openrouter: 'OpenRouter',
  'perplexity-ai': 'Perplexity',
  deepinfra: 'DeepInfra',
  anyscale: 'Anyscale',
  'custom-llm': 'Custom LLM',
  baseten: 'Baseten',
  runpod: 'RunPod',
  vapi: 'Vapi',
  'anthropic-bedrock': 'Anthropic (Bedrock)',
  'anthropic-vertex': 'Anthropic (Vertex)',
  minimax: 'MiniMax',
  xai: 'xAI',
  'inflection-ai': 'Inflection AI',
  cerebras: 'Cerebras',
  'deep-seek': 'DeepSeek',
  mistral: 'Mistral',
};

/** {{variable}} palette shown next to prompt/greeting/script editors. */
export const PROMPT_VARIABLES = [
  'first_name',
  'last_name',
  'phone',
  'email',
  'custom_field',
] as const;
export type PromptVariable = (typeof PROMPT_VARIABLES)[number];

export interface AiAgent {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  role: AgentRole;
  status: AgentStatus;
  current_version_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiAgentVersion {
  id: string;
  agent_id: string;
  organization_id: string;
  version_number: number;
  personality: AgentPersonality;
  language: string;
  accent: string | null;
  greeting_template: string;
  system_prompt: string;
  fallback_behavior: string | null;
  transfer_rules: AgentTransferRules;
  call_ending_rules: AgentCallEndingRules;
  llm_provider: string;
  llm_model: string;
  llm_temperature: number;
  llm_max_tokens: number;
  voice_id: string | null;
  status: AgentVersionStatus;
  published_at: string | null;
  /** Set once this version has been imported/created in Vapi - null until
   * the first eager sync-on-publish or lazy sync-on-first-call. */
  vapi_assistant_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AiAgentWithCurrentVersion extends AiAgent {
  current_version: AiAgentVersion | null;
}

export type ImprovementStatus = 'detected' | 'under_review' | 'approved' | 'rejected' | 'applied';

/** One prior occurrence's real evidence for a recurring improvement -
 * services/aggregateAgentImprovements.ts appends one of these every time
 * the same normalized issue is seen again on a different call. */
export interface AgentImprovementEvidenceEntry {
  call_id: string;
  evaluation_id: string;
  category: string;
  excerpt: string;
  detected_at: string;
}

export interface AgentImprovementEvidence {
  category: string;
  occurrences: AgentImprovementEvidenceEntry[];
}

export interface AiAgentImprovement {
  id: string;
  organization_id: string;
  agent_id: string;
  issue: string;
  evidence: AgentImprovementEvidence | Record<string, unknown>;
  suggested_change: string;
  confidence: number;
  frequency: number;
  status: ImprovementStatus;
  affected_version_id: string | null;
  // Phase 11: points at the most recent call/evaluation that surfaced or
  // reinforced this issue (see 00000000000039's ALTER) - the full history
  // of every contributing call is in `evidence.occurrences` above.
  source_call_id: string | null;
  source_evaluation_id: string | null;
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export type ScriptSource = 'editor' | 'upload' | 'template';

export interface Script {
  id: string;
  organization_id: string;
  agent_id: string | null;
  campaign_id: string | null;
  name: string;
  content: string;
  version: number;
  source: ScriptSource;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Starter script templates offered on create (master spec section 47). */
export interface ScriptTemplate {
  key: string;
  name: string;
  content: string;
}

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    key: 'sales_outreach',
    name: 'Sales outreach',
    content:
      "Hi {{first_name}}, this is {{agent_name}} calling. Do you have a quick minute?\n\n" +
      "I'm reaching out because we help people like you save time on {{pain_point}}. " +
      "Have you had a chance to think about how you're currently handling that?\n\n" +
      '[Listen and adapt based on their response]\n\n' +
      "If it sounds like a fit: Great - I'd love to set up a quick 15-minute call with one of our specialists " +
      'to walk you through exactly how this could work for you. Does {{proposed_time}} work for you?\n\n' +
      "If not interested: No problem at all, {{first_name}}. Thanks for your time today, and if anything changes " +
      "feel free to reach out to us at {{callback_number}}.",
  },
  {
    key: 'appointment_reminder',
    name: 'Appointment reminder',
    content:
      'Hi {{first_name}}, this is a reminder call about your upcoming appointment on ' +
      '{{appointment_date}} at {{appointment_time}}.\n\n' +
      'Can you confirm you will be able to make it?\n\n' +
      '[If confirmed]: Perfect, we will see you then. Is there anything you need to prepare beforehand?\n\n' +
      '[If they need to reschedule]: No problem - what day and time would work better for you? ' +
      "I'll get that updated right away.\n\n" +
      'Thanks so much, {{first_name}}, and have a great rest of your day.',
  },
  {
    key: 'support_callback',
    name: 'Support callback',
    content:
      'Hi {{first_name}}, this is {{agent_name}} from support, returning your call about {{issue_summary}}.\n\n' +
      'Is now still a good time to talk?\n\n' +
      "[If yes]: Let's go through what's happening. Can you walk me through the issue from the start?\n\n" +
      '[Troubleshoot / gather details]\n\n' +
      "Before we wrap up: is there anything else I can help you with today? I'll follow up with a summary at {{email}}.",
  },
];

export const KNOWLEDGE_DOCUMENT_FILE_TYPES = ['pdf', 'docx', 'txt', 'csv', 'md'] as const;
export type KnowledgeDocumentFileType = (typeof KNOWLEDGE_DOCUMENT_FILE_TYPES)[number];

export type KnowledgeDocumentStatus = 'uploaded' | 'processing' | 'ready' | 'failed';

export interface KnowledgeBase {
  id: string;
  organization_id: string;
  agent_id: string | null;
  campaign_id: string | null;
  name: string;
  created_at: string;
}

export interface KnowledgeDocument {
  id: string;
  knowledge_base_id: string;
  organization_id: string;
  file_name: string;
  file_type: KnowledgeDocumentFileType;
  storage_path: string;
  status: KnowledgeDocumentStatus;
  size_bytes: number;
  uploaded_by: string | null;
  created_at: string;
  processed_at: string | null;
  error_message: string | null;
}

export interface KnowledgeChunkSearchResult {
  id: string;
  document_id: string;
  document_file_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
}

export interface AgentPreviewMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentPreviewRequest {
  lead?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
    custom_field?: Record<string, string>;
  };
  message?: string;
  history?: AgentPreviewMessage[];
}

export interface AgentPreviewResponse {
  reply: string;
  model: string;
}
