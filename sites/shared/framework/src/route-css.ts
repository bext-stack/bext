/**
 * Per-route Tailwind injection — mirrors `crates/bext-css` (Rust).
 *
 * When a site sets `[build.css] route_css = true` in `bext.config.toml`, the
 * server scans the rendered HTML for class tokens, asks Tailwind to generate
 * CSS for *just those classes*, and inlines a `<style data-bext-css>` block
 * before `</head>`. Bext-server does this in Rust via `bext_css::inject_route_css`;
 * this module is the bun-served equivalent.
 *
 * Caches:
 *   • The compiled Tailwind instance is built once per process.
 *   • The (HTML → CSS) result is cached per-route under
 *     `htmlCache` upstream — this module only generates, never caches.
 *
 * Performance budget: ~1ms scan + ~10ms compile on cold class sets, sub-ms
 * once Tailwind has warmed its candidate cache. The cost is amortised by
 * `htmlCache.set()` saving the post-injection HTML.
 */

import { readFileSync, existsSync } from "fs";
// NOTE: `tailwindcss` is imported lazily (via `await import` inside
// `getCompiled`), NOT statically at module top-level. This module is reached
// by the SSR page bundle through the `@bext-stack/framework` barrel
// (`index.ts` re-exports `Redirect/NotFound/...` from `serve.ts`, and `serve.ts`
// imports this file). A static `import { compile } from "tailwindcss"` becomes
// an eval-time `require("tailwindcss")` in the PRISM bundle, which the JSC pool
// can't resolve → 500. Route-css for PRISM pages is done in Rust (`bext_css`),
// so this JS path never actually runs there; deferring the require keeps the
// bundle eval clean while the bun-served path still works at call time.
import type { compile } from "tailwindcss";
import { bextThemeCSS } from "./tailwind-config";

let compileCache: Awaited<ReturnType<typeof compile>> | null = null;
let compileInitErr: Error | null = null;

async function getCompiled(siteRoot: string) {
  if (compileCache) return compileCache;
  if (compileInitErr) throw compileInitErr;
  try {
    const { compile } = await import("tailwindcss");
    const compiled = await compile(bextThemeCSS, {
      loadStylesheet: async (id: string, base: string) => {
        const { resolve, dirname, join } = await import("path");
        let resolvedPath: string;
        if (id.startsWith(".") || id.startsWith("/")) {
          resolvedPath = resolve(base, id);
          if (!resolvedPath.endsWith(".css")) resolvedPath += ".css";
        } else {
          try {
            const pkgDir = dirname(require.resolve(id + "/package.json", { paths: [base, siteRoot] }));
            const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
            const cssEntry = pkgJson.style || pkgJson.exports?.["."]?.style || "index.css";
            resolvedPath = resolve(pkgDir, cssEntry);
          } catch {
            resolvedPath = resolve(base, id);
          }
        }
        const content = readFileSync(resolvedPath, "utf-8");
        return { path: resolvedPath, content, base: dirname(resolvedPath) };
      },
    });
    compileCache = compiled;
    return compiled;
  } catch (e: any) {
    compileInitErr = e;
    throw e;
  }
}

const ROUTE_CSS_CACHE = new Map<string, boolean>();

/** Read `[build.css] route_css` from `<siteRoot>/bext.config.toml`. Cached. */
export function routeCssEnabled(siteRoot: string): boolean {
  const cached = ROUTE_CSS_CACHE.get(siteRoot);
  if (cached !== undefined) return cached;
  const cfgPath = siteRoot + "/bext.config.toml";
  let enabled = false;
  if (existsSync(cfgPath)) {
    const src = readFileSync(cfgPath, "utf-8");
    // Cheap toml read: we only need [build.css] route_css = true|false.
    // A full parser is overkill and would add 100KB+ of dep weight to
    // every bun site. Match the section header then the key line.
    // Section-aware scan: walk line-by-line, track current `[section]`,
    // pluck `route_css = true|false` only while inside `[build.css]`. JS
    // regex lacks `\Z` so a single-shot section grab is awkward; the
    // line-loop is both simpler and exact.
    let inBuildCss = false;
    for (const rawLine of src.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith("[")) {
        inBuildCss = /^\[build\.css\]\s*$/.test(line);
        continue;
      }
      if (inBuildCss) {
        const m = line.match(/^route_css\s*=\s*(true|false)\b/);
        if (m) { enabled = m[1] === "true"; break; }
      }
    }
  }
  ROUTE_CSS_CACHE.set(siteRoot, enabled);
  return enabled;
}

/**
 * Extract class tokens from HTML — both `class="…"` attribute values and
 * common patterns. Mirrors `bext_css::extract_classes_from_html` (Rust).
 */
