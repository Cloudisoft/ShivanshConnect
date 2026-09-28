/**
 * Small in-memory stale-while-revalidate cache for expensive read-only
 * aggregates (the dashboard KPIs and charts).
 *
 * - Fresh (younger than freshMs): returned as-is.
 * - Stale but younger than maxStaleMs: returned immediately, and ONE
 *   background refresh is started, so the next load is fresh again.
 * - Older / missing: computed now; concurrent callers share the same
 *   in-flight computation.
 *
 * Only used for data where a few seconds of staleness is fine; live call
 * state keeps coming from the Live Monitor stream.
 */
interface Entry<T> {
  value: T;
  computedAt: number;
}

export class SwrCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly freshMs: number,
    private readonly maxStaleMs: number,
    private readonly maxEntries = 500,
  ) {}

  async get(key: string, compute: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    const age = entry ? Date.now() - entry.computedAt : Number.POSITIVE_INFINITY;
    if (entry && age < this.freshMs) return entry.value;
    if (entry && age < this.maxStaleMs) {
      void this.refresh(key, compute).catch(() => undefined);
      return entry.value;
    }
    return this.refresh(key, compute);
  }

  /** Computes (or joins the in-flight computation) and stores the result. */
  refresh(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = compute()
      .then((value) => {
        if (this.entries.size >= this.maxEntries) this.entries.clear();
        this.entries.set(key, { value, computedAt: Date.now() });
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
  }
}
