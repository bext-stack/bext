// QueryClient — async data cache with reactive observers.
//
// Modeled on @tanstack/query-core's surface, but built on bext's signals
// instead of an observer class hierarchy. Each cache entry's state is
// exposed as Signals; reactive consumers (createQuery) just read .value
// and the signals graph wires the rest. Imperative ops (setQueryData,
// invalidateQueries) mutate the same signals so observers wake up.
//
// SSR: prefetchQuery on the server populates the cache; dehydrate()
// serializes it to JSON; the island runs hydrate(state) before its
// first createQuery call so SSR output and first client paint reflect
// the prefetched data without a refetch.

import { signal, type Signal } from "../signals";

export type QueryKey = readonly unknown[];
export type QueryStatus = "pending" | "success" | "error";
export type FetchStatus = "fetching" | "idle";

export interface QueryFunctionContext<TKey extends QueryKey = QueryKey> {
  queryKey: TKey;
  signal: AbortSignal;
}

export type QueryFunction<TData, TKey extends QueryKey = QueryKey> = (
  ctx: QueryFunctionContext<TKey>,
) => Promise<TData> | TData;

export interface QueryOptions<
  TData,
  TError = Error,
  TKey extends QueryKey = QueryKey,
> {
  queryKey: TKey;
  queryFn: QueryFunction<TData, TKey>;
  /** ms a successful result is "fresh" — no auto-refetch within this window. Default 0. */
  staleTime?: number;
  /** ms an unobserved entry survives before being garbage-collected. Default 5min. */
  gcTime?: number;
  /** false → 0 retries; true → infinite; number → that many; fn → custom. Default 3. */
  retry?: boolean | number | ((failureCount: number, error: TError) => boolean);
  /** ms backoff between retries. Default exponential capped at 30s. */
  retryDelay?: number | ((failureCount: number, error: TError) => number);
  /** Skip auto-fetch when false. Default true. */
  enabled?: boolean;
  /** ms between background refetches when observed. Default false. */
  refetchInterval?: number | false;
  /** Seed the cache with synchronous data. */
  initialData?: TData | (() => TData);
}

export interface QueryFilter {
  queryKey?: QueryKey;
  /** When true, only the exact queryKey matches. Otherwise prefix-matches. */
  exact?: boolean;
}

export interface DehydratedQuery {
  queryKey: QueryKey;
  state: {
    data: unknown;
    dataUpdatedAt: number;
    status: QueryStatus;
  };
}

export interface DehydratedState {
  queries: DehydratedQuery[];
}

export interface ClientOptions {
  defaultStaleTime?: number;
  defaultGcTime?: number;
  defaultRetry?: number | boolean;
}

export interface QueryEntry<TData = unknown, TError = unknown> {
  queryKey: QueryKey;
  hash: string;
  data: Signal<TData | undefined>;
  error: Signal<TError | undefined>;
  status: Signal<QueryStatus>;
  fetchStatus: Signal<FetchStatus>;
  dataUpdatedAt: Signal<number>;
  errorUpdatedAt: Signal<number>;
  /** In-flight request, if any. New observers reuse it (dedup). */
  promise?: Promise<TData>;
  abort?: AbortController;
  observers: Set<() => void>;
  /** Scheduled removal once observers drops to zero, after gcTime. */
  gcHandle?: ReturnType<typeof setTimeout>;
}

const IS_BROWSER = typeof window !== "undefined";

export class QueryClient {
  private cache: Map<string, QueryEntry> = new Map();
  readonly defaults: { staleTime: number; gcTime: number; retry: number | boolean };

  constructor(opts: ClientOptions = {}) {
    this.defaults = {
      staleTime: opts.defaultStaleTime ?? 0,
      gcTime: opts.defaultGcTime ?? 5 * 60_000,
      retry: opts.defaultRetry ?? 3,
    };
  }

  // ── public API ───────────────────────────────────────────────────────

  getQueryData<TData = unknown>(key: QueryKey): TData | undefined {
    return this.cache.get(hashKey(key))?.data.peek() as TData | undefined;
  }