function extractClasses(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // class="…" and class='…'
  const re = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = m[1] ?? m[2] ?? "";
    for (const tok of v.split(/\s+/)) {
      const t = tok.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

/** Insert `snippet` before `</head>` (or `<body>` if no head) — same shape
 *  as `injectMetadata` in `prism-runtime.ts`. */
function injectIntoHead(html: string, snippet: string): string {
  const lower = html.toLowerCase();
  const headClose = lower.indexOf("</head>");
  if (headClose >= 0) {
    return html.slice(0, headClose) + snippet + html.slice(headClose);
  }
  const bodyOpen = lower.indexOf("<body");
  if (bodyOpen >= 0) {
    const bodyOpenEnd = html.indexOf(">", bodyOpen);
    if (bodyOpenEnd >= 0) {
      return html.slice(0, bodyOpenEnd + 1) + snippet + html.slice(bodyOpenEnd + 1);
    }
  }
  return snippet + html;
}

/**
 * Heuristic: does this class token look like a Tailwind utility?
 *
 * Tailwind utilities follow short patterns (`flex`, `gap-4`, `text-xl`,
 * `bg-red-500`, `md:hover:underline`). Custom design-system class names
 * (`lede`, `nav-section`, `badge broken`) typically include hyphenated
 * compound words and don't match the tight Tailwind shape. Mirroring the
 * Rust `bext_css::generate_from_candidates(no-preflight)` probe lets us
 * skip the ~33 KB preflight + theme block on pages that don't use
 * Tailwind utilities at all (most of the demo, mainly).
 */
// Hyphenated-prefix utilities. A token like `gap-4`, `bg-red-500`,
// `text-xl`, `mt-1` or `md:hover:bg-red-500` matches when the leaf's
// pre-hyphen prefix is in this set.
const TAILWIND_DASH_PREFIXES = new Set([
  // Sizing / spacing
  "w","h","min","max","p","px","py","pt","pr","pb","pl","m","mx","my","mt","mr","mb","ml","gap","space",
  // Type
  "text","font","leading","tracking","whitespace","line",
  // Color / bg / border / effects
  "bg","border","ring","outline","divide","accent","caret","fill","stroke",
  "rounded","shadow","opacity","blur","brightness","contrast","grayscale","saturate","sepia",
  // Flex / grid
  "items","justify","place","self","order","col","row","grid",
  // Effects / motion
  "transition","duration","ease","delay","animate","transform","scale","rotate","translate","skew","origin",
  // Misc
  "cursor","overflow","z","top","right","bottom","left","inset","aspect","backdrop",
]);

// Tokens valid as Tailwind utilities on their own (no hyphen). Any
// ambiguous shorthand a custom design system might also use (`content`,
// `grid`, `inline`, `block`, `table`, `select`) is intentionally absent
// to avoid false positives — those are common custom-css class names.
const TAILWIND_STANDALONE = new Set([
  "flex","hidden","static","fixed","absolute","relative","sticky","container",
  "truncate","italic","underline","uppercase","lowercase","capitalize",
  "antialiased","invisible","visible",
]);

function looksLikeTailwind(tok: string): boolean {
  const leaf = tok.split(":").pop()!;
  if (!leaf) return false;
  if (TAILWIND_STANDALONE.has(leaf)) return true;
  const dashIdx = leaf.indexOf("-");
  if (dashIdx > 0) {
    const prefix = leaf.slice(0, dashIdx);
    if (TAILWIND_DASH_PREFIXES.has(prefix)) return true;
  }
  return false;
}

/**
 * Inject `<style data-bext-css>…</style>` containing CSS for the
 * Tailwind utility classes actually used by `html`. No-op if:
 *   • route_css is disabled in the site's bext.config.toml, or
 *   • the rendered HTML has no Tailwind-utility-shaped class tokens
 *     (custom-named classes only, served from the framework's static
 *     `<style>` already in the layout).
 */
export async function injectRouteCss(
  siteRoot: string,
  html: string,
): Promise<string> {
  if (!routeCssEnabled(siteRoot)) return html;
  const candidates = extractClasses(html);
  const tailwindish = candidates.filter(looksLikeTailwind);
  if (tailwindish.length === 0) return html;

  let compiled: Awaited<ReturnType<typeof compile>>;
  try {
    compiled = await getCompiled(siteRoot);
  } catch {
    // If Tailwind init fails (missing dep, syntax in theme css), bail
    // through unchanged — better to ship a working response without
    // route-css than to 5xx the page.
    return html;
  }
  const fullCss = compiled.build(tailwindish);
  if (!fullCss || fullCss.length === 0) return html;
  // Strip `@layer theme` and `@layer base` from the output: those are
  // already in the page's global `/styles.css` (built once at startup
  // by `buildCSS`). Re-emitting them per request adds ~7 KB of pure
  // duplication. We keep `@layer utilities` (the actual route-specific
  // CSS) and `@layer properties` (Tailwind v4's `@property` declarations,
  // referenced by utility custom-prop animations).
  const trimmed = stripDuplicatedLayers(fullCss);
  if (!trimmed.trim()) return html;
  return injectIntoHead(html, `<style data-bext-css>${trimmed}</style>`);
}

/** Remove `@layer theme {…}` and `@layer base {…}` from a Tailwind v4
 *  build. They're identical-per-request boilerplate (theme tokens +
 *  preflight reset) that the page's global stylesheet already loads.
 *  The header `@layer X, Y;` declaration line and the `@layer
 *  utilities`/`@layer properties` blocks are preserved untouched. */
function stripDuplicatedLayers(css: string): string {
  // We can't naïvely regex `@layer theme {.*?}` because `@layer
  // utilities` (and even `@property` blocks inside it) contains nested
  // `{ … }` braces. Walk forward, brace-balance each top-level layer,
  // drop the ones that match the duplication set.
  const DROP = new Set(["theme", "base"]);
  let out = "";
  let i = 0;
  while (i < css.length) {
    const layerMatch = css.slice(i).match(/^@layer\s+(\w+)\s*\{/);
    if (!layerMatch) {
      out += css[i++];
      continue;
    }
    const layerName = layerMatch[1];
    const blockStart = i + layerMatch[0].length;
    // Find the matching close brace, accounting for nesting.
    let depth = 1;
    let j = blockStart;
    while (j < css.length && depth > 0) {
      const c = css[j++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    if (!DROP.has(layerName)) {
      out += css.slice(i, j);
    }
    i = j;
  }
  return out;
}
