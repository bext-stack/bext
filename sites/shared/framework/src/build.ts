/**
 * PRISM Build — generates a production bundle for bext-server.
 *
 * Usage:
 *   bun run build.ts
 *
 * Or in package.json:
 *   "scripts": { "build": "bun sites/shared/framework/src/build.ts" }
 *
 * Outputs:
 *   .bext/production.js    — SSR bundle with __fetch handler (for bext-server's JSC pool)
 *   public/_bext/*.js      — Client hydration bundles (served by bext-server's static layer)
 *   public/styles.css      — Compiled Tailwind CSS
 *
 * In production, bext-server:
 *   1. Loads .bext/production.js into the JSC pool
 *   2. Calls __fetch(requestJson) for each request
 *   3. Handles compression, ISR caching, static files, HTTP/2-3, ETags natively
 *
 * PRISM dev server (serve.ts) is for development only.
 * This build command is for production deployment via bext-server.
 *
 * @module @bext-stack/framework/build
 */

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { resolve, join, dirname } from "path";
import { buildCSS } from "./tailwind";

// ── Config ──────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** Root directory of the site. Default: cwd. */
  root?: string;
  /** Extra Tailwind source directories. */
  cssSources?: string[];
  /** Extra CSS files to prepend. */
  extraCSS?: string[];
  /** External modules to exclude from client bundles. */
  external?: string[];
}

// ── Build ───────────────────────────────────────────────────────────────────