  setQueryData<TData>(
    key: QueryKey,
    updater: TData | ((old: TData | undefined) => TData),
  ): TData {
    const entry = this._ensureEntry<TData>(key);
    const next =
      typeof updater === "function"
        ? (updater as (old: TData | undefined) => TData)(entry.data.peek() as TData | undefined)
        : updater;
    entry.data.value = next;
    entry.error.value = undefined;
    entry.status.value = "success";
    entry.dataUpdatedAt.value = Date.now();
    return next;
  }

  fetchQuery<TData, TError = Error, TKey extends QueryKey = QueryKey>(
    opts: QueryOptions<TData, TError, TKey>,
  ): Promise<TData> {
    const entry = this._ensureEntry<TData, TError>(opts.queryKey, opts.initialData);
    return this._runFetch(entry, opts);
  }

  prefetchQuery<TData, TError = Error, TKey extends QueryKey = QueryKey>(
    opts: QueryOptions<TData, TError, TKey>,
  ): Promise<void> {
    return this.fetchQuery(opts).then(
      () => undefined,
      () => undefined,
    );
  }

  invalidateQueries(filter?: QueryFilter): Promise<void> {
    const tasks: Array<Promise<unknown>> = [];
    for (const entry of this.cache.values()) {
      if (!entryMatches(entry, filter)) continue;
      // Mark stale so the next observer read triggers a refetch.
      entry.dataUpdatedAt.value = 0;
      // Active observers refetch immediately.
      for (const refetch of entry.observers) {
        tasks.push(Promise.resolve().then(refetch));
      }
    }
    return Promise.all(tasks).then(() => undefined);
  }

  removeQueries(filter?: QueryFilter): void {
    for (const [k, entry] of this.cache) {
      if (!entryMatches(entry, filter)) continue;
      if (entry.gcHandle) clearTimeout(entry.gcHandle);
      entry.abort?.abort();
      this.cache.delete(k);
    }
  }

  cancelQueries(filter?: QueryFilter): void {
    for (const entry of this.cache.values()) {
      if (entryMatches(entry, filter)) entry.abort?.abort();
    }
  }

  clear(): void {
    for (const entry of this.cache.values()) {
      if (entry.gcHandle) clearTimeout(entry.gcHandle);
      entry.abort?.abort();
    }
    this.cache.clear();
  }

  dehydrate(): DehydratedState {
    const queries: DehydratedQuery[] = [];
    for (const entry of this.cache.values()) {
      const status = entry.status.peek();
      if (status !== "success") continue;
      queries.push({
        queryKey: entry.queryKey,
        state: {
          data: entry.data.peek(),
          dataUpdatedAt: entry.dataUpdatedAt.peek(),
          status,
        },
      });
    }
    return { queries };
  }

  hydrate(state: DehydratedState | undefined | null): void {
    if (!state || !Array.isArray(state.queries)) return;
    for (const q of state.queries) {
      const entry = this._ensureEntry(q.queryKey);
      entry.data.value = q.state.data;
      entry.status.value = q.state.status;
      entry.dataUpdatedAt.value = q.state.dataUpdatedAt;
      entry.error.value = undefined;
    }
  }

  // ── package-internal ─────────────────────────────────────────────────

  _ensureEntry<TData = unknown, TError = unknown>(
    key: QueryKey,
    initial?: TData | (() => TData),
  ): QueryEntry<TData, TError> {
    const hash = hashKey(key);
    let entry = this.cache.get(hash) as QueryEntry<TData, TError> | undefined;
    if (entry) return entry;

    const seeded =
      typeof initial === "function" ? (initial as () => TData)() : initial;
    const hasSeed = seeded !== undefined;
    entry = {
      queryKey: key,
      hash,
      data: signal<TData | undefined>(seeded),
      error: signal<TError | undefined>(undefined),
      status: signal<QueryStatus>(hasSeed ? "success" : "pending"),
      fetchStatus: signal<FetchStatus>("idle"),
      dataUpdatedAt: signal<number>(hasSeed ? Date.now() : 0),
      errorUpdatedAt: signal<number>(0),
      observers: new Set(),
    };
    this.cache.set(hash, entry);
    return entry;
  }

