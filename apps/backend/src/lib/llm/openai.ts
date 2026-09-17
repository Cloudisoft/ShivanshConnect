import {
  type EmbedTextOptions,
  type EmbedTextResult,
  type GenerateTextOptions,
  type GenerateTextResult,
  type LlmProviderAdapter,
  LlmNotConfiguredError,
  LlmProviderError,
} from './types.js';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small'; // 1536 dims - matches knowledge_chunks.embedding

/**
 * Real OpenAI implementation of LlmProviderAdapter, using OPENAI_API_KEY
 * from the environment directly via fetch (no SDK dependency). If the key
 * is unset, every method throws LlmNotConfiguredError immediately -
 * callers (routes/services) must turn that into an honest "not
 * configured" response, never mocked/fabricated output.
 */
export class OpenAIProvider implements LlmProviderAdapter {
  readonly name = 'openai';
  private readonly apiKey: string | undefined;

  constructor(apiKey: string | undefined = process.env.OPENAI_API_KEY) {
    this.apiKey = apiKey && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new LlmNotConfiguredError(
        'OPENAI_API_KEY is not configured. Set it in the backend environment to enable this feature.',
      );
    }
    return this.apiKey;
  }

  async generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const apiKey = this.requireKey();
    let res: Response;
    try {
      res = await fetch(`${OPENAI_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 800,
        }),
      });
    } catch (err) {
      throw new LlmProviderError('Failed to reach the OpenAI API.', err);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmProviderError(`OpenAI chat completion failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      model: string;
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content ?? '';
    return { text, model: json.model ?? options.model };
  }

  async embedText(texts: string[], options: EmbedTextOptions = {}): Promise<EmbedTextResult> {
    const apiKey = this.requireKey();
    if (texts.length === 0) {
      return { embeddings: [], model: options.model ?? DEFAULT_EMBEDDING_MODEL, dimensions: 1536 };
    }

    const model = options.model ?? DEFAULT_EMBEDDING_MODEL;
    let res: Response;
    try {
      res = await fetch(`${OPENAI_API_BASE}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err) {
      throw new LlmProviderError('Failed to reach the OpenAI API.', err);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new LlmProviderError(`OpenAI embeddings request failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      model: string;
      data: { embedding: number[]; index: number }[];
    };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const embeddings = sorted.map((d) => d.embedding);
    return {
      embeddings,
      model: json.model ?? model,
      dimensions: embeddings[0]?.length ?? 1536,
    };
  }
}
