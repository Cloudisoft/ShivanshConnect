import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import type { PutObjectResult, StorageAdapter } from './types.js';

/**
 * Local-disk-backed StorageAdapter - the one concrete implementation
 * this phase ships (see types.ts's header comment for why nothing more
 * is built here). Files are written under STORAGE_LOCAL_DIR (default
 * `<repo>/apps/backend/.data/voice-storage`), and served back by the
 * unauthenticated `GET /voice-previews/:key` route
 * (routes/voiceStorage.ts) - keys are always server-generated random
 * UUIDs, so a served file is only reachable by someone who already has
 * the URL the API handed back, never guessable/listable.
 *
 * This is a real, durable-for-the-container write (not a `/tmp` path
 * that silently vanishes) but it is explicitly NOT production object
 * storage: it does not survive a redeploy to a new container, does not
 * replicate, and has no access control beyond an unguessable key. A
 * later phase is expected to add a real S3-compatible
 * StorageAdapter implementation (master spec section 22) and swap the
 * default without touching any call site, exactly like the LLM/voice
 * provider adapter pattern.
 */
export class LocalDiskStorageAdapter implements StorageAdapter {
  readonly name = 'local-disk';
  private readonly baseDir: string;

  constructor(baseDir: string = process.env.STORAGE_LOCAL_DIR ?? resolve(process.cwd(), '.data/voice-storage')) {
    this.baseDir = resolve(baseDir);
  }

  /** Always configured: writing to local disk needs no external
   * credentials. A future real object-storage adapter is expected to be
   * conditionally configured (e.g. only when STORAGE_ACCESS_KEY_ID is
   * set) the same way lib/llm/openai.ts is. */
  get isConfigured(): boolean {
    return true;
  }

  async putObject(key: string, data: Buffer, _contentType: string): Promise<PutObjectResult> {
    const safeKey = normalize(key).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(this.baseDir, safeKey);
    // Defense in depth against path traversal even though callers only
    // ever pass server-generated uuid-based keys.
    if (!filePath.startsWith(this.baseDir)) {
      throw new Error('Invalid storage key.');
    }

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);

    return { path: safeKey, url: `/voice-previews/${safeKey}` };
  }

  /** Used only by routes/voiceStorage.ts to resolve a key back to a file
   * path when serving it. */
  resolvePath(key: string): string {
    const safeKey = normalize(key).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(this.baseDir, safeKey);
    if (!filePath.startsWith(this.baseDir)) {
      throw new Error('Invalid storage key.');
    }
    return filePath;
  }
}
