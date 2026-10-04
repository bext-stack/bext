/**
 * PRISM — Progressive Rendering with Incremental Selective Mounting
 *
 * bext's zero-config React SSR engine. Drop a `page.tsx` in `src/app/`,
 * add `"use client"` where you need interactivity, and PRISM handles:
 *
 *   Discover — Walks src/app/ for pages, detects "use client" directives
 *   SSR     — Server-renders every page via React renderToString()
 *   Split   — Batches client pages in one build; React becomes a shared vendor chunk
 *   Hydrate — Injects hydrateRoot() entry + modulepreload hints
 *   Watch   — Tracks deep import dependencies; rebuilds only what changed
 *   Cache   — In-memory HTML cache in production mode
 *   Compress — Gzip with caching for HTML, JS, CSS
 *
 * Usage:
 *   import { createServer } from "@bext-stack/framework/serve";
 *   createServer();                          // zero-config
 *   createServer({ port: 3024, mode: "production" });
 *
 * @module @bext-stack/framework/serve
 * @see https://docs.bext.dev/prism
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { resolve, join, dirname } from "path";
import { buildCSS } from "./tailwind";
import { injectRouteCss } from "./route-css";
import {
  getInspectScript,
  INSPECT_HEADER,
  inspectHeaderValue,
  isInspectRequest,
} from "./inspect";
import { gzipSync } from "zlib";

// ── Public API ──────────────────────────────────────────────────────────────

export interface PrismOptions {
  /** Port to listen on. Default: process.env.PORT || 3000. */
  port?: number;
  /** Root directory of the site. Default: auto-detect from cwd. */
  root?: string;
  /** "development" | "production". Default: auto from NODE_ENV. */
  mode?: "development" | "production";
  /** Auth integration — injected server-side on non-hydrated pages. */
  auth?: {
    getUser: (request: Request) => Promise<any>;
    navAuthHtml: (user: any) => string;
  };
  /** Tailwind CSS configuration. */
  css?: {
    extraSources?: string[];
    extraCSS?: string[];
  };
  /** External modules to exclude from client bundles. */
  external?: string[];
  /** Import patterns to stub as empty modules (for components that crash the bundler). */
  stub?: string[];
  /** Directory names that are invisible in URL paths (e.g., ["default"] for module-based routing). */
  invisibleSegments?: string[];
  /** TLS configuration (cert/key) — enables HTTPS. PEM strings or paths. */
  tls?: { cert: string; key: string };
  /** Enable HTTP/3 (requires tls + bun canary with `Bun.serve({h3:true})` support). */
  h3?: boolean;
  /** Bind address. Defaults to `process.env.HOST` or `0.0.0.0`. */
  hostname?: string;
  /** Per-connection idle timeout, seconds. Defaults to Bun's default (10s). */
  idleTimeout?: number;
  /** Maximum request body size in bytes. Defaults to Bun's default (128 MB). */
  maxRequestBodySize?: number;
}

export type ServeOptions = PrismOptions;

// ── Page helpers (throwable from pages, middleware, getServerData) ───────────

/** Redirect to a URL. Throw this from middleware, getServerData, or page components. */
export class Redirect {
  constructor(public url: string, public status: 301 | 302 | 307 | 308 = 302) {}
}

/** Signal a 404 Not Found. Throw this from middleware, getServerData, or page components. */
export class NotFound {}

/** Redirect to a URL. Can be thrown or returned. */
export function redirect(url: string, status: 301 | 302 | 307 | 308 = 302): never {
  throw new Redirect(url, status);
}

/** Signal 404. Can be thrown or returned. */
export function notFound(): never {
  throw new NotFound();
}

function isRedirectLike(error: any): error is { url: string; status: 301 | 302 | 307 | 308 } {
  return !!error && typeof error.url === "string" && [301, 302, 307, 308].includes(error.status);
}

function isNotFoundLike(error: any): boolean {
  return error instanceof NotFound || error?.constructor?.name === "NotFound";
}

/** Invalidate cached HTML for a path. Next.js compatible. */
export function revalidatePath(path: string) {
  ssrCache.delete(path);
  htmlCache.delete(path);
  depCache.clear(); // force dep rescan
}

/** Invalidate all cached HTML. Tag-based invalidation. */
export function revalidateTag(_tag: string) {
  // In PRISM, tags aren't tracked — clear all caches.
  // bext-server's ISR handles tag-based invalidation natively.
  ssrCache.clear();
  htmlCache.clear();
  depCache.clear();
}

// ── Globals ─────────────────────────────────────────────────────────────────

let ROOT: string;
let APP_DIR: string;
let CACHE_DIR: string;
let PUBLIC_DIR: string;
let CLIENT_DIR: string;
let DEV = false;
let _pages: PageInfo[] = [];
let _apiRoutes: ApiRoute[] = [];
let _serverActions: ServerAction[] = [];
let _external: string[] = [];
let _stub: string[] = [];
let _invisibleSegments: string[] = [];

// ── Deep dependency tracking ────────────────────────────────────────────────
//
// Instead of just checking page+layout mtime, we track the actual import graph.
// When Nav.tsx changes, all pages that import the layout (which imports Nav) are
// invalidated. This uses a fast regex-based import scanner — not a full parser,
// but accurate enough for mtime-based cache invalidation.

const depCache = new Map<string, { deps: string[]; mtime: number }>();

/** Get the transitive max mtime for a file and all its imports. */
function deepMtime(filePath: string): number {
  const deps = resolveDeps(filePath);
  let max = 0;
  for (const dep of deps) {
    try { max = Math.max(max, statSync(dep).mtimeMs); } catch {}
  }
  return max;
}

/** Resolve all transitive dependencies of a file (including itself). */
function resolveDeps(filePath: string, seen = new Set<string>()): string[] {
  if (seen.has(filePath)) return [];
  seen.add(filePath);

  const entry = depCache.get(filePath);
  let currentMtime: number;
  try { currentMtime = statSync(filePath).mtimeMs; } catch { return [filePath]; }

  if (entry && entry.mtime >= currentMtime) {
    // Cached deps are still valid for this file
    for (const dep of entry.deps) resolveDeps(dep, seen);
    return [...seen];
  }

  // Scan imports
  let source: string;
  try { source = readFileSync(filePath, "utf-8"); } catch { return [filePath]; }

  const imports: string[] = [];
  const importRe = /(?:import|from)\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const specifier = match[1];
    const resolved = resolveImport(specifier, dirname(filePath));
    if (resolved) imports.push(resolved);
  }

  depCache.set(filePath, { deps: imports, mtime: currentMtime });
  for (const dep of imports) resolveDeps(dep, seen);
  return [...seen];
}

// Cache resolved package entry points
const pkgEntryCache = new Map<string, string | null>();

/** Resolve an import specifier to an absolute file path. */
function resolveImport(specifier: string, fromDir: string): string | null {
  if (specifier.endsWith(".css")) return null;

  // Relative imports
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = resolve(fromDir, specifier);
    const exts = [
      ".tsx", ".ts", ".mts", ".jsx", ".js", ".mjs", ".cjs",
      "/index.ts", "/index.tsx", "/index.mts", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs",
    ];
    // Try exact path first (if it has an extension already)
    try { if (statSync(base).isFile()) return base; } catch {}
    // Then try with extensions
    for (const ext of exts) {
      const candidate = base + ext;
      try { if (statSync(candidate).isFile()) return candidate; } catch {}
    }
    return null;
  }

  // Bare specifiers — resolve workspace packages and local modules
  // Skip known externals (react, react-dom, etc. — we don't need to track their mtimes)
  if (/^(react|react-dom|preact|solid|zlib|fs|path|node:)/.test(specifier)) return null;

  // Try to resolve via Bun/Node module resolution
  const cacheKey = specifier + "\0" + fromDir;
  if (pkgEntryCache.has(cacheKey)) return pkgEntryCache.get(cacheKey)!;

  try {
    // Handle subpath exports like "@bext-stack/ui/layout/Nav"
    const resolved = require.resolve(specifier, { paths: [fromDir, ROOT] });
    // Only track files inside our workspace (not node_modules from npm)
    if (resolved && (!resolved.includes("/node_modules/") || resolved.includes("/shared/"))) {
      pkgEntryCache.set(cacheKey, resolved);
      return resolved;
    }
  } catch {}

  pkgEntryCache.set(cacheKey, null);
  return null;
}

// ── Source mtime tracker (for CSS + bulk checks) ────────────────────────────

class MtimeTracker {
  private lastMtime = 0;
  private dirs: string[];
  constructor(dirs: string[]) { this.dirs = dirs; }

  changed(): boolean {
    const current = this.scan();
    if (current > this.lastMtime) { this.lastMtime = current; return true; }
    return false;
  }
  mark() { this.lastMtime = this.scan(); }

  private scan(): number {
    let max = 0;
    const walk = (dir: string) => {
      try {
        for (const entry of readdirSync(dir)) {
          if (entry === "node_modules" || entry === ".git" || entry === ".bext" || entry === "public") continue;
          const p = join(dir, entry);
          try {
            const s = statSync(p);
            if (s.isDirectory()) walk(p);
            else if (/\.(tsx?|jsx?|css)$/.test(entry) && s.mtimeMs > max) max = s.mtimeMs;
          } catch {}
        }
      } catch {}
    };
    for (const d of this.dirs) walk(d);
    return max;
  }
}

// ── CSS pipeline ────────────────────────────────────────────────────────────

let cssTracker: MtimeTracker;

async function ensureCSS(opts: PrismOptions) {
  // When BEXT_RUST_CSS=1, bext-server handles CSS natively — skip TS Tailwind
  if (process.env.BEXT_RUST_CSS === "1") return;

  if (!cssTracker.changed()) return;
  const start = performance.now();

  const sources = [ROOT + "/src", ...(opts.css?.extraSources ?? []).map(s => resolve(ROOT, s))];
  const extraCSS = (opts.css?.extraCSS ?? []).map(f => {
    try { return readFileSync(resolve(ROOT, f), "utf-8"); } catch { return ""; }
  }).filter(Boolean);

  const result = await buildCSS({ sources, outFile: PUBLIC_DIR + "/styles.css" });

  if (extraCSS.length) {
    const built = readFileSync(PUBLIC_DIR + "/styles.css", "utf-8");
    writeFileSync(PUBLIC_DIR + "/styles.css", extraCSS.join("\n") + "\n" + built);
  }

  // Invalidate gzip cache for styles
  gzipCache.delete(PUBLIC_DIR + "/styles.css");
  cssTracker.mark();
  console.log(`  css     ${(result.size / 1024).toFixed(1)} KB  (${(performance.now() - start).toFixed(0)}ms)`);
}

// ── Route resolution ────────────────────────────────────────────────────────

function routeKey(routePath: string): string {
  // Hash-based key to guarantee uniqueness
  let h = 0x811c9dc5;
  for (let i = 0; i < routePath.length; i++) {
    h ^= routePath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const hash = (h >>> 0).toString(36);
  const prefix = routePath.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30);
  return `${prefix}_${hash}`;
}

interface ResolvedRoute {
  pagePath: string;
  layoutPath: string;
  layoutPaths: string[];
  loadingPath: string;
  imports: string;
  tree: string;
  deepMtime: number;
}

function resolveRoute(
  routePath: string,
  pageInfo?: PageInfo,
  opts?: { prismRootFallback?: boolean },
): ResolvedRoute | null {
  const pagePath = pageInfo?.pagePath
    ?? (routePath === "/" ? APP_DIR + "/page.tsx" : APP_DIR + routePath + "/page.tsx");
  const isFullCompat = process.env.BEXT_NEXTJS_COMPAT === "full";
  const rootLayoutPath = (((!isFullCompat) || opts?.prismRootFallback) && existsSync(APP_DIR + "/layout.prism.tsx"))
    ? APP_DIR + "/layout.prism.tsx"
    : APP_DIR + "/layout.tsx";
  if (!existsSync(pagePath)) return null;

  const pageDir = pagePath.replace(/\/page\.(tsx|jsx)$/, "");

  // Collect ALL layouts from root → page directory (full nesting chain)
  const layouts: string[] = [rootLayoutPath];
  if (pageDir !== APP_DIR) {
    // Walk from APP_DIR down to pageDir, checking each ancestor for layout.tsx
    let dir = APP_DIR;
    const relPath = pageDir.slice(APP_DIR.length);
    const segments = relPath.split("/").filter(Boolean);
    for (const seg of segments) {
      dir = dir + "/" + seg;
      const candidate = dir + "/layout.tsx";
      if (existsSync(candidate) && candidate !== rootLayoutPath) {
        layouts.push(candidate);
      }
    }
  }

  // Check for loading.tsx in the page's directory or nearest ancestor
  let loadingPath = "";
  {
    let dir = pageDir;
    while (dir.length >= APP_DIR.length) {
      const candidate = dir + "/loading.tsx";
      if (existsSync(candidate)) { loadingPath = candidate; break; }
      if (dir === APP_DIR) break;
      dir = dir.replace(/\/[^/]+$/, "");
    }
  }
  const hasLoading = !!loadingPath;

  // Build imports
  let imports = `import RootLayout from "${layouts[0]}";\n`;
  for (let i = 1; i < layouts.length; i++) {
    imports += `import Layout${i} from "${layouts[i]}";\n`;
  }
  imports += `import * as Page from "${pagePath}";\n`;
  if (hasLoading) {
    imports += `import { Suspense } from "react";\nimport Loading from "${loadingPath}";\n`;
  }

  // Build component tree: RootLayout > Layout1 > Layout2 > ... > page
  let pageElement = `React.createElement(Page.default || Page, props)`;
  if (hasLoading) {
    pageElement = `React.createElement(Suspense, { fallback: React.createElement(Loading.default || Loading) }, ${pageElement})`;
  }

  // Wrap from innermost layout outward
  for (let i = layouts.length - 1; i >= 1; i--) {
    pageElement = `React.createElement(Layout${i}, { children: ${pageElement} })`;
  }
  const tree = `React.createElement(RootLayout, { children: ${pageElement} })`;

  const depPaths = [pagePath, ...layouts];
  if (loadingPath) depPaths.push(loadingPath);
  const dm = Math.max(...depPaths.map(p => deepMtime(p)));

  return { pagePath, layoutPath: rootLayoutPath, layoutPaths: layouts, loadingPath, imports, tree, deepMtime: dm };
}

