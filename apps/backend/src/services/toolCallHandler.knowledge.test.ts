import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createFakeSupabase } from '../test/fakeSupabase.js';

vi.mock('../lib/supabase.js', () => ({ getSupabaseAdmin: () => fake.supabase }));
vi.mock('../lib/llm/index.js', () => ({
  getLlmProvider: () => ({
    isConfigured: true,
    // "fees" queries point at the fees chunk, everything else at the other one.
    embedText: async (texts: string[]) => ({ embeddings: texts.map((t) => (/fee|cost/i.test(t) ? [1, 0] : [0, 1])) }),
  }),
}));

const fake = createFakeSupabase();
const { processToolCalls } = await import('./toolCallHandler.js');

describe('search_knowledge_base tool', () => {
  const orgId = randomUUID();
  const agentId = randomUUID();

  beforeEach(() => {
    fake.tables.knowledge_bases.length = 0;
    fake.tables.knowledge_documents.length = 0;
    fake.tables.knowledge_chunks.length = 0;
    const kbId = randomUUID();
    const docId = randomUUID();
    fake.tables.knowledge_bases.push({ id: kbId, organization_id: orgId, agent_id: agentId, name: 'KB' });
    fake.tables.knowledge_documents.push({ id: docId, knowledge_base_id: kbId, organization_id: orgId, file_name: 'manual.docx', status: 'ready' });
    fake.tables.knowledge_chunks.push(
      { id: randomUUID(), document_id: docId, organization_id: orgId, chunk_index: 0, content: 'There are no upfront fees - the firm is paid only if the case wins.', embedding: [1, 0] },
      { id: randomUUID(), document_id: docId, organization_id: orgId, chunk_index: 1, content: 'Claims must usually be filed within two years of the accident.', embedding: [0, 1] },
    );
  });

  it('answers the call synchronously with the most relevant knowledge base content', async () => {
    const call = { id: randomUUID(), organization_id: orgId, ai_agent_id: agentId, campaign_id: null, lead_id: null };
    const result = await processToolCalls(fake.supabase as any, call, [{ id: 'tc-1', name: 'search_knowledge_base', arguments: { query: 'Are there any fees?' } }]);

    expect(result.handled).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].toolCallId).toBe('tc-1');
    expect(result.results[0].result.startsWith('There are no upfront fees')).toBe(true);
  });

  it('never searches another organization\'s knowledge base', async () => {
    const call = { id: randomUUID(), organization_id: randomUUID(), ai_agent_id: agentId, campaign_id: null, lead_id: null };
    const result = await processToolCalls(fake.supabase as any, call, [{ id: 'tc-2', name: 'search_knowledge_base', arguments: { query: 'fees' } }]);
    expect(result.results[0].result).not.toContain('upfront fees');
  });
});
