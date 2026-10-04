/**
 * next/font compatibility shim for PRISM.
 *
 * Provides next/font/google and next/font/local that return
 * font configuration objects. PRISM doesn't optimize fonts at
 * the framework level — fonts are loaded via standard CSS
 * (Google Fonts CDN link in layout.tsx).
 *
 * This shim prevents import errors in Next.js apps.
 */

interface FontConfig {
  className: string;
  style: { fontFamily: string };
  variable?: string;
}

/** Google font loader (returns passthrough config). */
export function Inter(opts?: any): FontConfig {
  return googleFont("Inter", opts);
}

export function Roboto(opts?: any): FontConfig {
  return googleFont("Roboto", opts);
}

/** Generic Google font loader. */
function googleFont(family: string, opts?: any): FontConfig {
  const variable = opts?.variable || `--font-${family.toLowerCase().replace(/\s+/g, "-")}`;
  return {
    className: `font-${family.toLowerCase().replace(/\s+/g, "-")}`,
    style: { fontFamily: `'${family}', ${opts?.fallback?.join(", ") || "system-ui, sans-serif"}` },
    variable,
  };
}

/** Local font loader. */
export function localFont(opts: { src: string | { path: string; weight?: string }[]; variable?: string; display?: string }): FontConfig {
  const name = "local-font";
  return {
    className: `font-${name}`,
    style: { fontFamily: name },
    variable: opts.variable,
  };
}

// Default export for next/font/google pattern
export default { Inter, Roboto };
