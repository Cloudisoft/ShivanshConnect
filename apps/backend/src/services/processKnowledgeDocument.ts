import { getSupabaseAdmin } from '../lib/supabase.js';
import { chunkText } from '../lib/chunking.js';
import { extractDocumentText } from './extractDocumentText.js';
import { getLlmProvider, LlmNotConfiguredError } from '../lib/llm/index.js';
import type { KnowledgeDocumentFileType } from '@shivanshconnect/shared';

/**
 * Phase 3 async knowledge-document processing (master spec sections
 * 25/26/48), deliberately following the exact same shape as Phase 2's
 * services/importLeads.ts: there is still no queue/worker infra (Redis/
 * BullMQ is Phase 15), so a freshly-uploaded document is processed via
 * setImmediate on the same backend process right after upload
 * (routes/knowledgeBases.ts calls this). Every exported function here
 * takes plain arguments and does its own Supabase reads/writes - no
 * Fastify request/reply object - so a future BullMQ worker can call the
 * same functions unchanged; only what invokes them (and where the file
 * bytes come from) needs to change.
 *
 * Pipeline: extract text -> chunk (~500-800 tokens, overlapping) ->
 * embed each chunk via the configured LLM provider -> store
 * knowledge_chunks rows -> mark the document ready. If no embedding
 * provider is configured (OPENAI_API_KEY unset), the document is marked
 * failed with a clear error_message - embeddings are never fabricated.
 */

const EMBEDDING_BATCH_SIZE = 64;

export async function processKnowledgeDocument(documentId: string, buffer: Buffer): Promise<void> {
  const supabase = getSupabaseAdmin();

  const { data: doc, error: docError } = await supabase
    .from('knowledge_documents')
    .select('id, organization_id, file_type, file_name')
    .eq('id', documentId)
    .single();
  if (docError || !doc) {
    return; // Document was deleted before processing started; nothing to do.
  }

  await supabase.from('knowledge_documents').update({ status: 'processing' }).eq('id', documentId);

  try {
    const text = await extractDocumentText(buffer, doc.file_type as KnowledgeDocumentFileType);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error('No extractable text was found in this document.');
    }

    const chunks = chunkText(trimmed);
    if (chunks.length === 0) {
      throw new Error('No extractable text was found in this document.');
    }

    const provider = getLlmProvider();
    if (!provider.isConfigured) {
      throw new LlmNotConfiguredError(
        'No embedding provider configured. Set OPENAI_API_KEY in the backend environment to process knowledge base documents.',
      );
    }

    // Clear any prior chunks (e.g. a reprocess run) before inserting fresh ones.
    await supabase.from('knowledge_chunks').delete().eq('document_id', documentId);

    for (let i = 0; i < chunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBEDDING_BATCH_SIZE);
      const { embeddings } = await provider.embedText(batch);
      const rows = batch.map((content, idx) => ({
        document_id: documentId,
        organization_id: doc.organization_id,
        chunk_index: i + idx,
        content,
        embedding: embeddings[idx],
      }));
      const { error: insertError } = await supabase.from('knowledge_chunks').insert(rows);
      if (insertError) throw insertError;
    }

    await supabase
      .from('knowledge_documents')
      .update({ status: 'ready', processed_at: new Date().toISOString(), error_message: null })
      .eq('id', documentId);
  } catch (err) {
    const message =
      err instanceof LlmNotConfiguredError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Document processing failed unexpectedly.';
    await supabase
      .from('knowledge_documents')
      .update({ status: 'failed', error_message: message })
      .eq('id', documentId);
  }
}
