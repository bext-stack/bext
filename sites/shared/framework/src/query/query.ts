// Reactive query observer. Returns Signal-typed accessors so signals
// JSX can read .value and re-render on cache writes for free.
//
// Lifecycle:
//   1. ensureEntry — find or create the cache entry.
//   2. addObserver — register so invalidate() can wake us; cancels GC.
//   3. on browser, kick off a fetch if entry is missing or stale.
//   4. expose Signals for data/error/status; computed flags for derived
//      booleans (isLoading etc).
//
// The same component code runs on server (signals SSR) and client
// (signals hydrate). On the server we skip the auto-fetch — prefetched
// data is already in the entry via hydrate(); anything not prefetched
// renders in its pending state (the JSX side decides how to display it).

import { computed, type Signal } from "../signals";
import {
  QueryClient,
  type FetchStatus,
  type QueryKey,
  type QueryOptions,
  type QueryStatus,
} from "./client";

export interface QueryResult<TData, TError = Error> {
  data: Signal<TData | undefined>;
  error: Signal<TError | undefined>;
  status: Signal<QueryStatus>;
  fetchStatus: Signal<FetchStatus>;
  dataUpdatedAt: Signal<number>;
  isLoading: Signal<boolean>;
  isFetching: Signal<boolean>;
  isSuccess: Signal<boolean>;
  isError: Signal<boolean>;
  isStale: Signal<boolean>;
  refetch: () => Promise<TData>;
  /** Tear down the observer + any refetchInterval. */
  dispose: () => void;
}

export function createQuery<
  TData,
  TError = Error,
  TKey extends QueryKey = QueryKey,
>(
  client: QueryClient,
  opts: QueryOptions<TData, TError, TKey>,
): QueryResult<TData, TError> {
  const entry = client._ensureEntry<TData, TError>(opts.queryKey, opts.initialData);

  const refetch = () => client._runFetch(entry, opts);

  const staleTime = opts.staleTime ?? client.defaults.staleTime;
  const enabled = opts.enabled !== false;

  const unobserve = client._addObserver(entry as never, refetch as never);

  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  if (QueryClient.isBrowser && enabled) {
    if (!client._isFresh(entry as never, staleTime)) {
      void refetch().catch(() => undefined);
    }
    if (opts.refetchInterval && opts.refetchInterval > 0) {
      intervalHandle = setInterval(() => {
        void refetch().catch(() => undefined);
      }, opts.refetchInterval);
    }
  }

  const isStale = computed(() => {
    const at = entry.dataUpdatedAt.value;
    return at === 0 || Date.now() - at > staleTime;
  });
  const isLoading = computed(() => entry.status.value === "pending");
  const isFetching = computed(() => entry.fetchStatus.value === "fetching");
  const isSuccess = computed(() => entry.status.value === "success");
  const isError = computed(() => entry.status.value === "error");

  return {
    data: entry.data,
    error: entry.error,
    status: entry.status,
    fetchStatus: entry.fetchStatus,
    dataUpdatedAt: entry.dataUpdatedAt,
    isLoading,
    isFetching,
    isSuccess,
    isError,
    isStale,
    refetch,
    dispose() {
      if (intervalHandle) clearInterval(intervalHandle);
      unobserve();
    },
  };
}