function needsHydration(pagePath: string): boolean {
  try {
    const src = readFileSync(pagePath, "utf-8");
    const trimmed = src.trimStart();
    return trimmed.startsWith('"use client"') || trimmed.startsWith("'use client'");
  } catch {
    return false;
  }
}

/** Returns true when a file's first directive is `"use signals"` —
 *  dev/build pipelines route those through the bext signals runtime
 *  rather than React. Mirrors `needsHydration` but for signals. */
function isSignalsIsland(filePath: string): boolean {
  try {
    const src = readFileSync(filePath, "utf-8");
    const trimmed = src.trimStart();
    return trimmed.startsWith('"use signals"') || trimmed.startsWith("'use signals'");
  } catch {
    return false;
  }
}

// ── Page discovery ──────────────────────────────────────────────────────────
//
// Conventions:
//   src/app/page.tsx                 → /
//   src/app/pricing/page.tsx         → /pricing
//   src/app/blog/[slug]/page.tsx     → /blog/:slug (dynamic)
//   src/app/docs/[...path]/page.tsx  → /docs/* (catch-all)
//   src/app/docs/[[...path]]/page.tsx → /docs, /docs/a, /docs/a/b (optional catch-all)
//   src/app/(auth)/login/page.tsx    → /login (route group — parens stripped)
//   src/app/_components/             → ignored (underscore prefix)

interface PageInfo {
  routePath: string;      // "/pricing" or "/dashboard/[id]" or "/docs/[...path]"
  pagePath: string;
  isClient: boolean;
  isDynamic: boolean;
  isCatchAll: boolean;
  isOptionalCatchAll: boolean;
  /** True when the page exports `renderingMode = "streaming"` — opts
   *  out of prerender + runtime htmlCache so live data flows on every
   *  request. Detected by source scan in `discoverPages()`. */
  isStreaming: boolean;
}

function discoverPages(): PageInfo[] {
  const pages: PageInfo[] = [];
  function walk(dir: string, prefix: string) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry === "page.tsx" || entry === "page.jsx") {
          const routePath = prefix || "/";
          const isDynamic = routePath.includes("[");
          const isCatchAll = routePath.includes("[...");
          const isOptionalCatchAll = routePath.includes("[[...");
          let isStreaming = false;
          try {
            const src = readFileSync(full, "utf-8");
            isStreaming = /export\s+const\s+renderingMode\s*=\s*["']streaming["']/.test(src);
          } catch {}
          pages.push({ routePath, pagePath: full, isClient: needsHydration(full), isDynamic, isCatchAll, isOptionalCatchAll, isStreaming });
        } else if (entry === "api" || entry.startsWith(".") || entry.startsWith("_")) {
          continue; // Skip api dir, hidden, and private dirs
        } else {
          try {
            if (!statSync(full).isDirectory()) continue;
            // Route groups: (groupName) → don't add to URL path
            if (entry.startsWith("(") && entry.endsWith(")")) {
              walk(full, prefix);
            // Invisible segments (e.g., "default" module prefix) → skip in URL
            } else if (_invisibleSegments.includes(entry)) {
              walk(full, prefix);
            } else {
              walk(full, prefix + "/" + entry);
            }
          } catch {}
        }
      }
    } catch {}
  }
  walk(APP_DIR, "");
  // Sort: static routes first, then dynamic, then catch-all (most specific first)
  pages.sort((a, b) => {
    if (a.isCatchAll !== b.isCatchAll) return a.isCatchAll ? 1 : -1;
    if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
    return 0;
  });
  return pages;
}

/** Match a request path against discovered pages. */
function matchRoute(path: string, pages: PageInfo[]): { page: PageInfo; params: Record<string, string> } | null {
  for (const page of pages) {
    if (!page.isDynamic && page.routePath === path) return { page, params: {} };
  }
  for (const page of pages) {
    if (!page.isDynamic) continue;
    const params = matchDynamic(path, page.routePath);
    if (params) return { page, params };
  }
  return null;
}

function matchDynamic(path: string, pattern: string): Record<string, string> | null {
  const pathParts = path.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    // Optional catch-all: [[...slug]] matches zero or more segments
    if (pp.startsWith("[[...") && pp.endsWith("]]")) {
      const paramName = pp.slice(5, -2);
      params[paramName] = pathParts.slice(i).join("/") || "";
      return params;
    }
    // Catch-all: [...slug] matches one or more remaining segments
    if (pp.startsWith("[...") && pp.endsWith("]")) {
      if (i >= pathParts.length) return null; // must match at least one segment
      const paramName = pp.slice(4, -1);
      params[paramName] = pathParts.slice(i).join("/");
      return params;
    }
    // Dynamic segment: [id]
    if (pp.startsWith("[") && pp.endsWith("]")) {
      if (i >= pathParts.length) return null;
      params[pp.slice(1, -1)] = pathParts[i];
    } else {
      if (i >= pathParts.length || pp !== pathParts[i]) return null;
    }
  }
  // Exact length match (unless catch-all handled it above)
  if (pathParts.length !== patternParts.length) return null;
  return params;
}

// ── Middleware ───────────────────────────────────────────────────────────────
//
// Convention: src/app/middleware.ts exports a default function:
//   export default function middleware(request: Request) {
//     // return Response to short-circuit (e.g. redirect)
//     // return undefined to continue to the page
//   }

type MiddlewareFn = (request: Request, params: { path: string }) =>
  Response | undefined | null | Promise<Response | undefined | null>;

let middlewareFn: MiddlewareFn | null = null;
let middlewareMatchers: ((path: string) => boolean)[] | null = null;
let middlewareMtime = 0;

// Compile one Next.js-style matcher source into a path-predicate.
// Subset supported here mirrors crates/bext-turbopack/src/prism.rs's parser
// (literal segments, `:slug`, `:slug*`, `:slug+`). Unsupported patterns
// (regex groups, alternation, anchors) return null so the caller falls
// back to "run on every path" rather than silently exclude.
function compileMatcher(source: string): ((path: string) => boolean) | null {
  if (!source.startsWith("/")) return null;
  if (/[()|^$\\{}?]/.test(source)) return null;
  if (source === "/") return (p) => p === "/" || p === "";
  type Seg = { lit: string } | { kind: "p" | "p*" | "p+" };
  const segs: Seg[] = [];
  const parts = source.replace(/^\//, "").split("/");
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw) return null;
    if (raw.startsWith(":")) {
      const tail = raw.slice(1);
      if (!tail) return null;
      if (tail.endsWith("*")) segs.push({ kind: "p*" });
      else if (tail.endsWith("+")) segs.push({ kind: "p+" });
      else segs.push({ kind: "p" });
    } else if (raw.includes(":")) {
      return null;
    } else {
      segs.push({ lit: raw });
    }
  }
  return (path: string) => {
    const ps = path.replace(/^\//, "").split("/").filter((s) => s.length > 0);
    let p = 0;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] as any;
      if (typeof seg.lit === "string") {
        if (ps[p] !== seg.lit) return false;
        p++;
      } else if (seg.kind === "p") {
        if (ps[p] == null) return false;
        p++;
      } else if (seg.kind === "p*") {
        return i + 1 === segs.length;
      } else if (seg.kind === "p+") {
        if (ps[p] == null) return false;
        return i + 1 === segs.length;
      }
    }
    return p === ps.length;
  };
}

async function loadMiddleware(): Promise<void> {
  // PRISM middleware convention: src/app/middleware.ts
  // Note: we intentionally skip src/middleware.ts (Next.js convention) because
  // Next.js middleware often depends on Edge Runtime features and internal APIs
  // that are not available in PRISM's Bun environment.
  const mwPath = APP_DIR + "/middleware.ts";
  if (!existsSync(mwPath)) { middlewareFn = null; middlewareMatchers = null; return; }

  const mtime = statSync(mwPath).mtimeMs;
  if (mtime <= middlewareMtime) return;

  const key = "middleware";
  // Namespace-import the module so we can pluck `config` alongside the
  // default. Default-import + named import in one line would crash if
  // `config` isn't exported.
  const entry = `import * as __ns from "${mwPath}";\nglobalThis.__prism_middleware = __ns.default ?? null;\nglobalThis.__prism_middleware_config = __ns.config ?? null;`;
  const entryFile = CACHE_DIR + `/mw_${key}.tsx`;
  writeFileSync(entryFile, entry);

  const result = await Bun.build({
    entrypoints: [entryFile],
    outdir: CACHE_DIR + "/mw",
    target: "bun",
    naming: `[name].[hash].js`,
    plugins: [createNextCompatPlugin()],
    external: _external,
  });

  if (!result.success) {
    console.error("[prism:middleware] build failed:", result.logs);
    middlewareFn = null;
    middlewareMatchers = null;
    return;
  }

  const outPath = result.outputs[0]?.path;
  if (!outPath) { middlewareFn = null; middlewareMatchers = null; return; }

  try {
    // Use dynamic import for ESM compatibility (new Function fails on import statements)
    await import(outPath + "?t=" + Date.now());
    middlewareFn = (globalThis as any).__prism_middleware;
    const cfg = (globalThis as any).__prism_middleware_config;
    middlewareMtime = mtime;
    if (!middlewareFn) {
      console.warn("[prism:middleware] loaded but no default export found");
    }
    // Build matcher predicates if config.matcher is present. Empty/null
    // matcher list preserves the legacy "run on every path" behaviour.
    middlewareMatchers = null;
    if (cfg && typeof cfg === "object") {
      const raw = (cfg as any).matcher;
      const arr: string[] = Array.isArray(raw)
        ? raw.filter((m: unknown): m is string => typeof m === "string")
        : typeof raw === "string" ? [raw] : [];
      if (arr.length > 0) {
        const preds: ((p: string) => boolean)[] = [];
        for (const m of arr) {
          const fn = compileMatcher(m);
          if (fn) preds.push(fn);
          else {
            // Unparseable matcher — fall back to "run on every path"
            // for safety, matching the Rust dispatcher's policy.
            preds.length = 0;
            break;
          }
        }
        middlewareMatchers = preds.length > 0 ? preds : null;
      }
    }
  } catch (e: any) {
    console.warn(`[prism:middleware] failed to load (${e.message?.substring(0, 80)})`);
    middlewareFn = null;
    middlewareMatchers = null;
    middlewareMtime = mtime; // Don't retry until file changes
  }
}

// ── Page metadata ───────────────────────────────────────────────────────────
//
// Convention: pages export `metadata` object for <head> injection:
//   export const metadata = { title: "Pricing", description: "Plans and pricing" };

interface PageMetadata {
  title?: string;
  description?: string;
  [key: string]: any;
}

function extractMetadata(pagePath: string): PageMetadata | null {
  try {
    const src = readFileSync(pagePath, "utf-8");
    // Quick regex extraction — looks for `export const metadata = { ... }`
    const match = src.match(/export\s+const\s+metadata\s*=\s*(\{[^}]+\})/);
    if (!match) return null;
    // Safe eval of simple object literal
    try { return new Function(`return ${match[1]}`)(); } catch { return null; }
  } catch { return null; }
}

function injectMetadata(html: string, meta: PageMetadata): string {
  if (meta.title) {
    // Replace existing <title> or inject before </head>
    if (html.includes("<title>")) {
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${escHtml(meta.title)}</title>`);
    } else {
      html = html.replace("</head>", `<title>${escHtml(meta.title)}</title>\n</head>`);
    }
  }
  if (meta.description) {
    if (html.includes('name="description"')) {
      html = html.replace(/(<meta[^>]*name="description"[^>]*content=")[^"]*"/, `$1${escHtml(meta.description)}"`);
    } else {
      html = html.replace("</head>", `<meta name="description" content="${escHtml(meta.description)}" />\n</head>`);
    }
  }
  return html;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) cookies[k] = v.join("=");
  }
  return cookies;
}

// ── Next.js compatibility plugin ────────────────────────────────────────────
//
// Redirects `next/*` imports to PRISM's shim implementations.
// This lets existing Next.js components work without modification.

const NEXT_SHIM_DIR = resolve(dirname(new URL(import.meta.url).pathname), "next");

