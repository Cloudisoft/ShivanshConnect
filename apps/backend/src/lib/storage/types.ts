/**
 * Phase 4: object storage abstraction.
 *
 * Phase 3's knowledge-document pipeline never actually persisted file
 * bytes anywhere (it used a synthetic `memory:...` locator string and
 * parsed uploads entirely in-memory on the request - see
 * routes/knowledgeBases.ts). Phase 4 is the first phase that needs to
 * durably write bytes it later serves back (generated voice-preview
 * audio, and cloning reference-sample uploads), so this interface exists
 * now.
 *
 * Bug fix: call recordings, exports, and voice-clone samples were never
 * actually durable in production - the only implementation running there
 * was LocalDiskStorageAdapter (see that file's own header comment, which
 * says so plainly), and every one of this platform's redeploys wipes the
 * container's local disk clean. A recording downloaded before any given
 * deploy was gone the moment the next one landed - which, in practice,
 * meant recordings appeared to "never work" despite ingestion succeeding.
 * supabaseStorage.ts is the real, durable implementation now used in any
 * non-test environment (see index.ts's getStorageAdapter()) - local disk
 * remains only for the test suite, which must stay fully offline.
 */

export class StorageNotConfiguredError extends Error {
  constructor(message = 'Object storage is not configured.') {
    super(message);
    this.name = 'StorageNotConfiguredError';
  }
}

export interface PutObjectResult {
  /** Storage-internal path/key, stored in DB columns like
   * voices.source_sample_storage_path. */
  path: string;
  /** A URL the frontend can use to fetch the object directly (for the
   * local-disk implementation, this is a relative path served by the
   * backend's own unauthenticated preview-file route - see
   * routes/voiceStorage.ts). */
  url: string;
}

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}

export interface StorageAdapter {
  readonly name: string;
  readonly isConfigured: boolean;
  putObject(key: string, data: Buffer, contentType: string): Promise<PutObjectResult>;
  /** Throws StorageObjectNotFoundError when the key doesn't exist. */
  getObject(key: string): Promise<Buffer>;
  /** Never throws for a key that's already gone - deleting a missing
   * object is a no-op, not an error. */
  deleteObject(key: string): Promise<void>;
}
