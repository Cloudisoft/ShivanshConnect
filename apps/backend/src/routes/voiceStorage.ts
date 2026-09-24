import type { FastifyInstance } from 'fastify';
import { getStorageAdapter, StorageObjectNotFoundError } from '../lib/storage/index.js';

/**
 * Serves locally-stored voice-preview audio back to the browser. Only
 * ever actually reached in the test suite (local-disk adapter) - in
 * production, SupabaseStorageAdapter's putObject() returns a real signed
 * URL directly, so the frontend/external voice providers fetch bytes
 * from Supabase Storage itself and never hit this route at all. Kept
 * generic over the configured adapter (rather than local-disk-specific)
 * so it still works correctly if that ever changes. Mounted at the app
 * root (like /health), NOT under /api/v1, and deliberately
 * unauthenticated: an <audio> element cannot attach an Authorization
 * header, and the content behind these keys is just generated TTS sample
 * audio, not tenant-sensitive data. Access control is "possession of the
 * server-generated random key" - the same trust model Phase 3 already
 * accepted for its in-memory `storage_path` locators, just now actually
 * serving bytes.
 */
export async function voiceStorageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/voice-previews/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    // Reject anything that isn't a plain filename segment up front (no
    // slashes/dots-dots) before it ever reaches the adapter.
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) {
      return reply.status(400).send({ success: false, error: { code: 'INVALID_KEY', message: 'Invalid key.' } });
    }

    try {
      const adapter = getStorageAdapter();
      const data = await adapter.getObject(key);
      const contentType = key.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(data);
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) {
        return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'File not found.' } });
      }
      throw err;
    }
  });
}