const NEXT_SHIMS: Record<string, string> = {
  "next/link": NEXT_SHIM_DIR + "/link.tsx",
  "next/image": NEXT_SHIM_DIR + "/image.tsx",
  "next/navigation": NEXT_SHIM_DIR + "/navigation.ts",
  "next/headers": NEXT_SHIM_DIR + "/headers.ts",
  "next/font/google": NEXT_SHIM_DIR + "/font.ts",
  "next/font/local": NEXT_SHIM_DIR + "/font.ts",
  "next/font": NEXT_SHIM_DIR + "/font.ts",
  "next/dynamic": NEXT_SHIM_DIR + "/dynamic.ts",
  "next/server": NEXT_SHIM_DIR + "/server.ts",
  "next/cache": NEXT_SHIM_DIR + "/cache.ts",
  "next/script": NEXT_SHIM_DIR + "/script.tsx",
  // Internal Next.js paths used by some apps
  "next/dist/server/web/spec-extension/adapters/headers": NEXT_SHIM_DIR + "/headers.ts",
  "next/dist/server/web/spec-extension/adapters/request-cookies": NEXT_SHIM_DIR + "/headers.ts",
  "next/router": NEXT_SHIM_DIR + "/router.ts",
  "server-only": NEXT_SHIM_DIR + "/server-only.ts",
  "client-only": NEXT_SHIM_DIR + "/server-only.ts",  // same no-op
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyStubComponentExport(name: string, modulePath: string, source: string | null): boolean {
  if (name !== "default") return /^[A-Z]/.test(name);
  if (/\/(?:app|components)\//.test(modulePath)) return true;
  if (!source) return false;
  return /export\s+default\s+(?:async\s+)?function\s+[A-Z]/.test(source)
    || /export\s+default\s+class\s+[A-Z]/.test(source)
    || /export\s+default\s+(?:memo|forwardRef)\s*\(/.test(source);
}

function getStubFallbackExports(modulePath: string): string[] {
  const names = ["default"];
  if (modulePath.includes("/server/db")) names.push("prisma", "db", "PrismaClient", "reconnectPrisma");
  if (modulePath.includes("/trpc/server")) names.push("api", "HydrateClient");
  if (modulePath.includes("/trpc/react")) names.push("api");
  if (modulePath.includes("/trpc/hydrate-client-safe")) names.push("SafeHydrateClient");
  if (modulePath.includes("/lib/sessions")) names.push("AppSessionProvider");
  if (modulePath === "nuqs/adapters/next/app") names.push("NuqsAdapter");
  if (modulePath === "nuqs/adapters/next") names.push("NuqsAdapter");
  return names;
}

function buildPrismEmptyStub(modulePath: string, exports: string[], source: string | null): string {
  const componentStubName = "__prismComponentStub";
  const apiStubName = "__prismApiProxy";
  const defaultStub = isLikelyStubComponentExport("default", modulePath, source)
    ? componentStubName
    : apiStubName;
  const uniqueExports = [...new Set([...exports, ...getStubFallbackExports(modulePath)])].filter(name => name !== "default");
  const namedExports = uniqueExports.map(name => {
    const target = isLikelyStubComponentExport(name, modulePath, source)
      ? componentStubName
      : apiStubName;
    return `export var ${name} = ${target};`;
  }).join("\n");

  return `
function ${componentStubName}(props) {
  return props && typeof props === "object" && "children" in props ? props.children ?? null : null;
}

function __prismResolved(value) {
  return Promise.resolve(value);
}

var __prismResultProxy;
var ${apiStubName};

function __prismCreateResultProxy() {
  function result() { return __prismResultProxy; }
  return new Proxy(result, {
    get: function(_, prop) {
      if (prop === "then") return function(resolve) { return __prismResolved(undefined).then(resolve); };
      if (prop === "catch") return function() { return __prismResolved(__prismResultProxy); };
      if (prop === "finally") return function(cb) { return __prismResolved(undefined).finally(cb); };
      if (prop === "data" || prop === "error" || prop === "current" || prop === "value") return undefined;
      if (prop === "status" || prop === "fetchStatus") return "idle";
      if (prop === "length") return 0;
      if (prop === "isLoading" || prop === "isPending" || prop === "isFetching" || prop === "isMutating" || prop === "isSuccess" || prop === "isError") return false;
      if (typeof prop === "symbol") {
        if (prop === Symbol.iterator) return function* () {};
        if (prop === Symbol.toPrimitive) return function() { return ""; };
        return undefined;
      }
      return __prismResultProxy;
    },
    apply: function() { return __prismResultProxy; },
  });
}

function __prismCreateApiProxy() {
  function api() { return __prismResultProxy; }
  return new Proxy(api, {
    get: function(_, prop) {
      if (prop === "then" || prop === "$$typeof" || prop === "render" || prop === "prototype" || prop === "constructor") return undefined;
      if (typeof prop === "symbol") {
        if (prop === Symbol.iterator) return function* () {};
        if (prop === Symbol.toPrimitive) return function() { return ""; };
        return undefined;
      }
      return ${apiStubName};
    },
    apply: function() { return __prismResultProxy; },
  });
}

__prismResultProxy = __prismCreateResultProxy();
${apiStubName} = __prismCreateApiProxy();

export default ${defaultStub};
${namedExports}
`;
}

function buildManageShellIsland(name: string, exportNames: string[]): string {
  const hasDefault = exportNames.includes("default");
  const namedExports = exportNames.filter(n => n !== "default");
  const named = namedExports.map(n => `export function ${n}(props) { return ManageShell(props); }`).join("\n");
  return `import React from "react";
function ManageShell(props) {
  var asideStyle = {
    width: "clamp(232px, 22vw, 288px)",
    minHeight: "calc(100vh - var(--header-height, 0px))",
    padding: "24px 18px",
    background: "linear-gradient(180deg, #0f172a 0%, #111827 100%)",
    color: "#e2e8f0",
    borderRight: "1px solid rgba(148, 163, 184, 0.18)",
    display: "flex",
    flexDirection: "column",
    gap: "18px",
    boxSizing: "border-box",
  };
  var shellStyle = {
    display: "flex",
    minHeight: "calc(100vh - var(--header-height, 0px))",
    background: "#f8fafc",
    color: "#0f172a",
  };
  var navItem = function(label, active) {
    return React.createElement("div", {
      style: {
        padding: "10px 12px",
        borderRadius: "12px",
        background: active ? "rgba(59, 130, 246, 0.18)" : "rgba(255, 255, 255, 0.04)",
        color: active ? "#f8fafc" : "#cbd5e1",
        fontSize: "14px",
        fontWeight: active ? 600 : 500,
      }
    }, label);
  };
  return React.createElement("div", { "data-prism-shell": "${name}", style: shellStyle },
    React.createElement("aside", { style: asideStyle },
      React.createElement("div", null,
        React.createElement("div", { style: { fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.14em", color: "#94a3b8", marginBottom: "8px" } }, "Gestion"),
        React.createElement("div", { style: { fontSize: "20px", fontWeight: 700, color: "#f8fafc" } }, "Manage")
      ),
      React.createElement("div", { style: { display: "grid", gap: "10px" } },
        navItem("Dashboard", true),
        navItem("Navigation", false),
        navItem("Sites", false),
        navItem("Settings", false)
      ),
      React.createElement("div", { style: { marginTop: "auto", paddingTop: "12px", borderTop: "1px solid rgba(148, 163, 184, 0.18)", fontSize: "12px", color: "#94a3b8" } }, "PRISM shell")
    ),
    React.createElement("main", {
      style: {
        flex: 1,
        minWidth: 0,
        padding: "24px",
        boxSizing: "border-box",
      }
    }, props?.children || null)
  );
}
${hasDefault ? "export default ManageShell;" : ""}
${named}
`;
}

function buildIslandPassthrough(name: string, exportNames: string[], filePath: string): string {
  if (filePath.endsWith("/src/app/default/(manage)/manage/layout.client.tsx")) {
    return buildManageShellIsland(name, exportNames);
  }

  const hasDefault = exportNames.includes("default");
  const namedExports = exportNames.filter(n => n !== "default");
  const fakeExports = namedExports.map(n =>
    `export function ${n}(props) { return props?.children || null; }`
  ).join("\n");
  return `import React from "react";
function Passthrough(props) { return React.createElement("div", { "data-island": "${name}" }, props.children || null); }
${hasDefault ? "export default Passthrough;" : ""}
${fakeExports}`;
}

function scanImportClause(source: string, specifier: string): { defaultImport: string | null; namedImports: string[] } {
  const imports = { defaultImport: null as string | null, namedImports: [] as string[] };
  const specifierRe = new RegExp(`from\\s+["']${escapeRegExp(specifier)}["']\\s*;?$`);
  const statements = source.match(/^\s*import[\s\S]*?;$/gm) ?? [];
  for (const statement of statements) {
    if (!specifierRe.test(statement.trim())) continue;
    const clauseMatch = statement.match(/import\s+([\s\S]*?)\s+from\s+["'][^"']+["']/);
    if (!clauseMatch) continue;
    const clause = clauseMatch[1].trim();
    const namedMatch = clause.match(/\{([^}]*)\}/);
    if (namedMatch) {
      for (const rawPart of namedMatch[1].split(",")) {
        const part = rawPart.trim();
        if (!part) continue;
        const exportName = part.includes(" as ") ? part.split(/\s+as\s+/)[0]!.trim() : part;
        if (exportName) imports.namedImports.push(exportName);
      }
    }

    const defaultClause = namedMatch
      ? clause.slice(0, namedMatch.index).replace(/,$/, "").trim()
      : clause;
    if (defaultClause && !defaultClause.startsWith("*") && !imports.defaultImport) {
      imports.defaultImport = defaultClause;
    }
  }

  imports.namedImports = [...new Set(imports.namedImports)];
  return imports;
}

function buildNextFontShim(specifier: string, importer: string): string {
  let source = "";
  try {
    source = readFileSync(importer, "utf-8");
  } catch {}
  const { defaultImport, namedImports } = scanImportClause(source, specifier);
  const googleNames = namedImports.filter(name => name !== "default" && name !== "localFont");
  const hasLocalFont = specifier === "next/font/local" || namedImports.includes("localFont") || defaultImport === "localFont";
  const googleExports = googleNames.map(name => {
    const family = name.replace(/_/g, " ");
    return `export function ${name}(opts) { return __prismGoogleFont(${JSON.stringify(family)}, opts); }`;
  }).join("\n");

  return `
function __prismNormalizeFontName(name) {
  return String(name || "font").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "font";
}

function __prismFontConfig(family, opts) {
  var fallback = Array.isArray(opts?.fallback) && opts.fallback.length
    ? opts.fallback.join(", ")
    : "system-ui, sans-serif";
  return {
    className: "font-" + __prismNormalizeFontName(family),
    style: { fontFamily: "'" + family + "', " + fallback },
    variable: opts?.variable,
  };
}

function __prismGoogleFont(family, opts) {
  return __prismFontConfig(family, opts);
}

function localFont(opts) {
  var family = opts?.family || "local-font";
  return __prismFontConfig(family, opts);
}

${googleExports}
${hasLocalFont ? "export { localFont };\n" : ""}
${defaultImport ? `export default ${hasLocalFont ? "localFont" : "{ " + googleNames.join(", ") + " }"};\n` : ""}
`;
}

export function createNextCompatPlugin() {
  return {
    name: "prism-next-compat",
    setup(build: any) {
      build.onResolve({ filter: /^next\/font(?:\/google|\/local)?$/ }, (args: any) => {
        if (args.path === "next/font") return { path: NEXT_SHIMS[args.path] };
        return {
          path: `${args.path}?importer=${encodeURIComponent(args.importer || "")}`,
          namespace: "prism-next-font",
        };
      });

      // Resolve next/* imports to PRISM shims
      build.onResolve({ filter: /^next\/|^server-only$|^client-only$/ }, (args: any) => {
        const shim = NEXT_SHIMS[args.path];
        if (shim) return { path: shim };
        return undefined;
      });

      // Stub patterns — replace with empty module (for components that crash the bundler)
      build.onResolve({ filter: /.*/ }, (args: any) => {
        if (_stub.length && _stub.some(s => args.path === s || args.path.startsWith(s.replace(/\*$/, "")))) {
          return { path: args.path, namespace: "prism-empty" };
        }
      });

      // Resolve @/ path alias → src/ (matches tsconfig paths)
      build.onResolve({ filter: /^@\// }, (args: any) => {
        const resolved = args.path.replace(/^@\//, ROOT + "/src/");
        const exts = [
          "",
          ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs",
          "/index.ts", "/index.tsx", "/index.mts", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs",
        ];
        for (const ext of exts) {
          const candidate = resolved + ext;
          try { if (statSync(candidate).isFile()) return { path: candidate }; } catch {}
        }
        // If not found, return an empty module instead of crashing the process
        return { path: args.path, namespace: "prism-empty" };
      });

      // Catch .server suffix (Next.js convention — server-only modules shouldn't run in client bundles)
      // Note: .client files are NOT stubbed — they're real components handled by the island plugin.
      build.onResolve({ filter: /\.server$/ }, (args: any) => {
        if (!args.path.startsWith(".") && !args.path.startsWith("/")) {
          return { path: args.path, namespace: "prism-empty" };
        }
      });

      // Empty module loader — prevents Bun.build from crashing on missing imports.
      // Reads the original module source to discover named exports, then generates
      // a stub that provides matching no-op exports.
      build.onLoad({ namespace: "prism-empty", filter: /.*/ }, (args: any) => {
        if (args.path === "nuqs/adapters/next/app" || args.path === "nuqs/adapters/next") {
          return {
            contents: `function NuqsAdapter(props) { return props?.children || null; }\nexport { NuqsAdapter };\nexport default NuqsAdapter;`,
            loader: "js",
          };
        }

        const exports: string[] = [];
        let source: string | null = null;
        // Try to read the original file to discover export names
        const origPath = args.path.replace(/^@\//, ROOT + "/src/");
        const exts = [
          ".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs",
          "/index.ts", "/index.tsx", "/index.mts", "/index.js", "/index.jsx", "/index.mjs", "/index.cjs",
        ];
        for (const ext of exts) {
          try {
            const src = readFileSync(origPath + ext, "utf-8");
            source = src;
            // Match: export const/let/var/function/class NAME
            const re1 = /export\s+(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
            let m;
            while ((m = re1.exec(src))) exports.push(m[1]);
            // Match: export const { a: b, c } = ... (destructured exports)
            const re2 = /export\s+(?:const|let|var)\s+\{([^}]+)\}/g;
            while ((m = re2.exec(src))) {
              for (const part of m[1].split(",")) {
                const trimmed = part.trim();
                // "trpc: api" → export name is "api"; "HydrateClient" → export name is "HydrateClient"
                const alias = trimmed.includes(":") ? trimmed.split(":").pop()!.trim() : trimmed;
                if (alias && /^[A-Za-z_$]/.test(alias)) exports.push(alias);
              }
            }
            // Match: export { foo as bar, baz }
            const re3 = /export\s+\{([^}]+)\}(?!\s+from)/g;
            while ((m = re3.exec(src))) {
              for (const part of m[1].split(",")) {
                const trimmed = part.trim();
                const name = trimmed.includes(" as ") ? trimmed.split(" as ").pop()!.trim() : trimmed;
                if (name && /^[A-Za-z_$]/.test(name)) exports.push(name);
              }
            }
            // Match: export { name1, name2 } from "..."
            const re4 = /export\s+\{([^}]+)\}\s+from/g;
            while ((m = re4.exec(src))) {
              for (const part of m[1].split(",")) {
                const trimmed = part.trim();
                const name = trimmed.includes(" as ") ? trimmed.split(" as ").pop()!.trim() : trimmed;
                if (name && /^[A-Za-z_$]/.test(name)) exports.push(name);
              }
            }
            if (/export\s+default/.test(src)) exports.push("default");
            break;
          } catch {}
        }
        return {
          contents: buildPrismEmptyStub(args.path, exports, source),
          loader: "js",
        };
      });

      build.onLoad({ namespace: "prism-next-font", filter: /.*/ }, (args: any) => {
        const [specifier, importerParam = ""] = args.path.split("?importer=");
        const importer = decodeURIComponent(importerParam);
        return {
          contents: buildNextFontShim(specifier, importer),
          loader: "js",
        };
      });
    },
  };
}

// ── Auto-island plugin for SSR builds ───────────────────────────────────────
//
// When compiling a server page's SSR bundle, this Bun.build plugin intercepts
// imports of "use client" files and replaces them with island-wrapped versions.
// The wrapper renders the real component (for SSR HTML) inside a <bext-island>
// marker that the client-side loader will hydrate.
//
// This means page authors just write:
//   import { Toggle } from "../components/Toggle";  // has "use client"
//   <Toggle active={true} />  // automatically becomes an island
//
// No <Island> wrapper needed.

/** Set of "use client" files discovered during SSR builds (for client bundle generation). */
const discoveredIslands = new Set<string>();

export function createIslandSSRPlugin(opts?: { forcePassthrough?: boolean }) {
  /** Track which paths we've already checked to avoid repeated fs reads. */
  const useClientCache = new Map<string, boolean>();
  /** Prevent recursion: paths currently being proxied. */
  const proxying = new Set<string>();
  const forcePassthrough = !!opts?.forcePassthrough;

  function isUseClient(filePath: string): boolean {
    const cached = useClientCache.get(filePath);
    if (cached !== undefined) return cached;
    const result = needsHydration(filePath);
    useClientCache.set(filePath, result);
    return result;
  }

  function resolveFile(specifier: string, fromDir: string): string | null {
    // Only handle relative imports — bare specifiers go through normal resolution
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
    const base = resolve(fromDir, specifier);
    const exts = [".tsx", ".ts", ".mts", ".jsx", ".js", ".mjs", ".cjs"];
    try { if (statSync(base).isFile()) return base; } catch {}
    for (const ext of exts) {
      try { if (statSync(base + ext).isFile()) return base + ext; } catch {}
    }
    return null;
  }

  return {
    name: "prism-auto-island",
    setup(build: any) {
      // Intercept relative imports that resolve to "use client" files
      build.onResolve({ filter: /^\./ }, (args: any) => {
        // Don't intercept if this resolve comes from our own wrapper
        if (args.namespace === "prism-island" || args.namespace === "prism-island-raw") return;
        if (args.importer && (args.importer.includes("/node_modules/") || isUseClient(args.importer))) return;

        const resolved = resolveFile(args.path, args.resolveDir);
        if (!resolved || proxying.has(resolved) || !isUseClient(resolved)) return;

        discoveredIslands.add(resolved);
        return { path: resolved, namespace: "prism-island" };
      });

      // Load the RAW module (no wrapping) — used by the island wrapper to get the real component
      build.onResolve({ filter: /.*/, namespace: "prism-island" }, (args: any) => {
        // Imports FROM the wrapper should resolve normally (not get intercepted)
        if (args.path.startsWith(".") || args.path.startsWith("/")) {
          const resolved = resolveFile(args.path, args.resolveDir || dirname(args.importer || ""));
          if (resolved) return { path: resolved };
        }
        return undefined;
      });

      // For intercepted "use client" modules, return an island wrapper
      // that inlines the original source with "use client" stripped.
      // For complex components (many @/ or package imports), use a lightweight
      // placeholder that renders children during SSR and hydrates on client.
      build.onLoad({ namespace: "prism-island", filter: /.*/ }, (args: any) => {
        const filePath = args.path;
        const name = filePath.split("/").pop()!.replace(/\.(tsx?|jsx?)$/, "");

        const source = readFileSync(filePath, "utf-8");

        // Detect complex components: if the source imports from many @/ paths or
        // heavy packages, use a simple passthrough stub instead of inlining
        const importLines = source.split("\n").filter(l => /^\s*import\s/.test(l));
        const complexImports = importLines.filter(l => /@\/|@company-manager|framer-motion|@tanstack/.test(l));
        const exportNames = scanExports(source);
        if (forcePassthrough || complexImports.length > 3) {
          return {
            contents: buildIslandPassthrough(name, exportNames, filePath),
            loader: "tsx",
          };
        }

        // Strip "use client" directive
        const strippedSource = source.replace(/^["']use client["'];?\s*/m, "");
        const hasDefault = exportNames.includes("default") || /export\s+default/.test(source);
        const namedExports = exportNames.filter(n => n !== "default");

        proxying.add(filePath);

        // Rewrite the source: strip "use client", rename exports to _orig_ prefix
        let rewritten = strippedSource;
        // Replace `export default X` → `var _orig_default = X;`
        rewritten = rewritten.replace(/export\s+default\s+/g, "var _orig_default = ");
        // Replace `export [async] function Foo` → `[async] function _orig_Foo`
        for (const n of namedExports) {
          rewritten = rewritten.replace(
            new RegExp(`export\\s+(async\\s+)?(function|class|const|let|var)\\s+${n}\\b`),
            (_, async_, keyword) => `${async_ || ""}${keyword} _orig_${n}`,
          );
        }
        // Replace `export { X, Y }` and `export { X } from "Y"` → remove
        rewritten = rewritten.replace(/export\s*\{[^}]*\}\s*(from\s*["'][^"']*["']\s*)?;?/g, "");
        const exportAliases = namedExports
          .filter(n => !new RegExp(`export\\s+(async\\s+)?(function|class|const|let|var)\\s+${escapeRegExp(n)}\\b`).test(strippedSource))
          .map(n => `var _orig_${n} = typeof ${n} !== "undefined" ? ${n} : undefined;`)
          .join("\n");

        const contents = `
// ── Original module (exports renamed to _orig_) ──
${rewritten}
${exportAliases}

// ── PRISM island wrapper ──
import React from "react";

function __wrapIsland(componentName, Comp) {
  if (typeof Comp !== "function") return Comp;
  var Wrapped = function IslandSSR(props) {
    var children = props.children;
    var islandProps = {};
    for (var k in props) { if (k !== "children") islandProps[k] = props[k]; }
    var serialized = JSON.stringify(islandProps).replace(/</g, "\\\\u003c");
    var hasChildren = children !== undefined && children !== null;

    // Render the component with its children (for visual SSR output).
    // Also store children in a <template> so the client can always
    // access them — even if the component conditionally hides children
    // (e.g. a closed Accordion).
    return React.createElement("bext-island", {
      "data-component": componentName,
      "data-props": serialized,
      "data-has-children": hasChildren ? "1" : undefined,
      "data-ssr": "1",
      suppressHydrationWarning: true,
    },
      React.createElement(Comp, props),
      hasChildren ? React.createElement("template", { "data-island-children": "" }, children) : null,
    );
  };
  Wrapped.displayName = "Island(" + componentName + ")";
  return Wrapped;
}

${namedExports.map(n => `export var ${n} = __wrapIsland("${n}", _orig_${n});`).join("\n")}
${hasDefault ? `export default __wrapIsland("${name}", _orig_default !== undefined ? _orig_default : _orig_${namedExports[0] || name});` : ""}
`;
        return { contents, loader: "tsx", resolveDir: dirname(filePath) };
      });
    },
  };
}

/** Scan a source file for exported names (fast regex, not a full parser). */
function scanExports(source: string): string[] {
  const names: string[] = [];
  // export function Foo / export class Foo / export const Foo
  const re1 = /export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m;
  while ((m = re1.exec(source))) names.push(m[1]);
  // export { Foo, Bar }
  const re2 = /export\s*\{([^}]+)\}/g;
  while ((m = re2.exec(source))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name && /^[A-Za-z_$]/.test(name)) names.push(name);
    }
  }
  // export default
  if (/export\s+default/.test(source)) names.push("default");
  return [...new Set(names)];
}

