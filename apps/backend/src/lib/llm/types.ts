/**
 * Phase 3: LLM provider abstraction (master spec sections 25/26/46/48).
 *
 * Everything that needs to call an LLM - knowledge-base embedding
 * generation, agent text preview - goes through this interface, never
 * directly against a vendor SDK. Only one real implementation exists in
 * this build (OpenAIProvider, lib/llm/openai.ts); a second provider is
 * explicitly out of scope for Phase 3 per the task brief.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateTextOptions {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateTextResult {
  text: string;
  model: string;
}

export interface EmbedTextOptions {
  /** Embedding model name. Provider-specific; OpenAIProvider defaults to
   * text-embedding-3-small (1536 dims, matching
   * knowledge_chunks.embedding's column dimension). */
  model?: string;
}

export interface EmbedTextResult {
  /** One embedding vector per input string, same order. */
  embeddings: number[][];
  model: string;
  dimensions: number;
}

/** Thrown by a provider when it cannot run at all (e.g. no API key
 * configured). Routes catch this specifically and turn it into an
 * honest "not configured" API response - never a fabricated result. */
export class LlmNotConfiguredError extends Error {
  constructor(message = 'No LLM provider is configured.') {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

/** Thrown for any other provider-side failure (network error, non-2xx
 * response, malformed payload, etc.). */
export class LlmProviderError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export interface LlmProviderAdapter {
  readonly name: string;
  readonly isConfigured: boolean;
  generateText(options: GenerateTextOptions): Promise<GenerateTextResult>;
  embedText(texts: string[], options?: EmbedTextOptions): Promise<EmbedTextResult>;
}
