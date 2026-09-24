import { getSupabaseAdmin } from '../supabase.js';
import { StorageObjectNotFoundError, type PutObjectResult, type StorageAdapter } from './types.js';

/**
 * The real, durable StorageAdapter used in every non-test environment
 * (see index.ts's getStorageAdapter()) - backed by Supabase Storage,
 * reusing the same project/credentials this app already requires for
 * everything else (no new infrastructure or credentials to configure).
 * Object bytes here survive a redeploy, unlike LocalDiskStorageAdapter's
 * container-local disk.
 *
 * The bucket is created lazily on first use rather than assumed to exist
 * (self-healing, matching this codebase's established pattern elsewhere
 * for "never depend on a manual setup step nobody remembers to do") -
 * private (not public), since this bucket holds call recordings and
 * exports, real tenant data, not just voice-preview samples.
 */
const BUCKET = 'app-storage';

export class SupabaseStorageAdapter implements StorageAdapter {
  readonly name = 'supabase-storage';
  private bucketEnsured = false;

  get isConfigured(): boolean {
    return true;
  }

  private async ensureBucket(): Promise<void> {
    if (this.bucketEnsured) return;
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
    // "already exists" is the expected steady-state outcome after the
    // first call ever creates it - not a real error.
    if (error && !/already exists/i.test(error.message)) {
      throw error;
    }
    this.bucketEnsured = true;
  }

  async putObject(key: string, data: Buffer, contentType: string): Promise<PutObjectResult> {
    await this.ensureBucket();
    const supabase = getSupabaseAdmin();
    const { error } = await supabase.storage.from(BUCKET).upload(key, data, { contentType, upsert: true });
    if (error) throw error;
    // A real, externally-fetchable URL, scoped to this one object and
    // time-limited (unlike a blanket public route that would serve every
    // key in the bucket, including recordings/exports - real tenant
    // data, not just TTS preview samples). Callers that only need the
    // storage `path` (recordings/exports - see processCallArtifacts.ts /
    // exportGenerators/runner.ts) never read this url field at all; the
    // ones that do (voices.ts's preview/clone flows, where an <audio>
    // element or an external voice provider needs to fetch the bytes
    // directly, without our own auth) get a signed link instead. 24
    // hours comfortably covers both "the frontend plays it back" and "an
    // external provider fetches a just-uploaded clone sample."
    const { data: signed, error: signError } = await supabase.storage.from(BUCKET).createSignedUrl(key, 24 * 60 * 60);
    if (signError || !signed) throw signError ?? new Error('Failed to create a signed URL for the uploaded object.');
    return { path: key, url: signed.signedUrl };
  }

  async getObject(key: string): Promise<Buffer> {
    await this.ensureBucket();
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(BUCKET).download(key);
    if (error || !data) throw new StorageObjectNotFoundError(key);
    return Buffer.from(await data.arrayBuffer());
  }

  async deleteObject(key: string): Promise<void> {
    await this.ensureBucket();
    const supabase = getSupabaseAdmin();
    // Supabase Storage's remove() never errors for an already-missing
    // key - matches this interface's own "delete is a no-op" contract
    // with no extra handling needed.
    await supabase.storage.from(BUCKET).remove([key]);
  }
}