// ── SSR bundles (with deep dep tracking + auto-island plugin) ───────────────

const ssrCache = new Map<string, { js: string; mtime: number; outFile: string }>();

async function compilePage(
  routePath: string,
  pageInfo?: PageInfo,
  opts?: { prismRootFallback?: boolean },
): Promise<string | null> {
  const route = resolveRoute(routePath, pageInfo, opts);
  if (!route) return null;

  const key = routeKey(routePath);
  const cached = ssrCache.get(routePath);
  if (cached && cached.mtime >= route.deepMtime) return cached.js;

  const isRebuild = DEV && !!cached;
  const buildStart = performance.now();

  // For full-page "use client" pages, skip SSR and emit a placeholder for hydration
  const pageIsClient = needsHydration(route.pagePath);

  // Convention components in the route's directory: error / not-found /
  // template / loading. Each is optional; absent files stay out of the
  // bundle. Mirrors `crates/bext-server/src/ssr_pipeline/prism.rs:wrapper_template`.
  const routeDir = routePath === "/" ? "" : routePath;
  const errorPath = APP_DIR + routeDir + "/error.tsx";
  const notFoundPath = APP_DIR + routeDir + "/not-found.tsx";
  const templatePath = APP_DIR + routeDir + "/template.tsx";
  const hasErrorTsx = existsSync(errorPath);
  const hasNotFoundTsx = existsSync(notFoundPath);
  const hasTemplateTsx = existsSync(templatePath);
  const hasLoadingTsx = !!route.loadingPath;

  // Build imports. The page is pulled in as a namespace binding so the
  // entry can pluck `getServerData` / `action` / `metadata` /
  // `generateMetadata` off it dynamically — regex-detecting these
  // exports off raw source mis-fires when an example page literally
  // includes the source string of a `metadata` export inside a
  // template literal (see `examples/metadata`). Layouts + conventions
  // remain default imports so absent files don't drag undefined names
  // into the bundle; each layout ALSO gets a namespace binding for the
  // same reason as the page — its `metadata` / `generateMetadata` are
  // plucked off it (absent → undefined) and handed to runRoute as
  // `layoutMetadata`, aligned with `layouts`. The production wrappers
  // detect these exports by scanning source instead (see
  // `PrismRouteHandlers::from_source` in bext-core), so a re-export
  // (`export * from "./seo"`) or a multi-binding `export const` works
  // here and is dropped in production.
  let imports = "";
  for (let i = 0; i < route.layoutPaths.length; i++) {
    imports += `import __Layout${i} from "${route.layoutPaths[i]}";\nimport * as __LayoutNs${i} from "${route.layoutPaths[i]}";\n`;
  }
  imports += `import __PageMod from "${route.pagePath}";\nimport * as __PageNs from "${route.pagePath}";\n`;
  if (hasErrorTsx) imports += `import __ErrorBoundary from "${errorPath}";\n`;
  if (hasNotFoundTsx) imports += `import __NotFound from "${notFoundPath}";\n`;
  if (hasTemplateTsx) imports += `import __Template from "${templatePath}";\n`;
  if (hasLoadingTsx) imports += `import __Loading from "${route.loadingPath}";\n`;
  imports += `import { runRoute, encodeResult } from "@bext-stack/framework/prism-runtime";\n`;

  // Auto-discovered metadata file conventions (Next.js + bext):
  // `/icon.svg`, `/apple-icon.svg`, `/opengraph-image.svg`, `/twitter-image.svg`
  // in APP_DIR become <link rel="icon"> / og:image / twitter:image tags.
  // The Rust dispatcher walks these per-route; we only check APP_DIR
  // (root) — covers every demo and matches what bext-server emits.
  const metaFile = (name: string, ext: string): string | undefined => {
    return existsSync(`${APP_DIR}/${name}.${ext}`) ? `/${name}.${ext}` : undefined;
  };
  const iconUrl = metaFile("icon", "svg") ?? metaFile("icon", "png");
  const appleIconUrl = metaFile("apple-icon", "svg") ?? metaFile("apple-icon", "png");
  const opengraphImageUrl = metaFile("opengraph-image", "svg") ?? metaFile("opengraph-image", "png") ?? metaFile("opengraph-image", "jpg");
  const twitterImageUrl = metaFile("twitter-image", "svg") ?? metaFile("twitter-image", "png") ?? metaFile("twitter-image", "jpg");

  const layoutArray = route.layoutPaths.map((_, i) => `__Layout${i}`).join(", ");
  const layoutMetadataArray = route.layoutPaths
    .map((_, i) => `{ metadata: __LayoutNs${i}.metadata, generateMetadata: __LayoutNs${i}.generateMetadata }`)
    .join(", ");

  // For "use client" pages we substitute a stub component that renders an
  // empty placeholder; the client bundle hydrates the real page tree.
  // The stub returns a string (bext-jsx's Renderable contract).
  const pageBinding = pageIsClient
    ? `function() { return ${JSON.stringify(`<div id="__bext_client_page__" data-route="${routePath}"></div>`)}; }`
    : `(__PageMod.default ?? __PageMod)`;

  // Inline the island loader script that runRoute injects on pages that
  // emitted any <bext-island> elements. Mirrors `ISLAND_LOADER_SCRIPT` in
  // `crates/bext-server/src/ssr_pipeline/prism.rs:3032`.
  const islandLoaderHtml = `<script>(function(){var seen={};function load(name){if(seen[name])return;seen[name]=1;var s=document.createElement('script');s.src='/islands/'+name+'.js';document.head.appendChild(s);}document.querySelectorAll('bext-island[data-component]').forEach(function(el){load(el.dataset.component);});})();</script>`;

  const entry = `${imports}
globalThis.__bextPrismRender_${key} = async function(envelopeJson) {
  const envelope = envelopeJson ? JSON.parse(envelopeJson) : {};
  const result = await runRoute({
    Page: ${pageBinding},
    layouts: [${layoutArray}],
    layoutMetadata: [${layoutMetadataArray}],
    loader: __PageNs.getServerData ?? __PageNs.loader,
    action: __PageNs.action,
    errorBoundary: ${hasErrorTsx ? "(__ErrorBoundary?.default ?? __ErrorBoundary)" : "undefined"},
    notFoundComponent: ${hasNotFoundTsx ? "(__NotFound?.default ?? __NotFound)" : "undefined"},
    templateComponent: ${hasTemplateTsx ? "(__Template?.default ?? __Template)" : "undefined"},
    loadingComponent: ${hasLoadingTsx ? "(__Loading?.default ?? __Loading)" : "undefined"},
    staticMetadata: __PageNs.metadata,
    generateMetadata: __PageNs.generateMetadata,
    iconUrl: ${JSON.stringify(iconUrl ?? null)} ?? undefined,
    appleIconUrl: ${JSON.stringify(appleIconUrl ?? null)} ?? undefined,
    opengraphImageUrl: ${JSON.stringify(opengraphImageUrl ?? null)} ?? undefined,
    twitterImageUrl: ${JSON.stringify(twitterImageUrl ?? null)} ?? undefined,
    slots: undefined,
    envelope,
    islandLoaderHtml: ${JSON.stringify(islandLoaderHtml)},
  });
  return encodeResult(result);
};
`;

  const entryFile = CACHE_DIR + `/ssr_${key}.tsx`;
  writeFileSync(entryFile, entry);

  const runSSRBuild = (forcePassthrough = false) => Bun.build({
    entrypoints: [entryFile],
    outdir: CACHE_DIR + "/ssr",
    target: "bun",
    naming: `[name].[hash].js`,
    define: getBuildDefines(),
    plugins: [createNextCompatPlugin(), createIslandSSRPlugin({ forcePassthrough })],
    external: _external,
  });

  let result: any;
  try {
    result = await runSSRBuild();
  } catch (e: any) {
    try {
      result = await runSSRBuild(true);
      if (DEV) console.warn(`  [retry] ${routePath}: SSR fallback shell enabled`);
    } catch (fallbackError: any) {
      if (DEV) { console.error(`  [skip] ${routePath}:`, fallbackError); }
      return null;
    }
  }

  if (!result.success) {
    try {
      const fallback = await runSSRBuild(true);
      if (fallback.success) {
        result = fallback;
        if (DEV) console.warn(`  [retry] ${routePath}: SSR fallback shell enabled`);
      }
    } catch {}
  }

  if (!result.success) {
    if (DEV) {
      const logs = result.logs?.map((l: any) => l.message || String(l)).join("; ").substring(0, 300);
      console.error(`  [skip] ${routePath}: Bundle failed — ${logs || "no logs"} outputs=${result.outputs?.length}`);
    }
    return null;
  }

  const outFile = result.outputs[0]?.path;
  if (!outFile) return null;
  const js = readFileSync(outFile, "utf-8");
  ssrCache.set(routePath, { js, mtime: route.deepMtime, outFile });
  if (isRebuild) console.log(`  [rebuild] ${routePath}  (${(performance.now() - buildStart).toFixed(0)}ms)`);
  return js;
}

