// kv.ts — a key/value cache facade for PRISM apps (Laravel's Cache::remember).
//
// `createCache(...).remember(key, ttl, fn)` and friends over a pluggable string
// store. The default store is bext's SDK KV over loopback; inject `memoryStore()`
// for tests or short-lived per-request/per-isolate caching. Values are
// JSON-encoded, so you cache typed objects, not just strings.
//
// (This lives in its own module rather than in `cache.ts` — that one is the
// SSR `<ISR>` HTML-fragment cache. This caches arbitrary VALUES.)
//
//   const cache = createCache({ store: kvStore({ appId: "my-site" }) });
//   const report = await cache.remember("report:monthly", 300, () => buildReport());
//   await cache.put("flag", true, 60);
//   await cache.get<boolean>("flag");   // true | null

import { sdkWireHeaders } from "./sdk";

export interface CacheStore {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttlSecs?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface Cache {
  /** Get a value (JSON-decoded), or null if absent/expired. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Store a value with an optional TTL in seconds. */
  put<T = unknown>(key: string, value: T, ttlSecs?: number): Promise<void>;
  /** Is a value present? */
  has(key: string): Promise<boolean>;
  /** Remove a value. */
  forget(key: string): Promise<void>;
  /** Get, or compute + store + return (the workhorse). */
  remember<T>(key: string, ttlSecs: number, factory: () => T | Promise<T>): Promise<T>;
  /** Get then forget (one-shot read). */
  pull<T = unknown>(key: string): Promise<T | null>;
  /** Store only if absent; returns true when written. */
  add<T = unknown>(key: string, value: T, ttlSecs?: number): Promise<boolean>;
}

/** In-process TTL store (a Map). Per-V8-isolate — good for request-scoped /
 *  short-lived caching and tests; use `kvStore` for cross-request/process. */
export function memoryStore(): CacheStore {
  const map = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return null;
      if (e.expiresAt !== null && Date.now() > e.expiresAt) {
        map.delete(key);
        return null;
      }
      return e.value;
    },
    set(key, value, ttlSecs) {
      map.set(key, { value, expiresAt: ttlSecs ? Date.now() + ttlSecs * 1000 : null });
    },
    delete(key) {
      map.delete(key);
    },
  };
}

/** A store backed by bext's SDK KV over loopback (cross-request, shared). */
export function kvStore(opts: { appId: string; endpoint?: string }): CacheStore {
  const base = opts.endpoint ?? "http://127.0.0.1/__bext/sdk";
  const headers = {
    "content-type": "application/json",
    "X-Bext-App-Id": opts.appId,
    ...sdkWireHeaders(opts.appId),
  };
  return {
    // The SDK KV routes are POST-only and read `ttl`. The server stores the
    // JSON encoding of `value`, so `get` decodes exactly one layer to hand
    // back the string that was `set`.
    async get(key) {
      const r = await fetch(`${base}/kv/get`, { method: "POST", headers, body: JSON.stringify({ key }) });
      if (!r.ok) return null;
      const j: any = await r.json().catch(() => ({}));
      const raw = j?.value;
      if (raw === null || raw === undefined) return null;
      if (typeof raw !== "string") return JSON.stringify(raw);
      try {
        const once = JSON.parse(raw);
        return typeof once === "string" ? once : raw;
      } catch {
        return raw;
      }
    },
    async set(key, value, ttlSecs) {
      await fetch(`${base}/kv/set`, { method: "POST", headers, body: JSON.stringify({ key, value, ttl: ttlSecs || undefined }) });
    },
    async delete(key) {
      await fetch(`${base}/kv/delete`, { method: "POST", headers, body: JSON.stringify({ key }) });
    },
  };
}

/** A key/value cache over a {@link CacheStore}. */
export function createCache(opts: { store: CacheStore; prefix?: string }): Cache {
  const store = opts.store;
  const k = (key: string): string => (opts.prefix ? `${opts.prefix}:${key}` : key);

  const cache: Cache = {
    async get(key) {
      const raw = await store.get(k(key));
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw as unknown;
      }
    },
    async put(key, value, ttlSecs) {
      await store.set(k(key), JSON.stringify(value), ttlSecs);
    },
    async has(key) {
      return (await store.get(k(key))) != null;
    },
    async forget(key) {
      await store.delete(k(key));
    },
    async remember(key, ttlSecs, factory) {
      const hit = await cache.get(key);
      if (hit !== null) return hit as any;
      const value = await factory();
      await cache.put(key, value, ttlSecs);
      return value;
    },
    async pull(key) {
      const v = await cache.get(key);
      if (v !== null) await cache.forget(key);
      return v as any;
    },
    async add(key, value, ttlSecs) {
      if (await cache.has(key)) return false;
      await cache.put(key, value, ttlSecs);
      return true;
    },
  };
  return cache;
}
