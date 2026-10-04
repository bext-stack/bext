// partytown.ts — run third-party scripts in a web worker (steal: Builder.io
// Partytown, also a Bun-ecosystem favorite). The vendored runtime is served from
// `config.lib` (default "/~partytown/"); author marks scripts
// <script type="text/partytown">…</script> and Partytown relocates them to a
// worker, proxying their DOM access back via a service worker. Heavy 3rd-party
// JS (analytics, tag managers) leaves the main thread → better TTI, and inline
// allowances drop out of your CSP.
//
// Setup: vendor Partytown's lib into the site's `public/~partytown/` (the four
// files: partytown.js, partytown-sw.js, partytown-atomics.js, partytown-media.js),
// then render <Partytown/> once (its config must precede any partytown script).

import { safe, SafeHtml } from "./jsx";

export interface PartytownConfig {
  /** Path the runtime is served from. Default "/~partytown/". */
  lib?: string;
  /** main-thread globals to forward into the worker, e.g. ["dataLayer.push", "gtag"]. */
  forward?: string[];
  /** Use Partytown's debug build (verbose logging). */
  debug?: boolean;
}

/** Emit the Partytown config + bootstrap. Render ONCE, before any
 *  `<script type="text/partytown">`. Returns branded SafeHtml. */
export function Partytown(config: PartytownConfig = {}): SafeHtml {
  const cfg = { lib: "/~partytown/", forward: [] as string[], ...config };
  const lib = cfg.lib.endsWith("/") ? cfg.lib : cfg.lib + "/";
  // Config first (the bootstrap reads window.partytown), then the bootstrap.
  return safe(
    `<script>window.partytown=${JSON.stringify(cfg)};</script>` +
      `<script src="${lib}partytown.js"></script>`,
  );
}

/** Wrap inline third-party JS so it runs in the Partytown worker. The caller is
 *  responsible for the JS not containing `</script>`. */
export function partytownScript(js: string): SafeHtml {
  return safe(`<script type="text/partytown">${js}</script>`);
}

/** Load an external third-party script by URL in the Partytown worker. */
export function partytownSrc(src: string): SafeHtml {
  return safe(`<script type="text/partytown" src="${src.replace(/"/g, "&quot;")}"></script>`);
}