type PrismRouteResult =
  | { kind: "html"; body: string; hasIslands: boolean }
  | { kind: "response"; status: number; headers: Array<[string, string]>; body: string };

async function renderRoute(
  js: string,
  routePath: string,
  params: Record<string, any> = {},
  requestCtx?: any,
): Promise<PrismRouteResult> {
  const fnName = `__bextPrismRender_${routeKey(routePath)}`;

  // Build the envelope `runRoute()` expects. searchParams come from the
  // URL on the request side; we extract them once here so the call site
  // doesn't need to know the contract.
  const searchParams: Record<string, string | string[]> = {};
  if (requestCtx?.url) {
    try {
      const u = new URL(requestCtx.url);
      for (const [k, v] of u.searchParams) {
        const existing = searchParams[k];
        if (existing === undefined) searchParams[k] = v;
        else if (Array.isArray(existing)) existing.push(v);
        else searchParams[k] = [existing, v];
      }
    } catch {}
  }
  const envelope = {
    params,
    searchParams,
    request: requestCtx ?? {},
  };
  const envelopeJson = JSON.stringify(envelope);

  const callRender = async (fn: any): Promise<PrismRouteResult> => {
    const encoded: string = await fn(envelopeJson);
    return JSON.parse(encoded) as PrismRouteResult;
  };

  // Load the SSR bundle. Try import() first (supports ESM + import.meta),
  // fall back to new Function() for simpler bundles.
  const outFile = ssrCache.get(routePath)?.outFile;
  if (outFile && existsSync(outFile)) {
    try {
      await import(outFile + "?t=" + Date.now()); // cache bust
      const gFn = (globalThis as any)[fnName];
      if (typeof gFn === "function") return await callRender(gFn);
    } catch (e: any) {
      if (isRedirectLike(e) || isNotFoundLike(e)) throw e;
      try {
        const fn = new Function(js + `; return globalThis['${fnName}'];`)();
        if (typeof fn === "function") return await callRender(fn);
      } catch (fallbackError: any) {
        if (isRedirectLike(fallbackError) || isNotFoundLike(fallbackError)) throw fallbackError;
      }
      throw new Error(`SSR render failed for ${routePath}: ${e.message?.substring(0, 100)}`);
    }
  }

  try {
    const fn = new Function(js + `; return globalThis['${fnName}'];`)();
    if (typeof fn === "function") return await callRender(fn);
  } catch (e: any) {
    if (isRedirectLike(e) || isNotFoundLike(e)) throw e;
  }

  throw new Error(`Render function not found for ${routePath}`);
}

// ── Client bundles (full-page hydration + islands) ──────────────────────────

const clientManifest = new Map<string, string>();  // routePath → URL
const islandManifest = new Map<string, string>();  // islandName → URL (React)
const signalIslandManifest = new Map<string, string>();  // islandName → URL (signals)
let clientTracker: MtimeTracker;

/** Discover island components from:
 *  1. src/components/ and src/islands/ directories ("use client" files)
 *  2. discoveredIslands set (populated by the auto-island SSR plugin during compilation)
 */
function discoverIslands(): { name: string; filePath: string }[] {
  const seen = new Set<string>();
  const islands: { name: string; filePath: string }[] = [];

  function add(filePath: string) {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const name = filePath.split("/").pop()!.replace(/\.(tsx?|jsx?)$/, "");
    islands.push({ name, filePath });
  }

  // Static discovery: scan known directories
  const dirs = [ROOT + "/src/components", ROOT + "/src/islands"];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    function walk(d: string) {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        try {
          if (statSync(full).isDirectory()) { walk(full); continue; }
          if (/\.(tsx?|jsx?)$/.test(entry) && needsHydration(full)) add(full);
        } catch {}
      }
    }
    walk(dir);
  }

  // Dynamic discovery: islands found during SSR compilation
  for (const filePath of discoveredIslands) add(filePath);

  return islands;
}

/** Parallel discovery for `"use signals"` islands. These hydrate via
 *  the bext signals runtime (no React) — the dev pipeline emits a
 *  separate entry that imports `hydrateSignalsIsland`. */
function discoverSignalIslands(): { name: string; filePath: string }[] {
  const seen = new Set<string>();
  const islands: { name: string; filePath: string }[] = [];

  function add(filePath: string) {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    const name = filePath.split("/").pop()!.replace(/\.(tsx?|jsx?)$/, "");
    islands.push({ name, filePath });
  }

  const dirs = [ROOT + "/src/components", ROOT + "/src/islands"];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    function walk(d: string) {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        try {
          if (statSync(full).isDirectory()) { walk(full); continue; }
          if (/\.(tsx?|jsx?)$/.test(entry) && isSignalsIsland(full)) add(full);
        } catch {}
      }
    }
    walk(dir);
  }
  return islands;
}

async function buildClientBundles(opts: PrismOptions): Promise<void> {
  if (!clientTracker.changed()) return;
  const start = performance.now();

  // Clean old builds
  try { for (const f of readdirSync(CLIENT_DIR)) { if (f.endsWith(".js")) unlinkSync(CLIENT_DIR + "/" + f); } } catch {}

  const entrypoints: string[] = [];
  type EntryInfo =
    | { type: "page"; routePath: string; key: string }
    | { type: "island"; name: string; key: string }
    | { type: "signal-island"; name: string; key: string };
  const entries: EntryInfo[] = [];

  // Full-page hydration entries
  const pages = discoverPages();
  const clientPages = pages.filter(p => p.isClient);
  for (const page of clientPages) {
    const route = resolveRoute(page.routePath, page);
    if (!route) continue;
    const key = routeKey(page.routePath);
    const entry = `
import React from "react";
import { hydrateRoot } from "react-dom/client";
${route.imports}
var d = document.getElementById("__BEXT_DATA__");
var props = d ? JSON.parse(d.textContent || "{}") : {};
hydrateRoot(document, ${route.tree}, {
  onRecoverableError: function(e) { ${DEV ? 'console.warn("[prism]", e.message);' : ''} }
});
`;
    const entryFile = CACHE_DIR + `/client_${key}.tsx`;
    writeFileSync(entryFile, entry);
    entrypoints.push(entryFile);
    entries.push({ type: "page", routePath: page.routePath, key });
  }

  // Island hydration entries
  const islands = discoverIslands();
  for (const { name, filePath } of islands) {
    const relPath = filePath;
    const key = `island_${name}`;
    // Client entry: exports mount() so it can be re-called after SPA navigation
    const entry = `
import React from "react";
import { hydrateRoot, createRoot } from "react-dom/client";
import * as _mod from "${relPath}";
var C = _mod.default || _mod["${name}"] || Object.values(_mod)[0];

export function mount() {
  document.querySelectorAll('bext-island[data-component="${name}"]').forEach(function(el) {
    if (el.__prism) return; // already mounted
    var props = JSON.parse(el.dataset.props || "{}");

    // Restore server-rendered children from <template> store
    if (el.dataset.hasChildren === "1") {
      var tmpl = el.querySelector("template[data-island-children]");
      if (tmpl) {
        var html = tmpl.innerHTML;
        tmpl.remove();
        props.children = React.createElement("bext-children", {
          dangerouslySetInnerHTML: { __html: html },
          suppressHydrationWarning: true,
          style: { display: "contents" },
        });
      }
    }

    // First load: hydrateRoot (matches SSR HTML). After navigation: createRoot (fresh mount).
    var isHydration = el.hasAttribute("data-ssr");
    try {
      if (isHydration) {
        hydrateRoot(el, React.createElement(C, props), {
          onRecoverableError: function(e) { ${DEV ? 'console.warn("[prism:island]", e.message);' : ''} }
        });
      } else {
        createRoot(el).render(React.createElement(C, props));
      }
      el.__prism = true;
    } catch(e) { ${DEV ? 'console.error("[prism:island] mount error:", e);' : ''} }
  });
}
mount();
`;
    const entryFile = CACHE_DIR + `/${key}.tsx`;
    writeFileSync(entryFile, entry);
    entrypoints.push(entryFile);
    entries.push({ type: "island", name, key });
  }

  // Signals island entries — bext signals runtime, no React.
  const signalIslands = discoverSignalIslands();
  for (const { name, filePath } of signalIslands) {
    const key = `signal_island_${name}`;
    const entry = `
import { hydrateSignalsIsland } from "@bext-stack/framework/signals/hydrate";
import * as _mod from "${filePath}";
var C = _mod.default || _mod["${name}"] || Object.values(_mod)[0];

export function mount() {
  document.querySelectorAll('bext-island[data-runtime="signals"][data-component="${name}"]').forEach(function(el) {
    if (el.__bs_mounted) return;
    var props = {};
    try { props = JSON.parse(el.dataset.props || "{}"); } catch(_) {}
    try {
      hydrateSignalsIsland(el, C, props);
      el.__bs_mounted = true;
    } catch(e) { ${DEV ? 'console.error("[signals]","' + name + '",e);' : ''} }
  });
}
mount();
`;
    const entryFile = CACHE_DIR + `/${key}.tsx`;
    writeFileSync(entryFile, entry);
    entrypoints.push(entryFile);
    entries.push({ type: "signal-island", name, key });
  }

  if (entrypoints.length === 0) { clientTracker.mark(); return; }

  // Single build with splitting — React shared across ALL entries (pages + islands).
  // Server-only packages are externalized to avoid "cannot require Node.js builtin" errors.
  const serverOnlyPackages = [
    ..._external,
    // Node.js builtins that can't be polyfilled for browser
    "zlib", "node:zlib", "fs", "node:fs", "path", "node:path", "crypto", "node:crypto",
    "http", "node:http", "https", "node:https", "net", "node:net", "tls", "node:tls",
    "dns", "node:dns", "stream", "node:stream", "child_process", "node:child_process",
    "os", "node:os", "util", "node:util", "http2", "node:http2",
    "worker_threads", "node:worker_threads", "cluster", "node:cluster",
    // Server-only packages
    "ioredis", "redis", "pg", "mysql2", "better-sqlite3", "sqlite3",
    "@prisma/client", "prisma", "drizzle-orm",
    "playwright", "playwright-core", "puppeteer", "puppeteer-core",
    "sharp", "jimp", "canvas",
    "bcrypt", "argon2", "scrypt",
    "nodemailer", "bullmq", "bull",
    "@aws-sdk/*", "aws-sdk",
    "stripe",
    "openai", "@anthropic-ai/sdk",
    "next-auth", "@auth/core",
    "@trpc/server", "@trpc/client",
    "convex",
    "node-fetch", "undici",
    "ws", "socket.io",
  ];
  const result = await Bun.build({
    entrypoints,
    outdir: CLIENT_DIR,
    target: "browser",
    splitting: entrypoints.length > 1,
    plugins: [createNextCompatPlugin()],
    minify: !DEV,
    sourcemap: DEV ? "linked" : "none",
    naming: { entry: "[name].[hash].js", chunk: "vendor-[hash].js" },
    define: getBuildDefines(),
    external: serverOnlyPackages,
  });

  if (!result.success) {
    // Don't fail — log errors and continue serving without client hydration.
    // SSR still works; only client-side interactivity for failed pages is lost.
    const errorCount = result.logs.filter((l: any) => l.level === "error").length;
    console.log(`  client  ${errorCount} build errors (hydration disabled for affected pages)`);
    if (DEV) {
      for (const log of result.logs.slice(0, 5)) {
        if (log.level === "error") console.log(`          ${log.message?.substring(0, 100)}`);
      }
    }
  }

  clientManifest.clear();
  islandManifest.clear();
  signalIslandManifest.clear();
  for (const [k] of gzipCache) { if (k.includes("/_bext/")) gzipCache.delete(k); }

  let pageSize = 0, islandSize = 0, signalIslandSize = 0, vendorSize = 0;
  const vendors: string[] = [];

  for (const output of result.outputs) {
    const fileName = output.path.split("/").pop()!;
    if (!fileName.endsWith(".js")) continue;

    if (fileName.startsWith("vendor-")) {
      vendorSize += output.size;
      vendors.push(fileName);
      continue;
    }

    for (const e of entries) {
      // Match output filename to entry: Bun uses input filename as base.
      const prefix = e.type === "page" ? `client_${e.key}.` : `${e.key}.`;
      if (fileName.startsWith(prefix)) {
        if (e.type === "page") {
          clientManifest.set(e.routePath, `/_bext/${fileName}`);
          pageSize += output.size;
        } else if (e.type === "signal-island") {
          signalIslandManifest.set(e.name, `/_bext/${fileName}`);
          signalIslandSize += output.size;
        } else {
          islandManifest.set(e.name, `/_bext/${fileName}`);
          islandSize += output.size;
        }
      }
    }
  }

  clientTracker.mark();

  // Logging
  const total = pageSize + islandSize + signalIslandSize + vendorSize;
  const parts: string[] = [];
  if (clientPages.length) parts.push(`${clientPages.length} page${clientPages.length > 1 ? "s" : ""}`);
  if (islands.length) parts.push(`${islands.length} island${islands.length > 1 ? "s" : ""}`);
  if (signalIslands.length) parts.push(`${signalIslands.length} signal${signalIslands.length > 1 ? "s" : ""}`);
  if (vendors.length) parts.push(`${vendors.length} vendor`);
  console.log(`  client  ${(total / 1024).toFixed(1)} KB  ${parts.join(" + ")}  (${(performance.now() - start).toFixed(0)}ms)`);

  if (DEV) {
    for (const e of entries) {
      const file = e.type === "page"
        ? clientManifest.get(e.routePath)
        : (e.type === "signal-island"
            ? signalIslandManifest.get(e.name)
            : islandManifest.get(e.name));
      if (file) try {
        const size = statSync(CLIENT_DIR + "/" + file.split("/").pop()).size;
        const label = e.type === "page"
          ? e.routePath
          : (e.type === "signal-island" ? `signal:${e.name}` : `island:${e.name}`);
        console.log(`          ${label} → ${(size / 1024).toFixed(1)} KB`);
      } catch {}
    }
    for (const v of vendors) try { console.log(`          vendor → ${(statSync(CLIENT_DIR + "/" + v).size / 1024).toFixed(1)} KB`); } catch {}
  }
}

