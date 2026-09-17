/**
 * Phase 4: object storage abstraction.
 *
 * Phase 3's knowledge-document pipeline never actually persisted file
 * bytes anywhere (it used a synthetic `memory:...` locator string and
 * parsed uploads entirely in-memory on the request - see
 * routes/knowledgeBases.ts). Phase 4 is the first phase that needs to
 * durably write bytes it later serves back (generated voice-preview
 * audio, and cloning reference-sample uploads), so this interface exists
 * now. Real S3-compatible object storage per master spec section 22 is
 * still out of scope for this phase - only ONE concrete implementation
 * exists here (see localDisk.ts), and it is documented as a local-disk
 * stand-in, not production-grade durable storage.
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

export interface StorageAdapter {
  readonly name: string;
  readonly isConfigured: boolean;
  putObject(key: string, data: Buffer, contentType: string): Promise<PutObjectResult>;
}
