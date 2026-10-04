// server-island.ts — Astro-style Server Islands for bext/PRISM.
// (steal from Astro server islands — see plan/bun-steals/)
//
// THE PROBLEM: today any personalized fragment (logged-in menu, cart count, an
// A/B block) forces the whole route to `force-dynamic` → no ISR caching at all.
//
// THE FIX: keep the page shell aggressively ISR-cached and render the dynamic
// hole separately. `<ServerIsland src="/_frag/user-menu" />` emits a cacheable
// placeholder in the page; on the client a tiny loader fetches `src` (a
// force-dynamic PRISM route that reads the session) and swaps the fragment in.
// So "one personalized block" no longer un-caches the entire page.
//
// Pure framework — no server change. The placeholder is plain HTML baked into
// the ISR-cached page; the loader is a self-guarding inline script (zero-config);
// the fragment is just another PRISM route.

import { safe, SafeHtml } from "./jsx";

export interface ServerIslandProps {
  /** URL of a route/handler that renders this island's HTML fragment
   *  server-side. Typically a force-dynamic PRISM route that reads cookies. */
  src: string;
  /** Optional props passed to `src` as a `?__props=` query param. NOT encrypted
   *  — the fragment route must treat them as untrusted; read the session for
   *  anything sensitive. (Encryption is a planned hardening.) */
  props?: Record<string, unknown>;
  /** HTML shown until the fragment loads (a skeleton/spinner). */
  fallback?: SafeHtml | string;
  /** When to fetch: "load" (default), "visible" (on scroll-into-view), or
   *  "idle" (requestIdleCallback). */
  on?: "load" | "visible" | "idle";
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** URL-safe encode of props JSON. The fragment route decodes via
 *  `JSON.parse(decodeURIComponent(searchParams.__props))`. */
export function encodeServerIslandProps(props: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(props));
}

// Self-guarding inline loader: emitted with every ServerIsland (only the first
// runs, via the `__bextSI` guard) so the feature needs no layout wiring. Exposes
// `window.__bextScanServerIslands` so SPA-nav (client.ts afterSwap) can re-scan.
const LOADER = `<script>(function(){if(window.__bextSI)return;window.__bextSI=1;function load(el){if(el.__b)return;el.__b=1;var src=el.getAttribute('data-src');if(!src)return;var p=el.getAttribute('data-props');var u=src+(p?((src.indexOf('?')<0?'?':'&')+'__props='+p):'');fetch(u,{headers:{'x-bext-server-island':'1'},credentials:'same-origin'}).then(function(r){return r.text();}).then(function(h){el.innerHTML=h;el.querySelectorAll('script').forEach(function(s){var n=document.createElement('script');if(s.src)n.src=s.src;else n.textContent=s.textContent;document.body.appendChild(n);});el.dispatchEvent(new CustomEvent('bext:island-loaded',{bubbles:true}));}).catch(function(e){console.warn('server-island',src,e);});}function scan(){document.querySelectorAll('bext-server-island').forEach(function(el){var on=el.getAttribute('data-on')||'load';if(on==='visible'&&'IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting){io.disconnect();load(el);}});});io.observe(el);}else if(on==='idle'&&window.requestIdleCallback){requestIdleCallback(function(){load(el);});}else{load(el);}});}window.__bextScanServerIslands=scan;if(document.readyState!=='loading')scan();else document.addEventListener('DOMContentLoaded',scan);})();</script>`;

/**
 * Render a server island: a cacheable placeholder + a deferred client fetch of
 * `src`. The enclosing page stays ISR-cacheable; the fragment loads dynamically.
 */
export function ServerIsland(p: ServerIslandProps): SafeHtml {
  const fb =
    p.fallback == null ? "" : typeof p.fallback === "string" ? p.fallback : String(p.fallback);
  const propsAttr = p.props ? ` data-props="${escAttr(encodeServerIslandProps(p.props))}"` : "";
  const on = p.on === "visible" || p.on === "idle" ? p.on : "load";
  return safe(
    `<bext-server-island data-src="${escAttr(p.src)}" data-on="${on}"${propsAttr}>${fb}</bext-server-island>` +
      LOADER,
  );
}

/** Optional: emit the loader once in a layout instead of relying on the
 *  per-island self-guarding copy (identical guard, so mixing is safe). */
export function serverIslandScript(): SafeHtml {
  return safe(LOADER);
}

/** Server-side helper for the FRAGMENT route: decode `?__props=` back to an
 *  object (returns `{}` when absent/invalid). */
export function readServerIslandProps(search: URLSearchParams | string): Record<string, unknown> {
  const raw =
    typeof search === "string"
      ? new URLSearchParams(search).get("__props")
      : search.get("__props");
  if (!raw) return {};
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return {};
  }
}