function getClientFile(routePath: string): string | null {
  return clientManifest.get(routePath) ?? null;
}

function getPreloadHints(): string {
  let hints = "";
  try { for (const f of readdirSync(CLIENT_DIR)) { if (f.startsWith("vendor-") && f.endsWith(".js")) hints += `<link rel="modulepreload" href="/_bext/${f}" />\n`; } } catch {}
  return hints;
}

/** Generate the island loader script tag if the HTML contains <bext-island> elements.
 *  Routes elements by `data-runtime`: "signals" → signalIslandManifest,
 *  anything else → React islandManifest. Both kinds coexist on a page. */
function getIslandInjection(html: string): string {
  if (!html.includes("<bext-island")) return "";
  if (islandManifest.size === 0 && signalIslandManifest.size === 0) return "";

  const reactManifest: Record<string, string> = {};
  for (const [name, url] of islandManifest) reactManifest[name] = url;
  const sigManifest: Record<string, string> = {};
  for (const [name, url] of signalIslandManifest) sigManifest[name] = url;

  // The loader imports each island module and calls mount().
  // mount() is idempotent — it skips already-mounted elements (el.__prism
  // or el.__bs_mounted). After SPA navigation, mount() is called again
  // to hydrate new islands.
  return `<script type="module">
(function(){
var rm=${JSON.stringify(reactManifest)};
var sm=${JSON.stringify(sigManifest)};
document.querySelectorAll("bext-island[data-component]").forEach(function(el){
  if(el.__prism||el.__bs_mounted)return;
  var n=el.dataset.component,rt=el.dataset.runtime;
  var u=(rt==="signals")?sm[n]:rm[n];
  if(!u)return;
  function go(){import(u).then(function(mod){if(mod.mount)mod.mount()}).catch(function(e){console.error("[bext:island]",n,e)})}
  var lazy=el.dataset.lazy;
  if(lazy==="visible"&&"IntersectionObserver"in window){
    new IntersectionObserver(function(es,io){es.forEach(function(e){if(e.isIntersecting){io.disconnect();go()}})},{rootMargin:"200px"}).observe(el);
  }else if(lazy==="idle"&&"requestIdleCallback"in window){requestIdleCallback(go)}
  else{go()}
});
})();
</script>`;
}

// ── API routes (src/app/api/**/route.ts) ────────────────────────────────────
//
// Convention: src/app/api/users/route.ts exports GET, POST, PUT, DELETE, etc.
// Each handler receives (request: Request, params: Record<string, string>)
// and returns a Response.

interface ApiRoute {
  routePath: string;    // "/api/users" or "/api/users/[id]"
  filePath: string;
  isDynamic: boolean;
}

function discoverApiRoutes(): ApiRoute[] {
  const apiDir = APP_DIR + "/api";
  if (!existsSync(apiDir)) return [];
  const routes: ApiRoute[] = [];

  function walk(dir: string, prefix: string) {
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry === "route.ts" || entry === "route.tsx" || entry === "route.js") {
          const routePath = "/api" + (prefix || "");
          routes.push({ routePath, filePath: full, isDynamic: routePath.includes("[") });
        } else {
          try {
            if (statSync(full).isDirectory() && !entry.startsWith(".")) {
              walk(full, prefix + "/" + entry);
            }
          } catch {}
        }
      }
    } catch {}
  }
  walk(apiDir, "");
  return routes;
}

// Cache compiled API route handlers
const apiHandlerCache = new Map<string, { handler: any; mtime: number }>();

async function loadApiHandler(route: ApiRoute): Promise<any> {
  const mtime = deepMtime(route.filePath);
  const cached = apiHandlerCache.get(route.routePath);
  if (cached && cached.mtime >= mtime) return cached.handler;

  // Compile the API route via Bun.build
  const key = routeKey(route.routePath);
  const entry = `
import * as _mod from "${route.filePath}";
globalThis.__api_${key} = _mod;
`;
  const entryFile = CACHE_DIR + `/api_${key}.tsx`;
  writeFileSync(entryFile, entry);

  const result = await Bun.build({
    entrypoints: [entryFile],
    outdir: CACHE_DIR + "/api",
    target: "bun",
    naming: `[name].[hash].js`,
    define: getBuildDefines(),
  });

  if (!result.success) {
    console.error(`[prism:api] build failed for ${route.routePath}:`, result.logs);
    return null;
  }

  const outFile = result.outputs[0]?.path || CACHE_DIR + `/api/${key}.js`;
  try {
    await import(outFile + "?t=" + Date.now());
  } catch {
    const js = readFileSync(outFile, "utf-8");
    new Function(js)();
  }
  const handler = (globalThis as any)[`__api_${key}`];
  apiHandlerCache.set(route.routePath, { handler, mtime });
  return handler;
}

function matchApiRoute(path: string, routes: ApiRoute[]): { route: ApiRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (!route.isDynamic && route.routePath === path) return { route, params: {} };
  }
  for (const route of routes) {
    if (!route.isDynamic) continue;
    const params = matchDynamic(path, route.routePath);
    if (params) return { route, params };
  }
  return null;
}

// ── Server actions ("use server" functions) ─────────────────────────────────
//
// Convention: functions marked with "use server" inside "use client" components
// or standalone server action files are extracted and accessible via POST to
// /_bext/action/{actionId}
//
// For now, PRISM supports server actions defined as standalone exports:
//   // src/actions/newsletter.ts
//   "use server";
//   export async function subscribe(formData: FormData) { ... }
//
// Client components call them via:
//   <form action="/_bext/action/subscribe" method="POST">

interface ServerAction {
  name: string;
  filePath: string;
}

function discoverServerActions(): ServerAction[] {
  const actionsDir = ROOT + "/src/actions";
  if (!existsSync(actionsDir)) return [];
  const actions: ServerAction[] = [];

  for (const entry of readdirSync(actionsDir)) {
    const full = join(actionsDir, entry);
    if (!/\.(tsx?|jsx?|js)$/.test(entry)) continue;
    try {
      const src = readFileSync(full, "utf-8");
      if (src.trimStart().startsWith('"use server"') || src.trimStart().startsWith("'use server'")) {
        // Scan exports
        const exportNames = scanExports(src);
        for (const name of exportNames) {
          if (name !== "default") actions.push({ name, filePath: full });
        }
      }
    } catch {}
  }
  return actions;
}

const actionHandlerCache = new Map<string, { handler: any; mtime: number }>();

async function loadActionHandler(action: ServerAction): Promise<Function | null> {
  const mtime = deepMtime(action.filePath);
  const cached = actionHandlerCache.get(action.name);
  if (cached && cached.mtime >= mtime) return cached.handler;

  const key = `action_${action.name}`;
  const entry = `import { ${action.name} } from "${action.filePath}";\nglobalThis.__${key} = ${action.name};`;
  const entryFile = CACHE_DIR + `/${key}.tsx`;
  writeFileSync(entryFile, entry);

  const result = await Bun.build({
    entrypoints: [entryFile],
    outdir: CACHE_DIR + "/actions",
    target: "bun",
    naming: `[name].[hash].js`,
  });

  if (!result.success) return null;
  const js = readFileSync(CACHE_DIR + `/actions/${key}.js`, "utf-8");
  new Function(js)();
  const handler = (globalThis as any)[`__${key}`];
  actionHandlerCache.set(action.name, { handler, mtime });
  return typeof handler === "function" ? handler : null;
}

// ── Client navigation runtime ───────────────────────────────────────────────

import { clientRuntime } from "./client";

/** Injects the client-side navigation script (SPA-like link interception).
 *  Fresh HTML is fetched on every navigation — no polling needed. */
function getClientScript(): string {
  return clientRuntime({ navigation: true, liveReload: false });
}

// ── Environment variables ─────────────────────────────────────────────────���─

function loadEnvFiles() {
  const cwd = process.cwd();
  const nodeEnv = process.env.NODE_ENV || "development";
  // Priority: .env.local > .env.{NODE_ENV}.local > .env.{NODE_ENV} > .env
  const files = [
    join(cwd, ".env"),
    join(cwd, `.env.${nodeEnv}`),
    join(cwd, `.env.${nodeEnv}.local`),
    join(cwd, ".env.local"),
  ];
  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let value = trimmed.substring(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Don't override existing env vars
        if (!(key in process.env)) {
          process.env[key] = value;
        }
      }
    } catch {}
  }
}

// ── Build defines (env var inlining) ────────────────────────────────────────

/** Build `define` map that inlines NEXT_PUBLIC_* and common env vars into bundles. */
function getBuildDefines(): Record<string, string> {
  const defines: Record<string, string> = {
    "process.env.NODE_ENV": `"production"`,
  };
  // Inline all NEXT_PUBLIC_* env vars (accessible in client bundles)
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value !== undefined) {
      defines[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  return defines;
}

// ── HTML response cache (production only) ───────────────────────────────────

const htmlCache = new Map<string, { html: string; mtime: number }>();

// Fast-path response cache. Pre-computes everything that
// `htmlResponse()` would do (gzip body, ETag, headers map) at
// cache-set time so a cache-hit request is a single map lookup +
// `new Response(...)` — no `fnv1a()` of the body, no
// `gzipSync()`, no `resolveRoute()` / `deepMtime()` FS walk per
// request. Trades ~2× memory for the gzipped HTML to take cache-
// hit p50 from ~3 ms down to ~0.1 ms.
//
// Invalidated whenever `htmlCache.set` is called (every fresh
// render path or prerender) — those two stay in lock-step.
interface FastResponseEntry {
  raw: Buffer;       // identity-encoded body
  gz: Buffer;        // gzip-encoded body
  etag: string;
  ct: string;        // content-type
}
const fastCache = new Map<string, FastResponseEntry>();

// Bun accepts Node Buffers as response bodies at runtime. The DOM BodyInit
// declaration is narrower because Buffer's backing store can be shared.
function bufferBody(buffer: Buffer): BodyInit {
  return buffer as unknown as BodyInit;
}

function fastCacheSet(path: string, html: string): void {
  const raw = Buffer.from(html);
  const etag = `"${fnv1a(raw)}"`;
  fastCache.set(path, {
    raw,
    gz: gzipSync(raw),
    etag,
    ct: "text/html; charset=utf-8",
  });
}

function fastCacheRespond(entry: FastResponseEntry, acceptGzip: boolean, ifNoneMatch: string): Response {
  if (ifNoneMatch === entry.etag) {
    return new Response(null, { status: 304, headers: { "ETag": entry.etag } });
  }
  if (acceptGzip) {
    return new Response(bufferBody(entry.gz), {
      headers: {
        "Content-Type": entry.ct,
        "Content-Encoding": "gzip",
        "Vary": "Accept-Encoding",
        "ETag": entry.etag,
        "x-bext-mode": "prism-bun",
        "x-bext-cache": "hit",
        "Server-Timing": "cache-lookup;dur=0.00",
      },
    });
  }
  return new Response(bufferBody(entry.raw), {
    headers: {
      "Content-Type": entry.ct,
      "ETag": entry.etag,
      "x-bext-mode": "prism-bun",
      "x-bext-cache": "hit",
      "Server-Timing": "cache-lookup;dur=0.00",
    },
  });
}

// ── Compression + ETags + Timing ────────────────────────────────────────────

const MIME: Record<string, string> = {
  css: "text/css", js: "text/javascript", mjs: "text/javascript",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf",
  json: "application/json", xml: "application/xml", txt: "text/plain",
  html: "text/html", webmanifest: "application/manifest+json",
};
const COMPRESSIBLE = new Set(["css", "js", "mjs", "json", "xml", "txt", "html", "svg"]);
const gzipCache = new Map<string, { buf: Buffer; mtime: number; etag: string }>();

/** FNV-1a hash for fast ETag generation. */
function fnv1a(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function serveStatic(path: string, acceptGzip: boolean, ifNoneMatch: string): Response | null {
  const filePath = PUBLIC_DIR + path;
  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(filePath); if (!stat.isFile()) return null; } catch { return null; }
  const ext = path.split(".").pop() || "";
  const isHashed = /\.[a-z0-9]{6,}\.(js|css|mjs)$/.test(path);
  const headers: Record<string, string> = {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": isHashed ? "public, max-age=31536000, immutable" : "public, max-age=60",
  };

  if (COMPRESSIBLE.has(ext) && acceptGzip) {
    let cached = gzipCache.get(filePath);
    if (!cached || cached.mtime < stat.mtimeMs) {
      const raw = readFileSync(filePath);
      cached = { buf: gzipSync(raw), mtime: stat.mtimeMs, etag: `"${fnv1a(raw)}"` };
      gzipCache.set(filePath, cached);
    }
    headers["ETag"] = cached.etag;
    if (ifNoneMatch === cached.etag) return new Response(null, { status: 304, headers });
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    return new Response(bufferBody(cached.buf), { headers });
  }

  // Non-compressible: use mtime-based ETag
  const etag = `"${stat.mtimeMs.toString(36)}"`;
  headers["ETag"] = etag;
  if (ifNoneMatch === etag) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(filePath), { headers });
}

