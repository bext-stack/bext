// HTML tag helpers for asset references in templates.

// Asset manifest cache (loaded once at bundle init time)
let _manifest: Record<string, string> | null = null;

/**
 * Load the CSS/asset manifest for cache-busted URLs.
 * Call this at initialization time:
 * ```ts
 * loadManifest("dist/css-manifest.json");
 * ```
 */
export function loadManifest(path: string): void {
  try {
    _manifest = JSON.parse(__readFile(path));
  } catch {
    _manifest = {};
  }
}

/**
 * Resolve an asset path through the manifest for cache busting.
 * If no manifest is loaded, returns the path unchanged.
 */
export function asset(path: string): string {
  if (!_manifest) return path;
  // Check if the filename matches a manifest entry
  const filename = path.split("/").pop() ?? "";
  if (_manifest[filename]) {
    return path.replace(filename, _manifest[filename]);
  }
  // Check with glob pattern
  for (const [pattern, actual] of Object.entries(_manifest)) {
    if (pattern.includes("*") && filename.match(new RegExp(pattern.replace("*", ".*")))) {
      return path.replace(filename, actual);
    }
  }
  return path;
}

/** Generate a `<link rel="stylesheet">` tag. */
export function stylesheet(href: string, attrs?: Record<string, string>): string {
  const extra = attrs
    ? Object.entries(attrs).map(([k, v]) => ` ${k}="${v}"`).join("")
    : "";
  return `<link rel="stylesheet" href="${href}"${extra}>`;
}

/** Generate a `<script>` tag. */
export function script(src: string, attrs?: Record<string, string | boolean>): string {
  const extra = attrs
    ? Object.entries(attrs)
        .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${v}"`))
        .join("")
    : "";
  return `<script src="${src}"${extra}></script>`;
}

/** Generate a `<link rel="preload">` tag for critical resources. */
export function preload(href: string, as: "style" | "script" | "font" | "image"): string {
  const crossOrigin = as === "font" ? ` crossorigin` : "";
  return `<link rel="preload" href="${href}" as="${as}"${crossOrigin}>`;
}

/** Generate a `<link rel="preconnect">` tag. */
export function preconnect(href: string): string {
  return `<link rel="preconnect" href="${href}">`;
}
