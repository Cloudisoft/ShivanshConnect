import { LocalDiskStorageAdapter } from './localDisk.js';
import { SupabaseStorageAdapter } from './supabaseStorage.js';
import type { StorageAdapter } from './types.js';

export * from './types.js';
export { LocalDiskStorageAdapter } from './localDisk.js';
export { SupabaseStorageAdapter } from './supabaseStorage.js';

let cachedAdapter: StorageAdapter | null = null;

/** Resolves the configured storage adapter. SupabaseStorageAdapter is the
 * real, durable implementation used everywhere except the test suite,
 * which stays on local disk so it never makes real network calls (every
 * integration test file sets NODE_ENV=test explicitly at the top - the
 * same signal this reads). See types.ts's header comment for why
 * local-disk was never safe to use as the production default. */
export function getStorageAdapter(): StorageAdapter {
  if (!cachedAdapter) {
    cachedAdapter = process.env.NODE_ENV === 'test' ? new LocalDiskStorageAdapter() : new SupabaseStorageAdapter();
  }
  return cachedAdapter;
}

/** Test-only hook to inject a fake adapter without touching the filesystem. */
export function __setStorageAdapterForTests(adapter: StorageAdapter | null): void {
  cachedAdapter = adapter;
}
