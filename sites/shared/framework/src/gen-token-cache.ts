// Cross-isolate value cache with generation-token invalidation.
//
// Generalizes the shared/manage cm.ts pattern into a reusable helper. A plain
// TTL cache serves stale for up to TTL after an edit; this stays coherent across
// the whole bext V8 pool (~16 isolates) via a GENERATION TOKEN stored in the
// shared bext KV: every write bumps the token for its scope; every read first
// reads the token (one ~0.3ms loopback KV GET) and drops the local cache when it
// changed — so a post-write read on ANY isolate is fresh (zero stale-after-write
// window). Superior to TTL-only for edit-heavy / authenticated sites, and the
// safe on-ramp for caching tenant-scoped reads (designer / seo / manage).
//
// Safety / graceful degradation (mirrors cm.ts):
//   • fail-OPEN: if KV is unavailable a read BYPASSES the cache (live, correct,
//     slightly slower) and never populates an unverifiable entry — a transient
//     loopback hiccup can only fall back to a live read, never serve stale.
//   • a TTL backstops the rare case where a bump SET failed (KV write down).
//   • the writer's own isolate is invalidated synchronously in bump().
//   • cache keys are caller-provided and MUST fold in any per-user / per-scope
//     identity so entries can't leak across users/tenants; the helper never
//     caches `undefined` or a thrown error.
//
// The KV transport is injected (see GenTokenKv) so this stays dependency-free and
// unit-testable; point it at your site's bext-KV loopback helper — e.g.
// sites/shared/manage/src/lib/kv.ts's `bextKvGet`/`bextKvSet`:
//
//   const cache = createGenTokenCache({
//     appId: "designer-prism",
//     kv: { get: (k, t) => bextKvGet<string>(k, t), set: (k, v, t) => bextKvSet(k, v, t) },
//   });
//   // read (scope = the coherence domain; key folds in scope + identity + shape):
//   const data = await cache.read(tenantId, `${tenantId}|${proc}|${JSON.stringify(input)}`,
//                                 () => trpcQuery(proc, input, { tenantId }));
//   // after EVERY write to that scope (await before the post-write redirect):
//   await cache.bump(tenantId);

/** Shared-KV transport. Implementations MUST NOT throw — return null / false on
 *  error (a throw is caught and treated as "KV unavailable" → fail open). */
export interface GenTokenKv {
  /** Read a string. `null` = miss OR KV unavailable. */
  get(key: string, timeoutMs: number): Promise<string | null>;
  /** Write a string. Return `false` if the write failed. */
  set(key: string, value: string, timeoutMs: number): Promise<boolean>;
}

export interface GenTokenCacheOptions {
  /** Namespaces the shared-KV generation-token key (use your app/site id). */
  appId: string;
  /** Shared-KV transport (inject your loopback bext-KV helper). */
  kv: GenTokenKv;
  /** Entry TTL backstop (ms). Default 30_000. */
  ttlMs?: number;
  /** Max entries before ~10% oldest are evicted. Default 2000. */
  cap?: number;
  /** Gen-check GET timeout (ms) — must fail open fast. Default 300. */
  genGetTimeoutMs?: number;
  /** Gen-token SET timeout (ms). Default 800. */
  genSetTimeoutMs?: number;
  /** Injectable clock (ms). Default `Date.now`. For tests; leave unset in prod. */
  now?: () => number;
}

