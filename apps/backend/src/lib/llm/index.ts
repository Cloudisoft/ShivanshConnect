import { OpenAIProvider } from './openai.js';
import type { LlmProviderAdapter } from './types.js';

export * from './types.js';
export { OpenAIProvider } from './openai.js';

let cachedProvider: LlmProviderAdapter | null = null;

/**
 * Resolves the configured LLM provider adapter. Only OpenAI is
 * implemented in this build; the indirection exists so routes/services
 * never import OpenAIProvider directly and a second provider can be
 * added later without touching call sites.
 */
export function getLlmProvider(): LlmProviderAdapter {
  if (!cachedProvider) {
    cachedProvider = new OpenAIProvider();
  }
  return cachedProvider;
}

/** Test-only hook to inject a fake provider without touching env vars. */
export function __setLlmProviderForTests(provider: LlmProviderAdapter | null): void {
  cachedProvider = provider;
}