function getBuildDefines(): Record<string, string> {
  const defines: Record<string, string> = { "process.env.NODE_ENV": `"production"` };
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value !== undefined) {
      defines[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  return defines;
}

/**
 * Extract the `{ ... }` literal of `export const metadata = { ... }` from a
 * source file, walking balanced braces and respecting string / template
 * literals + line and block comments. Returns the raw slice (including the
 * outer braces) ready for `new Function("return " + slice)()`, or null if
 * the export isn't found or is malformed.
 *
 * This replaces the previous flat-only regex which broke as soon as the
 * metadata object contained a nested object (openGraph, twitter, …).
 */
function extractMetadataLiteral(src: string): string | null {
  const anchor = /export\s+const\s+metadata\s*=\s*\{/g;
  const m = anchor.exec(src);
  if (!m) return null;
  // Position of the opening brace.
  const openIdx = m.index + m[0].length - 1;
  let i = openIdx;
  let depth = 0;
  const len = src.length;
  while (i < len) {
    const c = src[i];
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      if (depth === 0) return src.slice(openIdx, i);
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      // Skip string / template literal.
      const quote = c;
      i++;
      while (i < len) {
        const cc = src[i];
        if (cc === "\\") { i += 2; continue; }
        if (cc === quote) { i++; break; }
        // Template literal interpolation — skip its braces too.
        if (quote === "`" && cc === "$" && src[i + 1] === "{") {
          i += 2;
          let interp = 1;
          while (i < len && interp > 0) {
            const ic = src[i];
            if (ic === "{") interp++;
            else if (ic === "}") interp--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      // Line comment.
      i += 2;
      while (i < len && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      // Block comment.
      i += 2;
      while (i < len && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    i++;
  }
  // Unbalanced.
  return null;
}

export async function build(opts: BuildOptions = {}) {
  const ROOT = opts.root ?? process.cwd();
  const APP_DIR = ROOT + "/src/app";
  const CACHE_DIR = ROOT + "/.bext";
  const PUBLIC_DIR = ROOT + "/public";
  const CLIENT_DIR = PUBLIC_DIR + "/_bext";

  mkdirSync(CACHE_DIR, { recursive: true });
  mkdirSync(CLIENT_DIR, { recursive: true });

  // ── Compat mode ────────────────────────────────────────────────────────
  const NEXTJS_COMPAT = process.env.BEXT_NEXTJS_COMPAT || "prism";
  const isFullCompat = NEXTJS_COMPAT === "full";

  // Layout selection: compat=full → real layout.tsx, prism → prefer layout.prism.tsx
  const rootLayoutFile = isFullCompat
    ? "layout.tsx"
    : (existsSync(APP_DIR + "/layout.prism.tsx") ? "layout.prism.tsx" : "layout.tsx");

  if (!existsSync(APP_DIR + "/" + rootLayoutFile)) {
    console.error(`[prism:build] No layout at ${APP_DIR}/${rootLayoutFile}`);
    process.exit(1);
  }

  // When compat=full, read serverExternalPackages from next.config.mjs
  let nextjsExternals: string[] = [];
  if (isFullCompat) {
    const nextConfigPath = process.env.BEXT_NEXT_CONFIG_PATH || ROOT + "/next.config.mjs";
    if (existsSync(nextConfigPath)) {
      try {
        const mod = await import(nextConfigPath);
        const config = mod.default ?? mod;
        if (config.serverExternalPackages) {
          nextjsExternals = config.serverExternalPackages;
        }
      } catch (e: any) {
        console.warn(`  [warn] Could not read next.config.mjs: ${e.message?.substring(0, 80)}`);
      }
    }
  }

  const start = performance.now();
  console.log(`\n  PRISM build (compat=${NEXTJS_COMPAT}, layout=${rootLayoutFile})\n`);
  if (nextjsExternals.length) console.log(`  externals  ${nextjsExternals.length} from next.config.mjs`);

  // ── 1. CSS ──────────────────────────────────────────────────────────────
  // When BEXT_RUST_CSS=1, bext-server handles CSS via the Rust-native encre-css
  // engine. Skip the TypeScript Tailwind compilation to avoid duplicate work.
  if (process.env.BEXT_RUST_CSS !== "1") {
    const cssSources = [ROOT + "/src", ...(opts.cssSources ?? []).map(s => resolve(ROOT, s))];
    const cssResult = await buildCSS({ sources: cssSources, outFile: PUBLIC_DIR + "/styles.css" });
    const extraCSS = (opts.extraCSS ?? []).map(f => {
      try { return readFileSync(resolve(ROOT, f), "utf-8"); } catch { return ""; }
    }).filter(Boolean);
    if (extraCSS.length) {
      const built = readFileSync(PUBLIC_DIR + "/styles.css", "utf-8");
      writeFileSync(PUBLIC_DIR + "/styles.css", extraCSS.join("\n") + "\n" + built);
    }
    console.log(`  css        ${(cssResult.size / 1024).toFixed(1)} KB`);
  } else {
    console.log(`  css        (handled by bext-server Rust engine)`);
  }

  // ── 2. Discover pages ───────────────────────────────────────────────────
  // Invisible segments: directory names that don't appear in URLs (e.g., "default" module prefix)
  const invisibleSegs = (process.env.BEXT_INVISIBLE_SEGMENTS || "").split(",").filter(Boolean);

  interface PageInfo { routePath: string; pagePath: string; isClient: boolean; isDynamic: boolean; isCatchAll: boolean; }
  const pages: PageInfo[] = [];
  function walkPages(dir: string, prefix: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (entry === "page.tsx" || entry === "page.jsx") {
        const routePath = prefix || "/";
        const src = readFileSync(full, "utf-8").trimStart();
        const isClient = src.startsWith('"use client"') || src.startsWith("'use client'");
        pages.push({ routePath, pagePath: full, isClient, isDynamic: routePath.includes("["), isCatchAll: routePath.includes("[...") });
      } else if (entry === "api" || entry.startsWith(".") || entry.startsWith("_")) {
        continue;
      } else {
        try {
          if (!statSync(full).isDirectory()) continue;
          if (entry.startsWith("(") && entry.endsWith(")")) walkPages(full, prefix);
          else if (invisibleSegs.includes(entry)) walkPages(full, prefix);
          else walkPages(full, prefix + "/" + entry);
        } catch {}
      }
    }
  }
  walkPages(APP_DIR, "");
  pages.sort((a, b) => {
    if (a.isCatchAll !== b.isCatchAll) return a.isCatchAll ? 1 : -1;
    if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
    return 0;
  });

  const clientPages = pages.filter(p => p.isClient);
  const staticPages = pages.filter(p => !p.isClient);
  console.log(`  pages      ${pages.length} (${staticPages.length} static, ${clientPages.length} hydrated)`);

  // ── 3. Discover islands ─────────────────────────────────────────────────
  // Two flavors:
  //   "use client"  → React-hydrated islands (existing).
  //   "use signals" → bext signals runtime; resumes server-rendered DOM
  //                   without re-render (zero React in the bundle).
  const islandFiles: { name: string; filePath: string }[] = [];
  const signalIslandFiles: { name: string; filePath: string }[] = [];
  for (const dir of [ROOT + "/src/components", ROOT + "/src/islands"]) {
    if (!existsSync(dir)) continue;
    function walkIslands(d: string) {
      for (const entry of readdirSync(d)) {
        const full = join(d, entry);
        try {
          if (statSync(full).isDirectory()) { walkIslands(full); continue; }
          if (/\.(tsx?|jsx?)$/.test(entry)) {
            const src = readFileSync(full, "utf-8").trimStart();
            const stem = entry.replace(/\.(tsx?|jsx?)$/, "");
            if (src.startsWith('"use signals"') || src.startsWith("'use signals'")) {
              signalIslandFiles.push({ name: stem, filePath: full });
            } else if (src.startsWith('"use client"') || src.startsWith("'use client'")) {
              islandFiles.push({ name: stem, filePath: full });
            }
          }
        } catch {}
      }
    }
    walkIslands(dir);
  }
  if (islandFiles.length) console.log(`  islands    ${islandFiles.length} (react)`);
  if (signalIslandFiles.length) console.log(`  signals    ${signalIslandFiles.length} (bext)`);

  // ── 4. Discover API routes ──────────────────────────────────────────────
  const apiRoutes: { routePath: string; filePath: string }[] = [];
  const apiDir = APP_DIR + "/api";
  if (existsSync(apiDir)) {
    function walkApi(dir: string, prefix: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry === "route.ts" || entry === "route.tsx" || entry === "route.js") {
          apiRoutes.push({ routePath: "/api" + (prefix || ""), filePath: full });
        } else {
          try { if (statSync(full).isDirectory()) walkApi(full, prefix + "/" + entry); } catch {}
        }
      }
    }
    walkApi(apiDir, "");
    if (apiRoutes.length) console.log(`  api        ${apiRoutes.length} routes`);
  }

  // ── 5. Build client bundles (pages + islands) ───────────────────────────
  // Clean old
  try { for (const f of readdirSync(CLIENT_DIR)) { if (f.endsWith(".js")) unlinkSync(CLIENT_DIR + "/" + f); } } catch {}

  const clientEntries: string[] = [];
  const clientKeyMap: { type: "page" | "island"; key: string; routeOrName: string }[] = [];

  // Full-page hydration entries
  for (const page of clientPages) {
    const key = `client_${page.routePath.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const routeDir = page.routePath === "/" ? "" : page.routePath;
    const layoutPath = APP_DIR + "/" + rootLayoutFile;
    const nestedLayoutPath = APP_DIR + routeDir + "/layout.tsx";
    const hasNested = !!(routeDir && existsSync(nestedLayoutPath) && nestedLayoutPath !== layoutPath);
    const relPage = page.routePath === "/" ? "../src/app/page.tsx" : `../src/app${page.routePath}/page.tsx`;

    const imports = hasNested
      ? `import RootLayout from "../src/app/${rootLayoutFile}";\nimport NestedLayout from "../src/app${routeDir}/layout.tsx";\nimport Page from "${relPage}";`
      : `import RootLayout from "../src/app/${rootLayoutFile}";\nimport Page from "${relPage}";`;
    const tree = hasNested
      ? `React.createElement(RootLayout, { children: React.createElement(NestedLayout, { children: React.createElement(Page.default || Page, props) }) })`
      : `React.createElement(RootLayout, { children: React.createElement(Page.default || Page, props) })`;

    const entry = `import React from "react";\nimport { hydrateRoot } from "react-dom/client";\n${imports}\nvar d=document.getElementById("__BEXT_DATA__");var props=d?JSON.parse(d.textContent||"{}"):{};\nhydrateRoot(document, ${tree});`;
    const entryFile = CACHE_DIR + `/${key}.tsx`;
    writeFileSync(entryFile, entry);
    clientEntries.push(entryFile);
    clientKeyMap.push({ type: "page", key, routeOrName: page.routePath });
  }

  // React island entries
  for (const { name, filePath } of islandFiles) {
    const key = `island_${name}`;
    const entry = `import React from "react";\nimport { hydrateRoot, createRoot } from "react-dom/client";\nimport * as _mod from "${filePath}";\nvar C=_mod.default||_mod["${name}"]||Object.values(_mod)[0];\nexport function mount(){document.querySelectorAll('bext-island[data-component="${name}"]').forEach(function(el){if(el.__prism)return;var props=JSON.parse(el.dataset.props||"{}");if(el.dataset.hasChildren==="1"){var t=el.querySelector("template[data-island-children]");if(t){var h=t.innerHTML;t.remove();props.children=React.createElement("bext-children",{dangerouslySetInnerHTML:{__html:h},style:{display:"contents"}});}}try{if(el.dataset.ssr)hydrateRoot(el,React.createElement(C,props));else createRoot(el).render(React.createElement(C,props));el.__prism=true;}catch(e){}});}\nmount();`;
    const entryFile = CACHE_DIR + `/${key}.tsx`;
    writeFileSync(entryFile, entry);
    clientEntries.push(entryFile);
    clientKeyMap.push({ type: "island", key, routeOrName: name });
  }

  // Signals island entries — resume server DOM via the bext signals
  // runtime. No React in the bundle; payload is signals/core +
  // signals/hydrate + the component's own code.
  for (const { name, filePath } of signalIslandFiles) {
    const key = `signal_island_${name}`;
    const entry = `import { hydrateSignalsIsland } from "@bext-stack/framework/signals/hydrate";\nimport * as _mod from "${filePath}";\nvar C = _mod.default || _mod["${name}"] || Object.values(_mod)[0];\nexport function mount(){document.querySelectorAll('bext-island[data-runtime="signals"][data-component="${name}"]').forEach(function(el){if((el).__bs_mounted)return;var props={};try{props=JSON.parse(el.dataset.props||"{}");}catch(_){}try{hydrateSignalsIsland(el,C,props);(el).__bs_mounted=true;}catch(e){console.error("[signals]","${name}",e);}});}\nmount();`;
    const entryFile = CACHE_DIR + `/${key}.tsx`;
    writeFileSync(entryFile, entry);
    clientEntries.push(entryFile);
    clientKeyMap.push({ type: "signal-island", key, routeOrName: name });
  }

  // Build all client entries together with splitting
  const clientManifest: Record<string, string> = {};
  const islandManifest: Record<string, string> = {};
  const signalIslandManifest: Record<string, string> = {};

  if (clientEntries.length) {
    const result = await Bun.build({
      entrypoints: clientEntries,
      outdir: CLIENT_DIR,
      target: "browser",
      splitting: clientEntries.length > 1,
      minify: true,
      naming: { entry: "[name].[hash].js", chunk: "vendor-[hash].js" },
      define: getBuildDefines(),
      external: opts.external,
    });

    if (!result.success) {
      console.error("[prism:build] client build failed:", result.logs);
      process.exit(1);
    }

    let totalSize = 0;
    for (const output of result.outputs) {
      const fileName = output.path.split("/").pop()!;
      if (!fileName.endsWith(".js")) continue;
      totalSize += output.size;
      for (const { type, key, routeOrName } of clientKeyMap) {
        if (fileName.startsWith(`${key}.`)) {
          if (type === "page") clientManifest[routeOrName] = `/_bext/${fileName}`;
          else if (type === "signal-island") signalIslandManifest[routeOrName] = `/_bext/${fileName}`;
          else islandManifest[routeOrName] = `/_bext/${fileName}`;
        }
      }
    }
    console.log(`  client     ${(totalSize / 1024).toFixed(1)} KB`);
  }

  // Write manifests for the SSR bundle to reference
  writeFileSync(CACHE_DIR + "/client-manifest.json", JSON.stringify(clientManifest));
  writeFileSync(CACHE_DIR + "/island-manifest.json", JSON.stringify(islandManifest));
  writeFileSync(CACHE_DIR + "/signal-island-manifest.json", JSON.stringify(signalIslandManifest));

  // ── 6. Build SSR production bundle ──────────────────────────────────────
  // Generates a single JS file with globalThis.__fetch(requestJson) → responseJson
  // This is loaded by bext-server's JSC pool.

  // Generate page imports and route table
  const pageImports: string[] = [];
  const routeEntries: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const routeDir = p.routePath === "/" ? "" : p.routePath;
    const layoutPath = APP_DIR + "/" + rootLayoutFile;
    const nestedLayoutPath = APP_DIR + routeDir + "/layout.tsx";
    const hasNested = !!(routeDir && existsSync(nestedLayoutPath) && nestedLayoutPath !== layoutPath);
    const loadingPath = APP_DIR + (routeDir || "") + "/loading.tsx";
    const hasLoading = existsSync(loadingPath);
    const errorPath = APP_DIR + (routeDir || "") + "/error.tsx";
    const hasError = existsSync(errorPath);

    // Extract metadata — walks balanced braces so nested objects
    // (openGraph, twitter, alternates, …) survive the parser.
    let metadata: any = null;
    try {
      const src = readFileSync(p.pagePath, "utf-8");
      const slice = extractMetadataLiteral(src);
      if (slice) metadata = new Function(`return ${slice}`)();
    } catch {
      // Malformed metadata export — fall through to null so the build
      // still completes; the page just won't get per-route meta tags.
      metadata = null;
    }

    const relPage = p.routePath === "/" ? "../src/app/page.tsx" : `../src/app${p.routePath}/page.tsx`;
    pageImports.push(`import * as Page_${i} from "${relPage}";`);
    if (hasNested) pageImports.push(`import * as NestedLayout_${i} from "../src/app${routeDir}/layout.tsx";`);
    if (hasLoading) pageImports.push(`import * as Loading_${i} from "../src/app${routeDir || ""}/loading.tsx";`);
    if (hasError) pageImports.push(`import * as ErrorBoundary_${i} from "../src/app${routeDir || ""}/error.tsx";`);

    // Build the React element tree string for this page
    let pageEl = `React.createElement(P${i}, props)`;
    if (hasLoading) pageEl = `React.createElement(Suspense, { fallback: React.createElement(L${i}) }, ${pageEl})`;
    if (hasError) pageEl = `React.createElement(E${i}, null, ${pageEl})`;
    if (hasNested) pageEl = `React.createElement(NL${i}, { children: ${pageEl} })`;
    pageEl = `React.createElement(RootLayout, { children: ${pageEl} })`;

    routeEntries.push(`  { path: ${JSON.stringify(p.routePath)}, dynamic: ${p.isDynamic}, catchAll: ${p.isCatchAll}, client: ${p.isClient}, meta: ${JSON.stringify(metadata)}, render: function(props) { var P${i} = Page_${i}.default || Page_${i}; ${hasNested ? `var NL${i} = NestedLayout_${i}.default || NestedLayout_${i};` : ""} ${hasLoading ? `var L${i} = Loading_${i}.default || Loading_${i};` : ""} ${hasError ? `var E${i} = ErrorBoundary_${i}.default || ErrorBoundary_${i};` : ""} return ${pageEl}; } }`);
  }

  // API route imports
  const apiImports: string[] = [];
  const apiEntries: string[] = [];
  for (let i = 0; i < apiRoutes.length; i++) {
    apiImports.push(`import * as Api_${i} from "${apiRoutes[i].filePath}";`);
    apiEntries.push(`  { path: ${JSON.stringify(apiRoutes[i].routePath)}, handler: Api_${i} }`);
  }

  // Server action imports
  const actionImports: string[] = [];
  const actionEntries: string[] = [];
  const actionsDir = ROOT + "/src/actions";
  if (existsSync(actionsDir)) {
    let ai = 0;
    for (const entry of readdirSync(actionsDir)) {
      const full = join(actionsDir, entry);
      if (!/\.(tsx?|jsx?|js)$/.test(entry)) continue;
      const src = readFileSync(full, "utf-8");
      if (!(src.trimStart().startsWith('"use server"') || src.trimStart().startsWith("'use server'"))) continue;
      actionImports.push(`import * as Action_${ai} from "${full}";`);
      // Export names
      const re = /export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
      let m;
      while ((m = re.exec(src))) {
        actionEntries.push(`  { name: ${JSON.stringify(m[1])}, fn: Action_${ai}.${m[1]} }`);
      }
      ai++;
    }
  }

  // Generate the __fetch entry
  const ssrEntry = `
import React, { Suspense } from "react";
import ReactDOMServer from "react-dom/server";
import { parseMultipart } from "@bext-stack/framework/multipart";
import RootLayout from "../src/app/${rootLayoutFile}";
${pageImports.join("\n")}
${apiImports.join("\n")}
${actionImports.join("\n")}

var CLIENT_MANIFEST = ${JSON.stringify(clientManifest)};
var ISLAND_MANIFEST = ${JSON.stringify(islandManifest)};
var SIGNAL_ISLAND_MANIFEST = ${JSON.stringify(signalIslandManifest)};
var VENDOR_HINTS = ${JSON.stringify(
    (() => { try { return readdirSync(CLIENT_DIR).filter(f => f.startsWith("vendor-") && f.endsWith(".js")).map(f => `/_bext/${f}`); } catch { return []; } })()
  )};

var ROUTES = [\n${routeEntries.join(",\n")}\n];
var API_ROUTES = [\n${apiEntries.join(",\n")}\n];
var ACTIONS = [\n${actionEntries.join(",\n")}\n];

function matchRoute(path) {
  for (var i = 0; i < ROUTES.length; i++) {
    var r = ROUTES[i];
    if (!r.dynamic && r.path === path) return { route: r, params: {} };
  }
  for (var i = 0; i < ROUTES.length; i++) {
    var r = ROUTES[i];
    if (!r.dynamic) continue;
    var params = matchDynamic(path, r.path);
    if (params) return { route: r, params: params };
  }
  return null;
}

function matchDynamic(path, pattern) {
  var pp = path.split("/").filter(Boolean);
  var pt = pattern.split("/").filter(Boolean);
  var params = {};
  for (var i = 0; i < pt.length; i++) {
    if (pt[i].startsWith("[...") && pt[i].endsWith("]")) {
      params[pt[i].slice(4, -1)] = pp.slice(i).join("/");
      return params;
    }
    if (pt[i].startsWith("[") && pt[i].endsWith("]")) {
      if (i >= pp.length) return null;
      params[pt[i].slice(1, -1)] = pp[i];
    } else {
      if (i >= pp.length || pt[i] !== pp[i]) return null;
    }
  }
  if (pp.length !== pt.length) return null;
  return params;
}

function escHtml(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function injectMeta(html, meta) {
  if (!meta) return html;
  if (meta.title) {
    if (html.includes("<title>")) html = html.replace(/<title>[^<]*<\\/title>/, "<title>" + escHtml(meta.title) + "</title>");
    else html = html.replace("</head>", "<title>" + escHtml(meta.title) + "</title>\\n</head>");
  }
  if (meta.description) {
    if (html.includes('name="description"')) html = html.replace(/(<meta[^>]*name="description"[^>]*content=")[^"]*"/, '$1' + escHtml(meta.description) + '"');
    else html = html.replace("</head>", '<meta name="description" content="' + escHtml(meta.description) + '" />\\n</head>');
  }
  return html;
}

globalThis.__fetch = function(requestJson) {
  var req = JSON.parse(requestJson);
  var path = req.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  // API routes
  if (path.startsWith("/api/") || path === "/api") {
    for (var i = 0; i < API_ROUTES.length; i++) {
      if (API_ROUTES[i].path === path) {
        var method = (req.method || "GET").toUpperCase();
        var fn = API_ROUTES[i].handler[method] || API_ROUTES[i].handler[method.toLowerCase()] || API_ROUTES[i].handler.default;
        if (fn) {
          try {
            var result = fn(req);
            if (typeof result === "object" && result.status) return JSON.stringify(result);
            return JSON.stringify({ status: 200, headers: [["content-type","application/json"]], body: JSON.stringify(result) });
          } catch(e) {
            return JSON.stringify({ status: 500, headers: [["content-type","application/json"]], body: JSON.stringify({ error: e.message }) });
          }
        }
        return JSON.stringify({ status: 405, headers: [], body: "Method Not Allowed" });
      }
    }
  }

  // Server actions
  if (req.method === "POST" && path.startsWith("/_bext/action/")) {
    var actionName = path.split("/").pop();
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].name === actionName) {
        var ct = "";
        var hasFetchHeader = false;
        var referer = "/";
        if (req.headers) {
          for (var hi = 0; hi < req.headers.length; hi++) {
            var hk = (req.headers[hi][0] || "").toLowerCase();
            if (hk === "content-type") ct = req.headers[hi][1] || "";
            else if (hk === "x-bext-form") hasFetchHeader = true;
            else if (hk === "referer") referer = req.headers[hi][1] || "/";
          }
        }
        var isFormSubmit = ct.indexOf("form") !== -1 && !hasFetchHeader;
        // Parse body by content-type so the action receives a usable
        // input instead of a raw string. Mirrors the PRISM-native
        // action wrapper (crates/bext-server/src/ssr_pipeline/prism.rs).
        // Pass the original-case content-type to parseMultipart —
        // boundaries are case-sensitive in the body bytes.
        var input;
        var ctLower = ct.toLowerCase();
        var bodyEnc = req.body_encoding === "base64" ? "base64" : "utf8";
        try {
          if (typeof req.body !== "string" || req.body.length === 0) {
            input = req.body;
          } else if (ctLower.indexOf("application/json") !== -1) {
            input = JSON.parse(req.body);
          } else if (ctLower.indexOf("application/x-www-form-urlencoded") !== -1) {
            input = new URLSearchParams(req.body);
          } else if (ctLower.indexOf("multipart/form-data") !== -1) {
            input = parseMultipart(req.body, ct, bodyEnc);
          } else {
            input = req.body;
          }
        } catch(parseErr) {
          if (isFormSubmit) {
            return JSON.stringify({ status: 303, headers: [["location", referer]], body: "" });
          }
          return JSON.stringify({ status: 400, headers: [["content-type","application/json"]], body: JSON.stringify({ error: "failed to parse action body: " + parseErr.message }) });
        }
        try {
          var result = ACTIONS[i].fn(input);
          if (result && typeof result === "object" && typeof result.status === "number" && result.headers) {
            return JSON.stringify(result);
          }
          if (isFormSubmit) {
            return JSON.stringify({ status: 303, headers: [["location", referer]], body: "" });
          }
          return JSON.stringify({ status: 200, headers: [["content-type","application/json"]], body: JSON.stringify(result || { ok: true }) });
        } catch(e) {
          if (isFormSubmit) {
            return JSON.stringify({ status: 303, headers: [["location", referer]], body: "" });
          }
          return JSON.stringify({ status: 500, headers: [["content-type","application/json"]], body: JSON.stringify({ error: e.message }) });
        }
      }
    }
    return JSON.stringify({ status: 404, headers: [["content-type","application/json"]], body: '{"error":"Action not found"}' });
  }

  // Page routing
  var matched = matchRoute(path || "/");
  if (!matched) {
    return JSON.stringify({ status: 404, headers: [["content-type","text/html; charset=utf-8"]], body: "<html><body><h1>404</h1></body></html>" });
  }

  var route = matched.route;
  var props = matched.params;

  try {
    var element = route.render(props);
    var html = ReactDOMServer.renderToString(element);

    // Metadata
    html = injectMeta(html, route.meta);

    // Hydration injection for full-page client pages
    var clientFile = CLIENT_MANIFEST[route.path];
    if (clientFile) {
      var preloads = VENDOR_HINTS.map(function(v) { return '<link rel="modulepreload" href="' + v + '" />'; }).join("\\n");
      if (preloads) html = html.replace("</head>", preloads + "</head>");
      html = html.replace("</body>", '<script id="__BEXT_DATA__" type="application/json">' + JSON.stringify(props) + '</script>\\n<script type="module" src="' + clientFile + '"></script>\\n</body>');
    }

    // Island injection (pages without full hydration)
    if (!clientFile && html.includes("<bext-island")) {
      var islandKeys = Object.keys(ISLAND_MANIFEST);
      var signalKeys = Object.keys(SIGNAL_ISLAND_MANIFEST);
      if (islandKeys.length || signalKeys.length) {
        var preloads = VENDOR_HINTS.map(function(v) { return '<link rel="modulepreload" href="' + v + '" />'; }).join("\\n");
        if (preloads) html = html.replace("</head>", preloads + "</head>");
        // Loader: per-element, route to the matching manifest by data-runtime.
        var rmap = JSON.stringify(ISLAND_MANIFEST);
        var smap = JSON.stringify(SIGNAL_ISLAND_MANIFEST);
        html = html.replace(
          "</body>",
          '<script type="module">(function(){var rm=' + rmap + ';var sm=' + smap + ';' +
          'document.querySelectorAll("bext-island[data-component]").forEach(function(el){' +
            'if(el.__prism||el.__bs_mounted)return;' +
            'var n=el.dataset.component;var rt=el.dataset.runtime;' +
            'var u=(rt==="signals")?sm[n]:rm[n];' +
            'if(!u)return;' +
            'import(u).then(function(mod){if(mod.mount)mod.mount()}).catch(function(e){console.error("[bext]",n,e)});' +
          '});})()</script>\\n</body>',
        );
      }
    }

    // Cache hints for bext-server ISR. Always tag with page:<path>; merge any
    // author-declared tags (export const tags = [...]) so a purge-tag /
    // revalidateTag can bust this rendered page by semantic tag. Forward-
    // compatible: a no-op until the route scanner surfaces route.tags.
    var pageTags = ["page:" + path];
    if (route && Array.isArray(route.tags)) {
      for (var __ti = 0; __ti < route.tags.length; __ti++) pageTags.push(String(route.tags[__ti]));
    }
    var cache = route.client ? undefined : { enabled: true, ttl_ms: 60000, swr_ms: 300000, tags: pageTags };

    return JSON.stringify({ status: 200, headers: [["content-type","text/html; charset=utf-8"]], body: html, cache: cache });
  } catch(e) {
    return JSON.stringify({ status: 500, headers: [["content-type","text/html; charset=utf-8"]], body: "<html><body><h1>500</h1><pre>" + escHtml(e.message) + "</pre></body></html>" });
  }
};
`;

  const ssrEntryFile = CACHE_DIR + "/ssr_production.tsx";
  writeFileSync(ssrEntryFile, ssrEntry);

  // Build with plugins: island SSR + optional Next.js compat
  const { createIslandSSRPlugin, createNextCompatPlugin } = await import("./serve");
  const ssrPlugins: any[] = [];
  if (isFullCompat) ssrPlugins.push(createNextCompatPlugin());
  ssrPlugins.push(createIslandSSRPlugin());

  const ssrResult = await Bun.build({
    entrypoints: [ssrEntryFile],
    outdir: CACHE_DIR,
    target: "bun",
    naming: "production.js",
    define: getBuildDefines(),
    plugins: ssrPlugins,
    external: nextjsExternals.length ? nextjsExternals : undefined,
  });

  if (!ssrResult.success) {
    console.error("[prism:build] SSR bundle failed:", ssrResult.logs);
    process.exit(1);
  }

  const ssrSize = ssrResult.outputs[0]?.size ?? 0;
  console.log(`  ssr        ${(ssrSize / 1024).toFixed(1)} KB  (.bext/production.js)`);

  // Write build info
  const buildInfo = {
    timestamp: new Date().toISOString(),
    pages: pages.length,
    islands: islandFiles.length,
    apiRoutes: apiRoutes.length,
    clientManifest,
    islandManifest,
    ssrBundle: ".bext/production.js",
  };
  writeFileSync(CACHE_DIR + "/build-info.json", JSON.stringify(buildInfo, null, 2));

  const elapsed = (performance.now() - start).toFixed(0);
  console.log(`\n  done in ${elapsed}ms\n`);
}

// ── CLI entry ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const root = process.cwd();

  // Read build options from bext.config.toml if available
  const opts: BuildOptions = { root };
  try {
    const toml = readFileSync(join(root, "bext.config.toml"), "utf-8");
    // Simple TOML parser for [build.css] section
    let inBuildCss = false;
    let currentArray: string[] | null = null;
    let currentKey = "";
    for (const line of toml.split("\n")) {
      const t = line.trim();
      if (t === "[build.css]") { inBuildCss = true; continue; }
      if (t.startsWith("[")) { inBuildCss = false; currentArray = null; continue; }
      if (!inBuildCss) continue;

      // Handle array continuation lines
      if (currentArray !== null) {
        if (t === "]") {
          if (currentKey === "extra_sources") opts.cssSources = currentArray;
          else if (currentKey === "extra_css") opts.extraCSS = currentArray;
          currentArray = null;
          continue;
        }
        const m = t.match(/^"([^"]*)"[,]?$/);
        if (m) currentArray.push(m[1]);
        continue;
      }

      // Handle key = value or key = [
      const kv = t.match(/^(\w+)\s*=\s*(.+)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      if (val.trim() === "[") {
        currentArray = [];
        currentKey = key;
      } else if (val.startsWith("[")) {
        // Inline array: key = ["a", "b"]
        const items = val.slice(1, -1).split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
        if (key === "extra_sources") opts.cssSources = items;
        else if (key === "extra_css") opts.extraCSS = items;
      }
    }
  } catch {}

  build(opts).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
