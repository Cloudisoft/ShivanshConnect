import { LocalDiskStorageAdapter } from './localDisk.js';
import type { StorageAdapter } from './types.js';

export * from './types.js';
export { LocalDiskStorageAdapter } from './localDisk.js';

let cachedAdapter: StorageAdapter | null = null;

/** Resolves the configured storage adapter. Only local-disk is
 * implemented in this build (see localDisk.ts) - the indirection exists
 * so routes/services never import LocalDiskStorageAdapter directly and a
 * real S3-compatible adapter can be added later without touching call
 * sites. */
export function getStorageAdapter(): StorageAdapter {
  if (!cachedAdapter) {
    cachedAdapter = new LocalDiskStorageAdapter();
  }
  return cachedAdapter;
}

/** Test-only hook to inject a fake adapter without touching the filesystem. */
export function __setStorageAdapterForTests(adapter: StorageAdapter | null): void {
  cachedAdapter = adapter;
}
