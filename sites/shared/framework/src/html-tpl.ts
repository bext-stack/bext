// `htmlTpl` — an auto-escaping tagged template literal (T1.2 — additive).
//
// Named `htmlTpl` (NOT `html` — the barrel's `html` is the BextResponse helper
// from `./response`). Aliased as `safeHtml`. Companion passthrough is `rawHtml`
// (lowercase — distinct from the existing capital-`Raw` JSX component).
//
// Each `${value}` is HTML-escaped via the framework's EXISTING `escapeHtml`
// (no 4th copy), EXCEPT a value wrapped in `rawHtml()` OR one that already
// carries the `\x01` safe-HTML sentinel — i.e. a nested framework component /
// element result. This makes composition work:
//
//   htmlTpl`<button class="${cls}">${Badge({ label })}</button>`
//
// `cls` (plain string) is escaped; `Badge(...)` (sentinel-carrying rendered
// HTML) passes through. Same escaping + sentinel semantics as the JSX path
// (`jsx.ts` `emitChild` / `renderChild`), so the two compose cleanly.
//
// Security note: `htmlTpl` trusts the `\x01` sentinel exactly as the JSX path
// already does — it is no safer and no less safe than JSX. It does NOT close
// the pre-existing forgeable-sentinel hole (untrusted `\x01` from DB/fetch/KV
// must still be scrubbed at the request boundary — see `jsx.ts` `stripSentinel`
// and the prism-runtime envelope sanitizer). This is an ergonomic helper, not
// the sentinel fix.

import { escapeHtml, isSafeHtmlString, SafeHtml, safe } from "./jsx";

/**
 * Mark a string as already-rendered, trusted HTML so `htmlTpl` passes it
 * through unescaped. Prepends the framework's safe-HTML sentinel — identical
 * to how `h()` / `Fragment` / `Raw` mark their output. Use sparingly: the
 * argument MUST be HTML the caller has already vetted as safe, otherwise this
 * is an XSS primitive. Returns the input verbatim if it is already sentinel-
 * marked (idempotent — avoids double-marking a nested component result).
 */
export function rawHtml(s: string | SafeHtml): SafeHtml {
  if (s instanceof SafeHtml) return s;
  const str = String(s);
  // Legacy \x01-marked → unwrap the marker into a brand; plain → brand as-is.
  return safe(isSafeHtmlString(str) ? str.slice(1) : str);
}

// Render one interpolated `${value}`. Mirrors `jsx.ts`'s child semantics:
//   • null / undefined / false  → skipped (empty)         (true is also skipped)
//   • sentinel-carrying string  → passthrough (already-rendered HTML)
//   • plain string              → escaped via existing escapeHtml
//   • number                    → stringified, then escaped (no special chars,
//                                 but escapeHtml indexOf-bails so it is free)
//   • array                     → each item rendered + joined (flattens nested)
function emitValue(value: unknown): string {
  if (value == null || value === false || value === true) return "";
  if (value instanceof SafeHtml) return value.s; // brand → clean passthrough
  if (typeof value === "string") {
    // Legacy \x01-marked passes through (marker sliced); plain → escape.
    return isSafeHtmlString(value) ? value.slice(1) : escapeHtml(value);
  }
  if (typeof value === "number") return escapeHtml(String(value));
  if (Array.isArray(value)) {
    let out = "";
    for (let i = 0; i < value.length; i++) out += emitValue(value[i]);
    return out;
  }
  // Any other type (bigint, object coerced by a caller, etc.): stringify +
  // escape, matching the JSX general path's defensive `escapeHtml(String(c))`.
  return escapeHtml(String(value));
}

/**
 * Auto-escaping tagged template literal. Concatenates the static `strings`
 * with each interpolated value rendered via {@link emitValue} (escaped unless
 * `rawHtml()`-wrapped or sentinel-marked). Returns a plain HTML string.
 *
 *   htmlTpl`<p>${user.bio}</p>`                      // bio escaped
 *   htmlTpl`<div>${rawHtml(renderedMarkdown)}</div>` // passthrough
 *   htmlTpl`<ul>${items.map((i) => htmlTpl`<li>${i}</li>`)}</ul>` // composes
 */
export function htmlTpl(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += emitValue(values[i]);
    out += strings[i + 1] ?? "";
  }
  return safe(out); // brand so {htmlTpl`…`} passes through unescaped in JSX
}

/** Alias for {@link htmlTpl}. */
export const safeHtml = htmlTpl;
