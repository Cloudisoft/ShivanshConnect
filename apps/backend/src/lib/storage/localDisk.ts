import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { StorageObjectNotFoundError, type PutObjectResult, type StorageAdapter } from './types.js';

/**
 * Local-disk-backed StorageAdapter, used only by the test suite (see
 * index.ts's getStorageAdapter() - any non-test environment uses
 * supabaseStorage.ts instead). Files are written under STORAGE_LOCAL_DIR
 * (default `<repo>/apps/backend/.data/voice-storage`).
 *
 * This is explicitly NOT production object storage: it does not survive
 * a redeploy to a new container and does not replicate - see types.ts's
 * header comment for why it was replaced as the production default.
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

  private resolvePath(key: string): string {
    const safeKey = normalize(key).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(this.baseDir, safeKey);
    if (!filePath.startsWith(this.baseDir)) {
      throw new Error('Invalid storage key.');
    }
    return filePath;
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolvePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new StorageObjectNotFoundError(key);
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await unlink(this.resolvePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }
}
