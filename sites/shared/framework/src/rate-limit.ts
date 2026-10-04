// rate-limit.ts — fixed-window rate limiting for PRISM apps (Laravel RateLimiter).
//
//   const limiter = createRateLimiter({ store: memoryRateStore() });
//
//   const r = await limiter.check(clientKey, { max: 5, windowSecs: 60 });
//   if (!r.allowed) return new Response("Too many requests", {
//     status: 429, headers: { "retry-after": String(r.retryAfterSecs) },
//   });
//
//   // or run-if-allowed:
//   const out = await limiter.attempt(clientKey, { max: 5, windowSecs: 60 }, () => doThing());
//   if (!out.allowed) { /* throttled */ }
//
// Fixed-window: each key gets a counter that resets `windowSecs` after its first
// hit in the window. The store is pluggable — memoryRateStore() is per-V8-isolate
// (good for a single worker / tests); back it with a shared store for a fleet.

export interface RateLimitOptions {
  /** Max hits allowed within the window. */
  max: number;
  /** Window length in seconds. */
  windowSecs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Hits remaining in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window resets (and the caller may retry). */
  retryAfterSecs: number;
  /** Unix ms when the window resets. */
  resetAt: number;
}

export interface RateLimitStore {
  /** Register a hit against `key`; return the running count + window reset time.
   *  A new window starts on the first hit or after the previous window expired. */
  hit(key: string, windowSecs: number): { count: number; resetAt: number } | Promise<{ count: number; resetAt: number }>;
  /** Read the current count without incrementing (0 if none/expired). */
  peek(key: string): { count: number; resetAt: number } | Promise<{ count: number; resetAt: number }>;
  /** Clear a key's window. */
  reset(key: string): void | Promise<void>;
}

/** An in-process fixed-window store. Per-V8-isolate. */
export function memoryRateStore(): RateLimitStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  const current = (key: string): { count: number; resetAt: number } | null => {
    const w = windows.get(key);
    if (!w) return null;
    if (Date.now() >= w.resetAt) {
      windows.delete(key);
      return null;
    }
    return w;
  };
  return {
    hit(key, windowSecs) {
      const w = current(key);
      if (!w) {
        const fresh = { count: 1, resetAt: Date.now() + windowSecs * 1000 };
        windows.set(key, fresh);
        return { ...fresh };
      }
      w.count++;
      return { count: w.count, resetAt: w.resetAt };
    },
    peek(key) {
      const w = current(key);
      return w ? { count: w.count, resetAt: w.resetAt } : { count: 0, resetAt: 0 };
    },
    reset(key) {
      windows.delete(key);
    },
  };
}

export interface RateLimiter {
  /** Register a hit and report whether it's within the limit. */
  check(key: string, opts: RateLimitOptions): Promise<RateLimitResult>;
  /** Report the limit state WITHOUT registering a hit. */
  peek(key: string, opts: RateLimitOptions): Promise<RateLimitResult>;
  /** Run `fn` only if under the limit; the result carries `allowed` + the state. */
  attempt<T>(key: string, opts: RateLimitOptions, fn: () => T | Promise<T>): Promise<RateLimitResult & { result?: T }>;
  /** Clear a key (e.g. after a successful login). */
  reset(key: string): Promise<void>;
}

function toResult(count: number, resetAt: number, opts: RateLimitOptions): RateLimitResult {
  const allowed = count <= opts.max;
  const now = Date.now();
  return {
    allowed,
    limit: opts.max,
    remaining: Math.max(0, opts.max - count),
    retryAfterSecs: allowed ? 0 : Math.max(0, Math.ceil((resetAt - now) / 1000)),
    resetAt,
  };
}

export function createRateLimiter(opts: { store: RateLimitStore }): RateLimiter {
  const { store } = opts;
  return {
    async check(key, o) {
      const { count, resetAt } = await store.hit(key, o.windowSecs);
      return toResult(count, resetAt, o);
    },
    async peek(key, o) {
      const { count, resetAt } = await store.peek(key);
      // peek reflects the NEXT hit's verdict against the current count.
      return toResult(count, resetAt || Date.now(), o);
    },
    async attempt(key, o, fn) {
      const { count, resetAt } = await store.hit(key, o.windowSecs);
      const res = toResult(count, resetAt, o);
      if (!res.allowed) return res;
      return { ...res, result: await fn() };
    },
    async reset(key) {
      await store.reset(key);
    },
  };
}

/** Derive a limiter key from a request — the client IP (proxy headers) plus an
 *  optional bucket name, so different routes/actions limit independently. */
export function keyForRequest(request: Request, bucket = "default"): string {
  const h = request.headers;
  const ip =
    (h.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    h.get("x-real-ip") ||
    h.get("cf-connecting-ip") ||
    "unknown";
  return `${bucket}:${ip}`;
}
