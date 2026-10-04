/**
 * Build-time Tailwind CSS generation for bext sites.
 *
 * Usage in build script:
 * ```ts
 * import { buildCSS } from "@bext-stack/framework/tailwind";
 * await buildCSS({ sources: ["server/**\/*.{ts,tsx}"], outFile: "dist/styles.css" });
 * ```
 *
 * Or use the auto-build: if `server/styles.css` exists with `@import "tailwindcss"`,
 * the framework build pipeline runs Tailwind automatically.
 */

// Lazy-imported inside `buildCSS` (not statically) so this module can be pulled
// into a PRISM SSR bundle via the `@bext-stack/framework` barrel → `serve.ts`
// without emitting an eval-time `require("tailwindcss")` the JSC pool can't
// resolve. `buildCSS` is build-time only and never runs in PRISM, so deferring
// the require to call time is safe. See the matching note in `route-css.ts`.
import { bextThemeCSS } from "./tailwind-config";

export interface TailwindBuildOptions {
  /** CSS entry content. Defaults to bext's theme with all design tokens + dark mode. */
  css?: string;
  /** Glob patterns to scan for class candidates. */
  sources: string[];
  /** Output file path. Use `[hash]` placeholder for content hash. */
  outFile: string;
  /** Write a manifest file mapping logical name → hashed filename. */
  manifest?: string;
}

/**
 * Compile Tailwind CSS by scanning source files for class candidates.
 * Writes the generated CSS to `outFile`.
 */
export async function buildCSS(
  opts: TailwindBuildOptions,
): Promise<{ size: number; hash: string; path: string }> {
  const css = opts.css ?? bextThemeCSS;
  const { compile } = await import("tailwindcss");
  const { readFileSync } = await import("fs");
  const { resolve, dirname, join } = await import("path");

  // Tailwind v4 needs a loadStylesheet callback for @import resolution
  const compiled = await compile(css, {
    loadStylesheet: async (id: string, base: string) => {
      // Resolve @import paths. For package imports like "tailwindcss",
      // look for the CSS entry (package.json "style" field or index.css).
      let resolvedPath: string;
      if (id.startsWith(".") || id.startsWith("/")) {
        resolvedPath = resolve(base, id);
        if (!resolvedPath.endsWith(".css")) resolvedPath += ".css";
      } else {
        // Package import — find the CSS entry
        try {
          const pkgDir = dirname(require.resolve(id + "/package.json", { paths: [base, process.cwd()] }));
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

  // Scan source files for class candidates
  const candidates = await scanCandidates(opts.sources);

  // Generate CSS from candidates
  const output = compiled.build(candidates);

  // Content hash for cache busting
  const hash = contentHash(output).slice(0, 8);
  const finalPath = opts.outFile.replace("[hash]", hash);

  // Write output
  const { mkdirSync, writeFileSync: writeSync } = await import("fs");
  mkdirSync(dirname(finalPath), { recursive: true });
  writeSync(finalPath, output);

  // Write manifest (maps logical name → hashed filename)
  if (opts.manifest) {
    const logicalName = opts.outFile.split("/").pop()?.replace("[hash]", "*") ?? "styles.css";
    const actualName = finalPath.split("/").pop() ?? "";
    mkdirSync(dirname(opts.manifest), { recursive: true });
    writeSync(
      opts.manifest,
      JSON.stringify({ [logicalName]: actualName, hash, path: finalPath }, null, 2),
    );
  }

  return { size: output.length, hash, path: finalPath };
}

function contentHash(content: string): string {
  // Simple FNV-1a hash for cache busting (fast, no crypto needed)
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Scan directories/files for Tailwind class candidates.
 * Each source can be a directory path or a glob pattern.
 */
async function scanCandidates(sources: string[]): Promise<string[]> {
  const { readFileSync, readdirSync, statSync } = await import("fs");
  const { join } = await import("path");

  const candidates = new Set<string>();

  function walkDir(dir: string): void {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const fullPath = join(dir, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          walkDir(fullPath);
        } else if (/\.(tsx?|jsx?|html|css)$/.test(entry)) {
          extractCandidates(readFileSync(fullPath, "utf-8"), candidates);
        }
      } catch { /* skip unreadable */ }
    }
  }

  for (const source of sources) {
    try {
      const stat = statSync(source);
      if (stat.isDirectory()) {
        walkDir(source);
      } else if (stat.isFile()) {
        extractCandidates(readFileSync(source, "utf-8"), candidates);
      }
    } catch { /* path doesn't exist */ }
  }

  return [...candidates];
}

/** Extract class-like tokens from source text using Tailwind's own extraction approach. */
function extractCandidates(source: string, candidates: Set<string>): void {
  // Tailwind v4 uses a broad approach: extract all "word-like" tokens that
  // could be class names. This is deliberately over-inclusive — unused classes
  // are simply not generated (no harm in extra candidates).
  //
  // Match sequences of: letters, digits, hyphens, colons, slashes, dots, brackets
  // This catches: bg-white, hover:text-blue-600, w-[200px], text-sm/6, etc.
  const regex = /[a-zA-Z0-9_\-:./[\]#!]+/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const token = match[0];
    // Skip tokens that are clearly not Tailwind classes
    if (token.length < 2 || token.length > 100) continue;
    if (/^\d/.test(token)) continue; // starts with digit
    if (token.startsWith("//") || token.startsWith("/*")) continue; // comments
    candidates.add(token);
  }
}