export interface GenTokenCache {
  /**
   * Read-through cache. `scope` = a coherence domain (e.g. `${tenantId}:${siteId}`,
   * or the appId for a single-scope site) — a `bump(scope)` drops exactly its
   * entries. `key` = the FULL cache key; it MUST fold in scope + any per-user
   * identity + the request shape. `fetcher` runs on a miss, or live (bypass) when
   * KV can't verify freshness. Never caches `undefined` or a thrown error.
   */
  read<T>(scope: string, key: string, fetcher: () => Promise<T>): Promise<T>;
  /**
   * Bump `scope`'s generation so EVERY isolate drops its entries on the next
   * read. Await this before a post-write redirect for a zero stale-after-write
   * window. Best-effort on the shared SET (TTL backstops a failure); the local
   * isolate is always invalidated synchronously.
   */
  bump(scope: string): Promise<void>;
  /** Drop this isolate's entries for one scope (no shared bump). */
  dropScope(scope: string): void;
  /** Clear this isolate's whole cache + seen generations (manual bust). */
  flush(): void;
}

export function createGenTokenCache(opts: GenTokenCacheOptions): GenTokenCache {
  const ttlMs = opts.ttlMs ?? 30_000;
  const cap = opts.cap ?? 2000;
  const genGetTimeoutMs = opts.genGetTimeoutMs ?? 300;
  const genSetTimeoutMs = opts.genSetTimeoutMs ?? 800;
  const now = opts.now ?? (() => Date.now());

  const cache = new Map<string, { v: unknown; exp: number; scope: string }>();
  const seenGen = new Map<string, string>(); // genKey -> last token this isolate saw
  let bumpN = 0;

  const genKeyFor = (scope: string) => `bxc:gen:${opts.appId}:${scope}`;

  function dropScope(scope: string): void {
    for (const [k, e] of cache) if (e.scope === scope) cache.delete(k);
  }

  // True if the local cache is SAFE TO USE for `scope`: reads the shared token
  // and, when it changed, drops the scope's local entries. FALSE when KV is
  // unavailable (caller must bypass → live read). Seeds an "init" token when
  // absent (the seed SET doubles as a KV-liveness probe). Never throws.
  async function genFresh(scope: string): Promise<boolean> {
    const gk = genKeyFor(scope);
    try {
      let cur = await opts.kv.get(gk, genGetTimeoutMs);
      if (cur == null) {
        if (!(await opts.kv.set(gk, "init", genSetTimeoutMs))) return false; // KV down → bypass
        cur = "init";
      }
      if (seenGen.get(gk) !== cur) {
        dropScope(scope);
        seenGen.set(gk, cur);
      }
      return true;
    } catch {
      return false; // any KV error → fail open (live read, never stale)
    }
  }

  async function read<T>(scope: string, key: string, fetcher: () => Promise<T>): Promise<T> {
    const fresh = await genFresh(scope);
    if (fresh) {
      const e = cache.get(key);
      if (e) {
        if (e.exp > now()) return e.v as T;
        cache.delete(key);
      }
    }
    const v = await fetcher(); // a throw propagates → nothing cached
    if (fresh && v !== undefined) {
      if (cache.size >= cap) {
        // Evict ~10% oldest (Map iterates in insertion order).
        let n = Math.ceil(cap * 0.1);
        for (const k of cache.keys()) {
          cache.delete(k);
          if (--n <= 0) break;
        }
      }
      cache.set(key, { v, exp: now() + ttlMs, scope });
    }
    return v;
  }

  async function bump(scope: string): Promise<void> {
    const gk = genKeyFor(scope);
    // Leading letter keeps the token a STRING through a JSON-parsing KV get (a
    // bare numeric token would parse to a Number and never === the stored string,
    // so the gen-check would see a change on every read → the cache never hits).
    const token = `g${now()}.${++bumpN}`;
    dropScope(scope); // invalidate this isolate synchronously first
    seenGen.set(gk, token);
    try {
      if (!(await opts.kv.set(gk, token, genSetTimeoutMs))) {
        await opts.kv.set(gk, token, genSetTimeoutMs); // retry once; TTL backstops
      }
    } catch {
      // best-effort — a failed shared bump is backstopped by the entry TTL; the
      // local isolate is already invalidated above.
    }
  }

  return {
    read,
    bump,
    dropScope,
    flush() {
      cache.clear();
      seenGen.clear();
    },
  };
}