interface HtmlResponseOpts {
  status?: number;
  /** Render duration in milliseconds — emitted in `Server-Timing` and
   *  used by the bun PRISM mode to mirror what bext-server's V8 path
   *  reports through `x-bext-render-count` + `server-timing`. */
  renderMs?: number;
  /** Whether this body came out of the in-memory `htmlCache` (`"hit"`)
   *  or was rendered fresh on this request (`"miss"`). Surfaces as
   *  `x-bext-cache` so the same observability tooling that watches
   *  the V8 path can read the bun path identically. */
  cache?: "hit" | "miss";
  /** True when the request opted into inspect mode (?bext_inspect=1)
   *  and the inline runtime was injected. Surfaces as the
   *  `x-bext-inspect-bundle` response header so the designer-prism
   *  builder can fail loud if the iframe is served by an old
   *  framework that doesn't speak the handshake. */
  inspectMode?: boolean;
}

function htmlResponse(
  body: string,
  acceptGzip: boolean,
  optsOrStatus: HtmlResponseOpts | number = {},
  legacyTiming?: number,
): Response {
  // Backwards-compat: callers in this file still pass `(body, gz, 200, renderMs)`.
  // Newer callers can pass `(body, gz, { status, renderMs, cache })`.
  const opts: HtmlResponseOpts = typeof optsOrStatus === "number"
    ? { status: optsOrStatus, renderMs: legacyTiming }
    : optsOrStatus;
  const status = opts.status ?? 200;

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "x-bext-mode": "prism-bun",
  };
  if (opts.cache) headers["x-bext-cache"] = opts.cache;
  if (opts.renderMs !== undefined) {
    headers["Server-Timing"] = `render;dur=${opts.renderMs.toFixed(2)}`;
  } else if (opts.cache === "hit") {
    // Cache hits don't render; surface a near-zero lookup measurement
    // so dashboards that scrape `server-timing` always have a value.
    headers["Server-Timing"] = "cache-lookup;dur=0.00";
  }
  if (opts.inspectMode) headers[INSPECT_HEADER] = inspectHeaderValue();

  // ETag for HTML (enables 304 responses)
  const etag = `"${fnv1a(body)}"`;
  headers["ETag"] = etag;

  if (acceptGzip) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    return new Response(gzipSync(Buffer.from(body)), { status, headers });
  }
  return new Response(body, { status, headers });
}

// ── Dev error overlay ───────────────────────────────────────────────────────