  _runFetch<TData, TError, TKey extends QueryKey>(
    entry: QueryEntry<TData, TError>,
    opts: QueryOptions<TData, TError, TKey>,
  ): Promise<TData> {
    if (entry.promise) return entry.promise;

    const ac = new AbortController();
    entry.abort = ac;
    entry.fetchStatus.value = "fetching";

    const retry = opts.retry ?? this.defaults.retry;
    const retryDelay = opts.retryDelay ?? defaultRetryDelay;
    const maxAttempts =
      retry === false || retry === 0
        ? 1
        : retry === true
          ? Infinity
          : 1 + (retry as number);

    let attempt = 0;
    const exec = async (): Promise<TData> => {
      attempt++;
      try {
        const out = await Promise.resolve(
          opts.queryFn({ queryKey: opts.queryKey, signal: ac.signal }),
        );
        if (ac.signal.aborted) throw new DOMException("aborted", "AbortError");
        entry.data.value = out;
        entry.error.value = undefined;
        entry.status.value = "success";
        entry.dataUpdatedAt.value = Date.now();
        return out;
      } catch (err) {
        if (ac.signal.aborted) throw err;
        const more = attempt < maxAttempts;
        const allow =
          typeof retry === "function" ? retry(attempt, err as TError) : true;
        if (more && allow) {
          const delay =
            typeof retryDelay === "function"
              ? retryDelay(attempt, err as TError)
              : retryDelay;
          await new Promise((r) => setTimeout(r, delay));
          return exec();
        }
        entry.error.value = err as TError;
        entry.status.value = "error";
        entry.errorUpdatedAt.value = Date.now();
        throw err;
      }
    };

    const p = exec().finally(() => {
      entry.fetchStatus.value = "idle";
      if (entry.promise === p) entry.promise = undefined;
    });
    entry.promise = p;
    return p;
  }

  _addObserver(entry: QueryEntry, refetch: () => void): () => void {
    entry.observers.add(refetch);
    if (entry.gcHandle) {
      clearTimeout(entry.gcHandle);
      entry.gcHandle = undefined;
    }
    return () => {
      entry.observers.delete(refetch);
      if (entry.observers.size === 0) {
        const ttl = this.defaults.gcTime;
        entry.gcHandle = setTimeout(() => {
          if (entry.observers.size === 0) this.cache.delete(entry.hash);
        }, ttl);
      }
    };
  }

  /** True when no fetch is needed: data exists and is within staleTime. */
  _isFresh(entry: QueryEntry, staleTime: number): boolean {
    if (entry.status.peek() !== "success") return false;
    const at = entry.dataUpdatedAt.peek();
    if (at === 0) return false;
    return Date.now() - at <= staleTime;
  }

  /** Browser-only — server should never schedule background work. */
  static get isBrowser(): boolean {
    return IS_BROWSER;
  }
}

export function createQueryClient(opts?: ClientOptions): QueryClient {
  return new QueryClient(opts);
}

// ── helpers ────────────────────────────────────────────────────────────

/** Stable JSON hash that sorts object keys so { a: 1, b: 2 } and
 *  { b: 2, a: 1 } collapse to the same cache key. */
export function hashKey(key: QueryKey): string {
  return JSON.stringify(key, (_, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
      return sorted;
    }
    return v;
  });
}

function entryMatches(entry: QueryEntry, filter?: QueryFilter): boolean {
  if (!filter || !filter.queryKey) return true;
  if (filter.exact) return entry.hash === hashKey(filter.queryKey);
  const prefix = filter.queryKey;
  if (prefix.length > entry.queryKey.length) return false;
  return hashKey(entry.queryKey.slice(0, prefix.length)) === hashKey(prefix);
}

function defaultRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}
