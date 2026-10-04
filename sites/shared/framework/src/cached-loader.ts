// Loader read-through cache.
//
// Wrap a PRISM page `loader` so its return value is cached PROCESS-WIDE —
// shared across every V8 render worker, and tag-invalidatable via
// `revalidateTag()` — keyed by host + route path + route params + sorted
// search params. Repeat renders of the same page then skip the loader.
//
// The win is biggest for loaders that fan out to a data store: Server-Timing
// shows `loader;dur=40-380ms` on real pages (the bulk of the request), while
// the framework's render is already cheap (`render;dur` ~6-15ms, fold pass).
// A cache hit makes the loader ~0ms.
//
// Backed by the same process-shared `__bextCacheGet`/`__bextCacheSet` store
// the `"use cache"` directive uses (bext_core fetch_cache: TTL + tags). No
// per-isolate duplication (unlike a JS module-level Map), so a cold worker
// reuses a warm worker's entry.
//
// OPT-IN and KEY-SAFE BY DESIGN: the cache key includes the request HOST
// (so multi-tenant-by-host sites like brest.ma-vie-numerique.fr don't
// cross-serve), but deliberately EXCLUDES cookies and other request headers,
// so two users on the same host share an entry. Only wrap loaders whose
// output does NOT vary per user. If a loader varies on something else (e.g.
// a locale from a header), fold it in via `config.vary`. Per-user / per-
// session loaders must NOT be wrapped.

export interface LoaderCacheConfig {
  /** TTL in seconds. 0 / omitted falls back to the 60s use-cache default. */
  ttl?: number;
  /** Cache tags for `revalidateTag()` invalidation. */
  tags?: string[];
  /**
   * Extra cache-key material. The key already covers host + route path +
   * route params + sorted search params; return anything else the loader's
   * output depends on. NEVER return per-user data here unless you intend
   * per-user entries (you almost never do).
   */
  vary?: (args: LoaderArgs) => string;
}

type LoaderArgs = { request: Request; params?: Record<string, string> };

/** FNV-1a 32-bit. Two seeds give a 64-bit key for the (hi, lo) bridge call. */
function lcHash32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * @example
 *   import { cachedLoader } from "@bext-stack/framework";
 *
 *   export const loader = cachedLoader(
 *     { ttl: 60, tags: ["projects"] },
 *     async ({ params }) => ({ project: await getProjectBySlug(params!.slug) }),
 *   );
 */
export function cachedLoader<A extends LoaderArgs, R>(
  config: LoaderCacheConfig,
  fn: (args: A) => Promise<R> | R,
): (args: A) => Promise<R> {
  const ttlMs = Math.max(0, Math.floor((config.ttl ?? 0) * 1000));
  const tagsJson = JSON.stringify(config.tags ?? []);
  const wrapped = async (args: A): Promise<R> => {
    const g = globalThis as unknown as {
      __bextCacheGet?: (hi: number, lo: number) => string | null;
      __bextCacheSet?: (hi: number, lo: number, json: string, ttlMs: number, tagsJson: string) => void;
    };
    const get = g.__bextCacheGet;
    const set = g.__bextCacheSet;
    // Only cache idempotent GET renders; never replay a POST / action load.
    const method = String((args.request as { method?: string })?.method ?? "GET").toUpperCase();
    if (typeof get !== "function" || typeof set !== "function" || method !== "GET") {
      return await fn(args);
    }

    // Stable, collision-safe key: host + path + sorted params + sorted query
    // (+ caller vary), JSON-encoded so no component can forge a delimiter.
    // Includes host (multi-tenant safety); excludes cookies/headers by design.
    let keyStr: string;
    try {
      const u = new URL(args.request.url);
      const sp = Array.from(u.searchParams.entries()).sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
      );
      const p = args.params ?? {};
      const pp = Object.keys(p).sort().map((k) => [k, p[k]]);
      const extra = config.vary ? config.vary(args) : "";
      keyStr = "lc:" + JSON.stringify([u.host, u.pathname, pp, sp, extra]);
    } catch {
      // Can't derive a key (no/invalid URL) — don't cache.
      return await fn(args);
    }

    const hi = lcHash32(keyStr, 0x811c9dc5);
    const lo = lcHash32(keyStr, 0x9e3779b9);

    try {
      const cached = get(hi, lo);
      if (cached != null) {
        return JSON.parse(cached) as R;
      }
    } catch {
      /* corrupt entry / bad JSON — fall through and recompute */
    }

    const result = await fn(args);

    // Never cache a thrown-then-returned Response (redirects/404) or nullish.
    if (result != null && !(result instanceof Response)) {
      try {
        set(hi, lo, JSON.stringify(result), ttlMs, tagsJson);
      } catch {
        /* best-effort: serialisation or store failure must not break render */
      }
    }
    return result;
  };
  // Marker so the runtime's automatic anonymous-GET loader cache skips
  // loaders that already manage their own caching (avoids double-caching
  // with mismatched TTLs).
  (wrapped as { __bextCachedLoader?: boolean }).__bextCachedLoader = true;
  return wrapped;
}