function devErrorHtml(path: string, error: Error): string {
  const msg = escHtml(error.message);
  const stack = escHtml(error.stack || "").replace(/\n/g, "<br>");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PRISM Error</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #0a0a0a; color: #fafafa; display: flex; justify-content: center; padding: 4rem 2rem; }
  .card { max-width: 700px; width: 100%; }
  .badge { display: inline-block; background: #ef4444; color: white; font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.5rem; border-radius: 4px; margin-bottom: 1rem; letter-spacing: 0.02em; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0.5rem 0; color: #fafafa; }
  .path { color: #a1a1aa; font-size: 0.875rem; margin-bottom: 1.5rem; }
  .message { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 1.25rem; font-family: 'JetBrains Mono', monospace; font-size: 0.875rem; line-height: 1.6; color: #fca5a5; word-break: break-word; }
  .stack { background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 1rem; margin-top: 1rem; font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; line-height: 1.8; color: #71717a; overflow-x: auto; }
  .footer { margin-top: 2rem; font-size: 0.75rem; color: #52525b; }
</style></head>
<body><div class="card">
  <div class="badge">PRISM RENDER ERROR</div>
  <h1>${msg}</h1>
  <div class="path">${escHtml(path)}</div>
  <div class="message">${msg}</div>
  <div class="stack">${stack}</div>
  <div class="footer">This error overlay is only shown in development mode.</div>
</div></body></html>`;
}

// ── Entry point ─────────────────────────────────────────────────────────────

export function createServer(opts: PrismOptions = {}) {
  // Load .env files (if present) — .env.local > .env.{NODE_ENV} > .env
  loadEnvFiles();

  const port = opts.port ?? parseInt(process.env.PORT || "3000", 10);
  DEV = (opts.mode ?? (process.env.NODE_ENV === "production" ? "production" : "development")) === "development";
  _external = opts.external ?? [];
  _stub = opts.stub ?? [];
  _invisibleSegments = opts.invisibleSegments ?? [];

  // Auto-detect root
  if (opts.root) {
    ROOT = resolve(opts.root);
  } else {
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      if (existsSync(dir + "/src/app/layout.tsx")) { ROOT = dir; break; }
      if (existsSync(dir + "/../src/app/layout.tsx")) { ROOT = resolve(dir, ".."); break; }
      dir = resolve(dir, "..");
    }
    if (!ROOT) ROOT = process.cwd();
  }

  APP_DIR = ROOT + "/src/app";
  CACHE_DIR = ROOT + "/.bext";
  PUBLIC_DIR = ROOT + "/public";
  CLIENT_DIR = PUBLIC_DIR + "/_bext";

  mkdirSync(CACHE_DIR + "/ssr", { recursive: true });
  mkdirSync(CACHE_DIR + "/api", { recursive: true });
  mkdirSync(CACHE_DIR + "/actions", { recursive: true });
  mkdirSync(CACHE_DIR + "/mw", { recursive: true });
  mkdirSync(CLIENT_DIR, { recursive: true });

  if (!existsSync(APP_DIR + "/layout.tsx")) {
    console.error(`[prism] fatal: no layout at ${APP_DIR}/layout.tsx`);
    process.exit(1);
  }

  const cssDirs = [ROOT + "/src", ...(opts.css?.extraSources ?? []).map(s => resolve(ROOT, s))];
  cssTracker = new MtimeTracker(cssDirs);
  clientTracker = new MtimeTracker(cssDirs);

  _pages = discoverPages();
  const islands = discoverIslands();
  _apiRoutes = discoverApiRoutes();
  _serverActions = discoverServerActions();
  const clientCount = _pages.filter(p => p.isClient).length;
  const staticCount = _pages.filter(p => !p.isClient && !p.isDynamic).length;
  const dynamicCount = _pages.filter(p => p.isDynamic).length;

  const siteName = ROOT.split("/").pop();
  console.log(`\n  PRISM  ${siteName}`);
  let stats = `${_pages.length} pages`;
  const details: string[] = [];
  if (staticCount) details.push(`${staticCount} static`);
  if (clientCount) details.push(`${clientCount} hydrated`);
  if (dynamicCount) details.push(`${dynamicCount} dynamic`);
  if (islands.length) details.push(`${islands.length} island${islands.length > 1 ? "s" : ""}`);
  if (_apiRoutes.length) details.push(`${_apiRoutes.length} API`);
  if (_serverActions.length) details.push(`${_serverActions.length} action${_serverActions.length > 1 ? "s" : ""}`);
  if (details.length) stats += ` (${details.join(", ")})`;
  console.log(`  ${stats}  ${DEV ? "dev" : "prod"}\n`);

  const hasMiddleware = existsSync(APP_DIR + "/middleware.ts");
  if (hasMiddleware) console.log(`  middleware enabled`);

  // Build order: CSS + middleware → SSR (parallel) → client bundles → prerender
  const startup = async () => {
    await Promise.all([ensureCSS(opts), loadMiddleware()]);

    // Pre-compile static pages to discover islands. Errors are non-fatal —
    // failed pages will be compiled on-demand when first requested.
    const staticPages = _pages.filter(p => !p.isDynamic);
    let compiled = 0, failed = 0;
    for (const p of staticPages) {
      try {
        await compilePage(p.routePath, p);
        compiled++;
      } catch {
        failed++;
      }
    }
    if (failed) console.log(`  ssr     ${compiled} compiled, ${failed} deferred`);

    try { await buildClientBundles(opts); } catch (e: any) {
      console.log(`  client  build failed (SSR-only mode): ${e.message?.substring(0, 80)}`);
    }

    // Pre-render static _pages (no getServerData, no auth) into HTML cache
    if (!DEV) {
      const prerendered: string[] = [];
      for (const page of staticPages) {
        const src = readFileSync(page.pagePath, "utf-8");
        const hasServerData = /export\s+(async\s+)?function\s+getServerData/.test(src);
        // `renderingMode = "streaming"` pages are explicitly opt-in to
        // per-request live rendering (async generators feeding the
        // body chunk-by-chunk). Caching their output defeats the
        // point — every request would echo the same timestamp /
        // streamed content. Skip both prerender and the runtime
        // htmlCache for these.
        if (hasServerData || page.isClient || page.isStreaming) continue;

        const js = ssrCache.get(page.routePath)?.js;
        if (!js) continue;
        try {
          const result = await renderRoute(js, page.routePath, {});
          // A loader/action returning a Response on a static prerender
          // means the page can't be cached as html — skip it.
          if (result.kind !== "html") continue;
          let html = result.body;
          const clientFile = getClientFile(page.routePath);
          const meta = extractMetadata(page.pagePath);
          if (meta) html = injectMetadata(html, meta);

          // runRoute already injects the island loader when hasIslands is
          // true. We only fall back to the legacy `<bext-island>` injection
          // path for pages we couldn't classify (older fixtures).
          if (!clientFile && !result.hasIslands) {
            const islandScript = getIslandInjection(html);
            if (islandScript) {
              const preloads = getPreloadHints();
              if (preloads) html = html.replace("</head>", `${preloads}</head>`);
              html = html.replace("</body>", `${islandScript}\n</body>`);
            }
          }

          // Per-route Tailwind injection — must run on the prerender path
          // too because static pages get served straight out of htmlCache
          // without re-running the request-time injection. Mirrors what
          // bext-server's ISR cache stores (post-injection HTML).
          html = await injectRouteCss(ROOT, html);

          const route = resolveRoute(page.routePath, page);
          if (route) {
            htmlCache.set(page.routePath, { html, mtime: route.deepMtime });
            fastCacheSet(page.routePath, html);
          }
          prerendered.push(page.routePath);
        } catch {}
      }
      if (prerendered.length) {
        console.log(`  prerender ${prerendered.length} pages  (${prerendered.join(", ")})`);
      }
    }
  };

  startup().catch((e: any) => {
    console.error(`[prism:start] warmup failed:`, e?.message ?? e);
    if (DEV && e?.stack) console.error(e.stack);
  });

  // Pre-compute hot-path eligibility once. Anything that can change at
  // request-time (auth, DEV mode, method) has to be re-checked, but the
  // boolean flags below are constant for the lifetime of the process.
  const hotPathEnabled = !DEV && !opts.auth;

  const serveOpts: any = {
    port,
    fetch(request: Request) {
      // Pluck the pathname directly from `request.url` without
      // constructing a `URL` object. `request.url` is always
      // `${scheme}://${host}${pathname}${search}`; we just walk past
      // the scheme (`://`) and host and chop on the first `?`. Saves
      // ~40 µs per request vs `new URL(...).pathname` — dominant cost
      // at 38 k req/s on the cache-hit hot path.
      const u = request.url;
      const slash = u.indexOf("/", u.indexOf("//") + 2);
      const q = u.indexOf("?", slash + 1);
      let path = q >= 0 ? u.slice(slash, q) : u.slice(slash);
      if (path.length > 1 && path.charCodeAt(path.length - 1) === 47 /* "/" */) {
        path = path.slice(0, -1);
      }

      // Inline hot-path. Skips the entire async `handleRequest` call
      // (and its accompanying async-await frame setup) when the route
      // already has a pre-built response in `fastCache`. Method check
      // covers `GET` (cache-hittable) and `HEAD` (cache-hittable but
      // we strip the body in fastCacheRespond by way of 304 fallback
      // — close enough; clients calling HEAD on a cacheable page
      // mostly want the headers, which match the GET response).
      if (hotPathEnabled) {
        const m = request.method;
        if (m === "GET" || m === "HEAD") {
          const fast = fastCache.get(path);
          if (fast) {
            const acceptGzip = (request.headers.get("accept-encoding") ?? "").includes("gzip");
            const ifNoneMatch = request.headers.get("if-none-match") ?? "";
            return fastCacheRespond(fast, acceptGzip, ifNoneMatch);
          }
        }
      }

      // Cache miss / mutating method / DEV / auth — fall through to
      // the full pipeline. This is the slow path; we only spin up the
      // async machinery when we actually need it.
      return handleSlowPath(request, path, opts);
    },
  };

  async function handleSlowPath(request: Request, path: string, opts: PrismOptions): Promise<Response> {
    const reqStart = performance.now();
    const acceptGzip = (request.headers.get("accept-encoding") ?? "").includes("gzip");
    const ifNoneMatch = request.headers.get("if-none-match") ?? "";
    try {
      return await handleRequest(request, path, acceptGzip, ifNoneMatch, reqStart, opts);
    } catch (e: any) {
      console.error(`[prism] unhandled error on ${request.method} ${path}:`, e.message);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
  if (opts.tls) serveOpts.tls = opts.tls;
  if (opts.h3) serveOpts.h3 = true;
  // Bind address — default 0.0.0.0 so reverse proxies (or direct
  // public access for demo-bun.bext.dev) work without explicit
  // configuration. Tightening to `127.0.0.1` is the right call when
  // bext-server fronts the bun process.
  const hostname = opts.hostname ?? process.env.HOST;
  if (hostname) serveOpts.hostname = hostname;
  if (opts.idleTimeout !== undefined) serveOpts.idleTimeout = opts.idleTimeout;
  if (opts.maxRequestBodySize !== undefined) serveOpts.maxRequestBodySize = opts.maxRequestBodySize;
  const server = Bun.serve(serveOpts);

  // Graceful shutdown — systemd sends SIGTERM on `systemctl
  // restart`/`stop`. `server.stop(false)` lets in-flight requests
  // finish; the process exits naturally once all sockets drain. The
  // 5s deadline matches the systemd unit's `RestartSec=5` so a
  // restart finishes inside the watchdog window. SIGINT (Ctrl-C from
  // a terminal) follows the same path.
  const SHUTDOWN_DEADLINE_MS = 5000;
  const stopServer = (signal: string) => {
    console.log(`[prism] received ${signal}, draining in-flight requests…`);
    const start = performance.now();
    let exited = false;
    const exit = (code: number, reason: string) => {
      if (exited) return;
      exited = true;
      const elapsed = (performance.now() - start).toFixed(0);
      console.log(`[prism] shutdown ${reason} after ${elapsed}ms`);
      process.exit(code);
    };
    setTimeout(() => exit(1, "deadline (forced)"), SHUTDOWN_DEADLINE_MS);
    Promise.resolve(server.stop(false)).then(() => exit(0, "complete")).catch(() => exit(1, "stop() failed"));
  };
  process.on("SIGTERM", () => stopServer("SIGTERM"));
  process.on("SIGINT", () => stopServer("SIGINT"));

  const proto = opts.tls ? "https" : "http";
  console.log(`\n  ${proto}://localhost:${port}${opts.h3 ? "  (h1+h2+h3)" : ""}\n`);
}

async function handleRequest(
  request: Request, path: string, acceptGzip: boolean,
  ifNoneMatch: string, reqStart: number, opts: PrismOptions,
): Promise<Response> {

        // Inspect mode (`?bext_inspect=1`) bypasses every HTML cache so
        // the inline runtime script gets re-injected on every request.
        // The flag is rare (operator builder previews), so the cache
        // miss cost is negligible. See ./inspect.ts.
        const inspectMode = isInspectRequest(request);

        // Hot-path: pre-built response for cached HTML pages. Skips the
        // entire request pipeline (statSync for static files, route
        // matching, resolveRoute's deepMtime FS walk, htmlResponse's
        // fnv1a + gzip cycle) — for production sites with warm caches
        // this is what almost every request hits. Limited to GET / HEAD
        // because mutations need to invalidate / re-render.
        if (!DEV && (request.method === "GET" || request.method === "HEAD") && !opts.auth && !inspectMode) {
          const fast = fastCache.get(path);
          if (fast) return fastCacheRespond(fast, acceptGzip, ifNoneMatch);
        }

        // Incremental rebuilds (dev only — prod builds once at startup)
        if (DEV) {
          await ensureCSS(opts);
          try { await buildClientBundles(opts); } catch {}
        } else if (path === "/styles.css" && (!existsSync(PUBLIC_DIR + "/styles.css") || cssTracker.changed())) {
          await ensureCSS(opts);
        }

        // Static files
        const staticRes = serveStatic(path, acceptGzip, ifNoneMatch);
        if (staticRes) return staticRes;

        // SEO
        if (path === "/robots.txt") {
          return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain" } });
        }

        // Health endpoint — bext-server exposes `/__bext/health` for the
        // systemd unit + uptime monitors; mirroring it here lets the same
        // probe configuration work against demo-bun.bext.dev. Shape
        // matches enough fields that monitoring scripts checking `.status`
        // / `.uptime_secs` work uniformly.
        if (path === "/__bext/health") {
          return Response.json({
            status: "ok",
            mode: "prism-bun",
            pages: _pages.length,
            uptime_secs: Math.floor(process.uptime()),
            pid: process.pid,
            memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
          });
        }

        // Middleware: runs before API routes and _pages. When the
        // module exports `config.matcher`, paths that don't match are
        // skipped entirely — mirrors the bext-server Rust dispatcher
        // policy at crates/bext-server/src/ssr_pipeline/prism.rs:1161-
        // 1171 so behavior is identical across runtimes.
        if (DEV || (!middlewareFn && existsSync(APP_DIR + "/middleware.ts"))) await loadMiddleware();
        const middlewarePathMatches =
          !middlewareMatchers || middlewareMatchers.some((m) => m(path));
        if (middlewareFn && middlewarePathMatches) {
          try {
            // Wrap request with Next.js properties for middleware compat
            const mwReq: any = request;
            if (!mwReq.nextUrl) {
              mwReq.nextUrl = new URL(request.url);
            }
            if (!mwReq.cookies) {
              const cookieHeader = request.headers.get("cookie") || "";
              const jar = new Map<string, string>();
              for (const pair of cookieHeader.split(";")) {
                const [k, ...v] = pair.split("=");
                if (k?.trim()) jar.set(k.trim(), v.join("=").trim());
              }
              mwReq.cookies = {
                get: (name: string) => jar.has(name) ? { name, value: jar.get(name)! } : undefined,
                getAll: () => Array.from(jar.entries()).map(([name, value]) => ({ name, value })),
                has: (name: string) => jar.has(name),
                set: () => {},
                delete: () => {},
              };
            }
            const mwResult = await middlewareFn(mwReq, { path });
            if (mwResult instanceof Response) return mwResult;
          } catch (e: any) {
            // Middleware errors are non-fatal — log and continue to page rendering
            if (DEV) console.warn(`[prism:middleware] error on ${path}: ${e.message?.substring(0, 100)}`);
          }
        }

        // API routes: src/app/api/**/route.ts
        if (path.startsWith("/api/") || path === "/api") {
          const matched = matchApiRoute(path, _apiRoutes);
          if (matched) {
            const handler = await loadApiHandler(matched.route);
            if (handler) {
              const method = request.method.toUpperCase();
              const fn = handler[method] || handler[method.toLowerCase()] || handler.default;
              if (fn) {
                try {
                  return await fn(request, { params: matched.params });
                } catch (e: any) {
                  console.error(`[prism:api] ${method} ${path}:`, e.message);
                  return Response.json({ error: e.message }, { status: 500 });
                }
              }
              return new Response("Method Not Allowed", { status: 405 });
            }
          }
        }

        // Server actions: POST /_bext/action/{name}
        if (request.method === "POST" && path.startsWith("/_bext/action/")) {
          const actionName = path.split("/").pop()!;
          const action = _serverActions.find(a => a.name === actionName);
          if (action) {
            const fn = await loadActionHandler(action);
            if (fn) {
              const contentType = request.headers.get("content-type") || "";
              const isFormSubmit = contentType.includes("form") &&
                !request.headers.get("x-bext-form");
              try {
                let input: any;
                if (contentType.includes("application/json")) {
                  input = await request.json();
                } else if (contentType.includes("form")) {
                  input = await request.formData();
                } else {
                  input = await request.text();
                }
                const result = await fn(input);
                if (result instanceof Response) return result;
                // Form POST without our fetch enhancer → 303 back to referer so
                // the browser renders a page, not raw JSON. Keeps no-JS PE working.
                if (isFormSubmit) {
                  const back = request.headers.get("referer") || "/";
                  return new Response(null, { status: 303, headers: { location: back } });
                }
                return Response.json(result ?? { ok: true });
              } catch (e: any) {
                console.error(`[prism:action] ${actionName}:`, e.message);
                if (isFormSubmit) {
                  const back = request.headers.get("referer") || "/";
                  return new Response(null, { status: 303, headers: { location: back } });
                }
                return Response.json({ error: e.message }, { status: 500 });
              }
            }
          }
          return Response.json({ error: "Action not found" }, { status: 404 });
        }

        // Match route (supports dynamic [param] segments)
        const matched = matchRoute(path || "/", _pages);
        const routePath = matched?.page.routePath ?? (path || "/");
        const matchedPage = matched?.page;
        const params = matched?.params ?? {};

        // Production HTML cache — skipped in inspect mode so each
        // request re-injects the runtime script with fresh state.
        if (!DEV && !inspectMode) {
          const cached = htmlCache.get(path);
          const route = resolveRoute(routePath, matchedPage);
          if (cached && route && cached.mtime >= route.deepMtime) {
            return htmlResponse(cached.html, acceptGzip, { cache: "hit" });
          }
        }

        // SSR
        const js = await compilePage(routePath, matchedPage);
        if (js) {
          const renderStart = performance.now();
          try {
            // Build request context for getServerData
            const reqCtx = {
              url: request.url,
              method: request.method,
              headers: Object.fromEntries(request.headers.entries()),
              cookies: parseCookies(request.headers.get("cookie") || ""),
            };
            let result: PrismRouteResult;
            try {
              result = await renderRoute(js, routePath, params, reqCtx);
            } catch (renderErr: any) {
              if (isRedirectLike(renderErr) || isNotFoundLike(renderErr)) throw renderErr;
              const canFallbackRoot = process.env.BEXT_NEXTJS_COMPAT === "full" && existsSync(APP_DIR + "/layout.prism.tsx");
              if (!canFallbackRoot) throw renderErr;

              ssrCache.delete(routePath);
              const fallbackJs = await compilePage(routePath, matchedPage, { prismRootFallback: true });
              if (!fallbackJs) throw renderErr;
              if (DEV) console.warn(`  [retry] ${routePath}: falling back to layout.prism.tsx`);
              result = await renderRoute(fallbackJs, routePath, params, reqCtx);
            }
            // A loader/action returning a Response short-circuits the
            // entire render (Remix-style). Pass the envelope through.
            if (result.kind === "response") {
              const respHeaders = new Headers();
              for (const [k, v] of result.headers) respHeaders.append(k, v);
              return new Response(result.body, { status: result.status, headers: respHeaders });
            }
            let html = result.body;
            const hasIslands = result.hasIslands;
            const renderMs = performance.now() - renderStart;
            const clientFile = getClientFile(routePath);

            // runRoute already resolves staticMetadata + generateMetadata
            // and injects them into <head>. The legacy `__PRISM_META__`
            // sentinel + extractMetadata fallback only runs when runRoute
            // didn't set them (older fixtures or for routes that bypass
            // the runtime entirely — none today, but the path is cheap).
            if (!/<title>[^<]/.test(html)) {
              const matched2 = matchRoute(path || "/", _pages);
              if (matched2) {
                const meta = extractMetadata(matched2.page.pagePath);
                if (meta) html = injectMetadata(html, meta);
              }
            }

            // Auth injection (static _pages only)
            if (!clientFile && opts.auth) {
              const user = await opts.auth.getUser(request);
              const authHtml = opts.auth.navAuthHtml(user);
              html = html.replace(
                /<div id="nav-auth"[^>]*>[\s\S]*?<\/div>/,
                `<div id="nav-auth" style="display:flex;align-items:center;gap:0.75rem;flex-shrink:0">${authHtml}</div>`,
              );
            }

            // Full-page hydration injection
            if (clientFile) {
              const preloads = getPreloadHints();
              if (preloads) html = html.replace("</head>", `${preloads}</head>`);
              html = html.replace(
                "</body>",
                `<script id="__BEXT_DATA__" type="application/json">${JSON.stringify(params).replace(/</g, "\\u003c")}</script>\n<script type="module" src="${clientFile}"></script>\n</body>`,
              );
            }

            // Island partial hydration: skip when runRoute already injected
            // the loader (hasIslands), otherwise scan + inject as a fallback
            // for any `<bext-island>` markers the runtime missed.
            if (!clientFile && !hasIslands) {
              const islandScript = getIslandInjection(html);
              if (islandScript) {
                const preloads = getPreloadHints();
                if (preloads) html = html.replace("</head>", `${preloads}</head>`);
                html = html.replace("</body>", `${islandScript}\n</body>`);
              }
            }

            // Client navigation (SPA-like link interception — fetches fresh HTML)
            html = html.replace("</body>", `${getClientScript()}\n</body>`);

            // Per-route Tailwind injection (mirrors `crates/bext-css` Rust path).
            // No-op unless `[build.css] route_css = true` in bext.config.toml.
            // Runs LAST so it sees every utility class injected by the
            // hydration / island / nav scripts above and can include their
            // CSS in the inlined `<style data-bext-css>` block.
            html = await injectRouteCss(ROOT, html);

            // Cache in production — but never for streaming pages or
            // inspect-mode requests. Inspect requests stash a runtime
            // script downstream that's specific to the iframe handshake;
            // caching that as the canonical HTML would leak it into
            // every visitor's response.
            if (!DEV && !opts.auth && !matchedPage?.isStreaming && !inspectMode) {
              const route = resolveRoute(routePath);
              if (route) {
                htmlCache.set(path, { html, mtime: route.deepMtime });
                fastCacheSet(path, html);
              }
            }

            // Inspect runtime injection — happens AFTER cache write so
            // the script never lands in `htmlCache`. The ETag below is
            // recomputed from the post-injection bytes so 304 responses
            // stay correct for inspect-mode round-trips.
            if (inspectMode) {
              html = html.replace("</body>", `${getInspectScript()}\n</body>`);
            }

            // ETag: 304 if unchanged
            const etag = `"${fnv1a(html)}"`;
            if (ifNoneMatch === etag) {
              return new Response(null, { status: 304, headers: { "ETag": etag } });
            }

            return htmlResponse(html, acceptGzip, { renderMs, cache: "miss", inspectMode });
          } catch (e: any) {
            // Handle redirect() and notFound() thrown from pages/middleware/getServerData
            if (isRedirectLike(e)) {
              return Response.redirect(e.url, e.status);
            }
            if (isNotFoundLike(e)) {
              // Fall through to 404 handling below
            } else {
              console.error(`[prism:render] ${path}:`, e.message);
              if (DEV) {
                console.error(e.stack);
                return new Response(devErrorHtml(path, e), {
                  status: 500, headers: { "Content-Type": "text/html; charset=utf-8" },
                });
              }
              return htmlResponse(`<h1>Internal Server Error</h1>`, acceptGzip, 500);
            }
          }
        }

        // 404 — render through layout if possible
        try {
          const notFoundPage = APP_DIR + "/not-found.tsx";
          if (existsSync(notFoundPage)) {
            const js404 = await compilePage("/not-found");
            if (js404) {
              const r404 = await renderRoute(js404, "/not-found");
              if (r404.kind === "html") return htmlResponse(r404.body, acceptGzip, 404);
            }
          }
        } catch {}
        // Dev request log
        if (DEV) {
          const ms = (performance.now() - reqStart).toFixed(1);
          console.log(`  ${request.method} ${path} → 404  (${ms}ms)`);
        }
        return htmlResponse("<html><body><h1>404</h1><p>Page not found.</p></body></html>", acceptGzip, 404);
}
