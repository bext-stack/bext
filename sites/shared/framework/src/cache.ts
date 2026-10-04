/** Fragment-cache boundaries for SSR.
 *
 * `<ISR>` wraps a JSX subtree (passed as a function child returning a
 * string of HTML) with a TTL-bounded cache. Repeated renders within
 * the freshness window return the cached HTML without re-running the
 * function. Stores survive across requests because the cache lives on
 * the bext-server side via the V8 host bridge.
 *
 * Phase 5 of `plan/granular-isr-streaming/`.
 *
 * Usage:
 *
 * ```tsx
 * import { ISR } from "@bext-stack/framework/cache";
 *
 * <ISR cacheKey="featured-products" ttl={60} swr={30}>
 *   {async () => {
 *     const products = await fetchFeaturedProducts();
 *     return `<ul>${products.map(p => `<li>${escapeHtml(p.name)}</li>`).join("")}</ul>`;
 *   }}
 * </ISR>
 * ```
 *
 * The function child must return a string of HTML — caller is
 * responsible for sanitizing untrusted data (the returned HTML lands
 * verbatim in the parent stream via `Raw`). Async functions are
 * supported.
 *
 * Composition:
 *  - `<ISR>` inside `<Suspense>` works — Suspense yields its fallback
 *    immediately, then resolves the ISR fragment (cache hit or fresh
 *    render) in the background and emits the real content via the
 *    out-of-order template+swap protocol.
 *  - `<ISR>` inside a streaming route works — the surrounding chunks
 *    flow as usual; the ISR fragment lands as a single chunk once
 *    resolved.
 *  - `<ISR>` inside an ISR-cached page is allowed but the inner TTL
 *    should be ≤ the outer page TTL (otherwise the inner cache is
 *    dead weight — outer page renders less frequently than the inner
 *    refreshes).
 */

import { Raw } from "./jsx";

declare global {
  // eslint-disable-next-line no-var
  var __bextIsrFragmentLookup:
    | ((cacheKey: string, routePath: string, ttlSecs: number, swrSecs: number) => string | null)
    | undefined;
  // eslint-disable-next-line no-var
  var __bextIsrFragmentStore:
    | ((cacheKey: string, routePath: string, html: string, ttlSecs: number, swrSecs: number) => void)
    | undefined;
  // eslint-disable-next-line no-var
  var __bextRevalidateTag: ((tag: string) => number) | undefined;
  // eslint-disable-next-line no-var
  var __bextRoutePath: string | undefined;
}

/** Drop every cached `fetch(url, { next: { tags: [...] } })` entry
 *  tagged with `tag`. Mirrors Next.js's `revalidateTag` from
 *  `next/cache` — server-only.
 *
 *  Returns the number of cache entries that were invalidated. 0
 *  means the tag was never associated with any entry, which is also
 *  the expected outcome on a fresh process before any tagged fetch
 *  has happened.
 *
 *  ```ts
 *  // app/api/products/route.ts
 *  import { revalidateTag } from "@bext-stack/framework/cache";
 *
 *  export async function POST(req: Request) {
 *    await db.update(...);
 *    revalidateTag("products"); // every fetch tagged "products" is now stale
 *    return new Response("ok");
 *  }
 *  ```
 *
 *  Cross-worker propagation: today the invalidation is process-local.
 *  Worker fan-out via Tier 4.3's PURGE wire frame is a follow-up.
 *  Plan: `plan/granular-isr-streaming/` Phase 6 / 04-interop-matrix.md.
 */
export function revalidateTag(tag: string): number {
  const fn = globalThis.__bextRevalidateTag;
  if (typeof fn !== "function") {
    return 0;
  }
  try {
    return Number(fn(String(tag))) | 0;
  } catch {
    return 0;
  }
}

export interface ISRProps {
  /** Stable cache key. Must be unique within `routePath` (or globally
   *  if `routePath` is left at its default). Disambiguate per-instance
   *  by including dynamic context in the string — e.g.
   *  `"featured-products:" + locale`. */
  cacheKey: string;
  /** Freshness window in seconds. Default: 60. */
  ttl?: number;
  /** Stale-while-revalidate window in seconds, layered on top of
   *  `ttl`. During this window the cached HTML is still served while a
   *  background refresh fires. Default: 0 (no SWR). */
  swr?: number;
  /** Optional override for the route path used in key derivation.
   *  Defaults to `globalThis.__bextRoutePath` when set by the
   *  dispatcher, else "/". Pass explicitly when you want the same
   *  cacheKey to be shared across multiple routes. */
  routePath?: string;
  /** Function returning the HTML for the cached subtree. The returned
   *  string is injected verbatim via `Raw` — caller is responsible for
   *  sanitization. Async functions are supported (return
   *  `Promise<string>`). */
  children: () => string | Promise<string>;
}

/** ISR fragment-cache boundary. See module doc. */
export async function ISR(props: ISRProps): Promise<unknown> {
  const cacheKey = String(props.cacheKey ?? "");
  if (!cacheKey) {
    // Empty key → no caching. Render and return.
    const html = await Promise.resolve(callChild(props.children));
    return Raw({ html });
  }
  const ttl = numberOr(props.ttl, 60);
  const swr = numberOr(props.swr, 0);
  const routePath =
    props.routePath ??
    (typeof globalThis.__bextRoutePath === "string" ? globalThis.__bextRoutePath : "/");

  const lookup = globalThis.__bextIsrFragmentLookup;
  if (typeof lookup === "function") {
    try {
      const cached = lookup(cacheKey, routePath, ttl, swr);
      if (typeof cached === "string") {
        return Raw({ html: cached });
      }
    } catch {
      // Bridge errors fall through to live render.
    }
  }

  const html = await Promise.resolve(callChild(props.children));
  const store = globalThis.__bextIsrFragmentStore;
  if (typeof store === "function") {
    try {
      store(cacheKey, routePath, html, ttl, swr);
    } catch {
      // Best-effort store; render still proceeds.
    }
  }
  return Raw({ html });
}

function callChild(child: ISRProps["children"]): string | Promise<string> {
  if (typeof child === "function") {
    return child();
  }
  return String(child ?? "");
}

function numberOr(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return fallback;
}
