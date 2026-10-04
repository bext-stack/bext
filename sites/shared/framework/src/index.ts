// @bext-stack/framework — the bext template framework runtime.

// Types
export type {
  AuthUser,
  Page,
  PageMap,
  PagesModule,
  RenderContext,
  TemplateModule,
  BextRequest,
  BextResponse,
  CacheHint,
  RouteContext,
  RouteHandler,
  SeoConfig,
  SiteConfig,
} from "./types";

// Response helpers
export { json, html, text, xml, redirect, notFound, cached } from "./response";

// Loader read-through cache — wrap a page `loader` so its return value is
// cached process-wide (shared across workers, tag-invalidatable) keyed by
// route + params + query. Opt-in; for loaders whose output is not per-user.
export { cachedLoader } from "./cached-loader";
export type { LoaderCacheConfig } from "./cached-loader";

// SEO
export { robotsTxt, sitemapXml } from "./seo";

// JSX
export { h, Fragment, Raw, escapeHtml, renderChild } from "./jsx";
export type { Renderable } from "./jsx";
// Out-of-band safe-HTML brand (replaces the in-band \x01 sentinel for the
// sync path — zerostrip). `safe()` marks vetted HTML; `isSafe()` narrows.
export { SafeHtml, safe, isSafe } from "./jsx";

// Auto-escaping tagged template + passthrough (T1.2 — additive; `htmlTpl`
// NOT `html`, which is the BextResponse helper above; `rawHtml` lowercase,
// distinct from the `Raw` JSX component).
export { htmlTpl, safeHtml, rawHtml } from "./html-tpl";

// Component-to-string test/preview helper (awaits async + streaming output).
export { renderToString } from "./render-component";

// Component-authoring type aliases (reuse the `Renderable` re-exported above).
export type { PropsWithChildren, Component } from "./jsx-types";

// Streaming + Suspense
export {
  Suspense,
  renderToStream,
  SUSPENSE_CLIENT_RUNTIME,
} from "./streaming";

// Server-action forms
export { Form, FORM_CLIENT_RUNTIME } from "./form";
export type { FormProps } from "./form";

// Islands
export { island, islandScript } from "./island";

// Server Islands (steal from Astro) — keep the page shell ISR-cached while a
// personalized/dynamic fragment loads separately. See plan/bun-steals/.
export { ServerIsland, serverIslandScript, readServerIslandProps, encodeServerIslandProps } from "./server-island";
export type { ServerIslandProps } from "./server-island";

// Partytown — run third-party scripts in a web worker, off the main thread
// (steal from Builder.io Partytown). See plan/bun-steals/.
export { Partytown, partytownScript, partytownSrc } from "./partytown";
export type { PartytownConfig } from "./partytown";

// PRISM helpers (re-exported for convenience). `redirect` and
// `notFound` are already exported from `./response` above; expose
// only the remaining serve-side helpers here to avoid duplicate
// export errors (the bundler — Bun's esbuild — refuses ambiguous
// re-exports of the same name from two modules).
export { Redirect, NotFound, revalidatePath, revalidateTag } from "./serve";

// Assets
export { stylesheet, script, preload, preconnect, loadManifest, asset } from "./assets";

// Router
export { createRouter, defineRoutes, Router } from "./router";
export type { PageComponent, LayoutComponent, ApiHandler, RouteTree, RouteNode } from "./router";

// Object storage (S3 / R2 / MinIO via [storage] in bext.config.toml).
export {
  presign,
  presignGet,
  presignPut,
  presignDelete,
  presignHead,
  publicUrl,
  deleteObject,
  head,
  uploadDirect,
} from "./storage";
export type { PresignMethod, PresignOptions, HeadResult } from "./storage";

// Injection-safe tagged-template SQL over the SDK's SQLite bridge (steal #3
// from Bun.SQL — see plan/bun-steals/). `sql\`...\`` → { text, params }.
export { sql, database, SQLITE_DIALECT, POSTGRES_DIALECT, SqlQuery } from "./sql";
export type { SqlDialect, SqlTag, BextDb } from "./sql";

// Declarative streaming HTML rewrite (lol-html via `__htmlRewrite`) — CSP
// nonces, CDN URL rewrites, fragment injection (steal from Bun's HTMLRewriter).
export { htmlRewrite } from "./bridge";
export type { HtmlRule } from "./bridge";
