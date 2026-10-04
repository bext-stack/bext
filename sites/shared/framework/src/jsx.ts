// bext JSX runtime — renders JSX to HTML strings.
// No React, no Virtual DOM. String concatenation in the sync fast path,
// AsyncIterable<string> as soon as anything async appears in the tree.
//
// Usage: set `jsxImportSource` to `@bext-stack/framework` in tsconfig.json.
//
// ── Sync (zero-cost) ──────────────────────────────────────────────────
//   function Card({ title }) { return <div>{title}</div>; }
//     → h("div", null, title) → "<div>...</div>"  (string)
//
// ── Async ─────────────────────────────────────────────────────────────
//   async function User({ id }) {
//     const u = await fetch(`/u/${id}`).then(r => r.json());
//     return <p>{u.name}</p>;
//   }
//     → User(props) returns Promise<string>; the host awaits.
//
// ── Streaming ─────────────────────────────────────────────────────────
//   async function* Live({ topic }) {
//     for await (const msg of subscribe(topic)) yield <li>{msg}</li>;
//   }
//     → Live(props) returns AsyncIterable<string>; the host iterates,
//        writing each chunk to the response body as it arrives.
//
// ── Suspense ──────────────────────────────────────────────────────────
//   See `./streaming.ts` (Suspense component + out-of-order swap protocol).
//
// Hot-path notes (do not regress without re-profiling):
//   • escapeHtml regex-bails before the 4 chained .replace() calls.
//     Most Tailwind-style attr values + most leaf children have no
//     special chars; bailing here is ~19% of overall render time on a
//     38 KB Tailwind page (jsx-shootout fixture).
//   • isAsync typeof-short-circuits on string/number/boolean BEFORE
//     probing .then / Symbol.asyncIterator. Sync fixtures see ~1.4×
//     more isAsync calls than h() calls — keep this fast-fail.
//   • formatAttrs uses for-in instead of Object.entries() to skip the
//     2-tuple allocation per attribute.
//   • h() has a primitive-children fast path that avoids the flat()
//     allocation and Array.join entirely when every child is a
//     string/number — the common case for compiled-JSX output.
//
// Renderable = anything h() / a component returns.
export type Renderable =
  | string
  | SafeHtml
  | number
  | boolean
  | null
  | undefined
  | Promise<Renderable>
  | AsyncIterable<Renderable>
  | Renderable[];

type Props = Record<string, any> | null;
type Component<P = any> = (props: P) => Renderable;
type Tag = string | Component;

function isVoidElement(tag: string): boolean {
  // This runs for every intrinsic element. A switch is consistently cheaper
  // than Set.has in both JSC and V8 for this tiny, fixed HTML vocabulary.
  switch (tag) {
    case "area": case "base": case "br": case "col": case "embed":
    case "hr": case "img": case "input": case "link": case "meta":
    case "param": case "source": case "track": case "wbr":
      return true;
    default:
      return false;
  }
}

const ATTR_ALIASES: Record<string, string> = {
  className: "class",
  charSet: "charset",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  tabIndex: "tabindex",
  crossOrigin: "crossorigin",
  autoComplete: "autocomplete",
  autoFocus: "autofocus",
};

// Exported so the build-time PRISM compile pass (bext-core's
// `prism_compile`) can import this exact function and avoid a
// per-file inline helper. Keeping the implementation small and
// match-exact-with-formatAttrs is the load-bearing equivalence
// guarantee for compiled output.
//
// Regex bail-out: if the input has none of the 4 special chars
// we'd replace, the whole function is a no-op. Saves 4 regex
// allocations on the cold path (most Tailwind class strings, most
// leaf labels).
const ESC_RE = /[&<>"]/;
export function escapeHtml(s: string): string {
  if (!ESC_RE.test(s)) return s;
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── XSS-safe child rendering ────────────────────────────────────────
//
// Current output carries rendered-HTML safety out of band with `SafeHtml`.
// SOH (U+0001) is retained only as a compatibility marker for older compiled
// bundles and template helpers. New `h()` / `Fragment` / compile-fold output
// does not place a marker in the response body.
export const HTML_SENTINEL = "\x01";

/** Out-of-band safe-HTML brand (the zero-strip path). h()/Fragment/Raw and the
 *  compile fold wrap already-rendered HTML in `SafeHtml` instead of prefixing a
 *  `\x01` sentinel into the string. Safety is carried by the OBJECT TYPE, never
 *  by a character in the body — so the response NEVER has to strip a sentinel,
 *  and an attacker can't forge the brand (only the framework constructs it).
 *
 *  It `extends String`, so a SafeHtml IS a string for every practical purpose:
 *  `+`, `${}`, `String()`, `.length`, `.includes`/`.slice`/`.replace`/… all work
 *  (PRISM's "components are strings you can manipulate" model is preserved). The
 *  only observable differences from a primitive are `typeof x === "object"` (not
 *  `"string"`) and strict `x === "literal"` (object vs primitive) — both used
 *  only internally, and routed through `instanceof SafeHtml` checks first. The
 *  `.s` exposes the primitive value for the hot-path passthrough. Keep it as a
 *  prototype getter: assigning an own property in every constructor makes
 *  Bun/JSC's native String-subclass allocation several times more expensive. */
export class SafeHtml extends String {
  constructor(s: string) { super(s); }
  get s(): string { return this.valueOf(); }
}
/** Wrap pre-rendered HTML as a SafeHtml brand. */
export function safe(s: string): SafeHtml { return new SafeHtml(s); }
/** True for a SafeHtml brand. */
export function isSafe(v: unknown): v is SafeHtml { return v instanceof SafeHtml; }

/** True iff `s` is already-rendered HTML carrying the LEGACY `\x01` sentinel
 *  (still emitted by un-migrated fold output / sites during the SafeHtml
 *  transition). Cheap charCode check, no allocation. */
export function isSafeHtmlString(s: string): boolean {
  return s.length > 0 && s.charCodeAt(0) === 1;
}

/** Remove the reserved legacy safe-HTML sentinel (\x01) from a string. \x01 has
 *  NO legitimate use in user content. Untrusted input MUST be scrubbed of it at
 *  the request boundary (see prism-runtime `sanitizeEnvelope` / multipart),
 *  otherwise an attacker-supplied `\x01<script>` field would forge the sentinel
 *  and bypass child escaping (isSafeHtmlString → passthrough). indexOf-bails on
 *  the common case (no sentinel). */
export function stripSentinel(s: string): string {
  return s.indexOf(HTML_SENTINEL) === -1 ? s : s.replace(/\x01/g, "");
}

/** Emit a string child: pass legacy marker-bearing strings through after
 *  removing the marker; otherwise HTML-escape them. SafeHtml objects take the
 *  out-of-band fast path above. This makes runtime-rendered `{expr}`
 *  children safe-by-default — the same rule the compile pass already applies
 *  via `__bextChild`/`renderChild`, and the signals runtime applies too.
 *  `escapeHtml` regex-bails on plain text, so the common
 *  case (no special chars) costs one regex test. */
function emitChild(c: any): string {
  if (c instanceof SafeHtml) return c.s;                 // brand → clean passthrough
  // Legacy \x01-marked string: SLICE the marker (the parent re-wraps this body
  // in safe(), so the brand re-establishes safety — the in-band marker is
  // redundant and must not survive to the now-strip-less response sink). Plain
  // string → escape. Inline the tiny legacy test here: this is the hottest
  // string-child path, and V8 otherwise does not inline the exported helper.
  if (c.length > 0 && c.charCodeAt(0) === 1) return c.slice(1);
  return escapeHtml(c);
}

/** Recursively flatten arrays + drop nullish/booleans, BUT preserve
 *  Promises and AsyncIterables (don't coerce them to "[object Promise]"). */
function flat(children: any[]): any[] {
  const result: any[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) result.push(...flat(child));
    else result.push(child);
  }
  return result;
}

function isAsync(v: any): boolean {
  if (v == null) return false;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return false;
  if (t === "object" || t === "function") {
    if (typeof v.then === "function") return true;
    if (typeof v[Symbol.asyncIterator] === "function") return true;
  }
  return false;
}

function formatStyle(style: Record<string, string | number>): string {
  let out = "";
  let first = true;
  for (const k in style) {
    if (!first) out += ";";
    first = false;
    out += k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()) + ":" + style[k];
  }
  return out;
}

// URL-bearing attributes whose value can carry a `javascript:` / `vbscript:`
// scheme — HTML-escaping does NOT neutralize that, so `<a href={userInput}>`
// is an XSS sink. We DROP the attribute when its value resolves to a dangerous
// scheme. `data:` is additionally blocked on *navigation* attrs (where
// `data:text/html` executes) but allowed on media attrs so data-URI images
// keep working.
const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "poster", "xlink:href",
  "cite", "ping", "background", "data",
]);
const NAV_URL_ATTRS = new Set(["href", "action", "formaction", "cite", "ping"]);

function isDangerousUrl(value: string, isNav: boolean): boolean {
  // Browsers ignore ASCII whitespace/control chars inside URLs (the classic
  // `java\tscript:` evasion), so strip 0x00–0x20 before testing the scheme;
  // lower-case for case-insensitivity. HTML-entity evasions (`&#106;avascript:`)
  // are already inert because formatAttrs escapes `&`.
  const v = value.replace(/[\x00-\x20]+/g, "").toLowerCase();
  if (v.startsWith("javascript:") || v.startsWith("vbscript:")) return true;
  if (isNav && v.startsWith("data:")) return true;
  return false;
}

// Repeated rows commonly alternate between two class attributes. Retain those
// exact-value escape results so they skip the regex scan without weakening
// escaping or growing an unbounded global cache.
let lastClassValue: string | undefined;
let lastEscapedClass = "";
let previousClassValue: string | undefined;
let previousEscapedClass = "";

/** Render ONE already-canonical attribute exactly as `formatAttrs` would.
 *
 *  The compiler's fold pass bakes attributes into a static string. For a
 *  dynamic value it used to emit ` name="` + escapeHtml(v) + `"` unconditionally,
 *  which diverges from `formatAttrs` in two ways that both produce wrong HTML:
 *
 *    - `undefined` / `null` / `false` must make the attribute DISAPPEAR. Baked
 *      instead, `selected={cond ? true : undefined}` shipped
 *      `selected="undefined"`, and because HTML treats any PRESENT `selected`
 *      as true, every option in a <select> looked selected and the browser kept
 *      the LAST one. Same class of bug for checked / disabled / open.
 *    - `true` must render as a BARE attribute (`selected`), not `selected="true"`.
 *
 *  The fold now calls this for any dynamic attribute value, so compiled and
 *  runtime output agree. `name` is passed post-alias (class, for, ...); URL
 *  attrs are still handled by the fold bailing to the runtime path.
 *  Guarded by fold-contract.test.ts and by the Rust-side
 *  folded_conditional_attr_* tests. */
export function attr(name: string, value: unknown): string {
  if (value == null || value === false) return "";
  if (value === true) return " " + name;
  const sv = typeof value === "string" ? value : String(value);
  if (URL_ATTRS.has(name) && isDangerousUrl(sv, NAV_URL_ATTRS.has(name))) return "";
  return ` ${name}="${escapeHtml(sv)}"`;
}

function formatAttrs(props: Props): string {
  if (!props) return "";
  let out = "";
  for (const key in props) {
    if (key === "children" || key === "key" || key === "ref") continue;
    if (key === "dangerouslySetInnerHTML") continue;
    const value = props[key];
    if (value == null || value === false) continue;
    // Classes dominate real JSX prop traffic and can never be URL sinks. Keep
    // them off the alias-table and URL-set paths while retaining identical
    // coercion and escaping semantics for dynamic class values.
    if (key === "className" || key === "class") {
      if (value === true) out += " class";
      else {
        const classValue = typeof value === "string" ? value : String(value);
        let escapedClass: string;
        if (classValue === lastClassValue) escapedClass = lastEscapedClass;
        else if (classValue === previousClassValue) {
          escapedClass = previousEscapedClass;
          previousClassValue = lastClassValue;
          previousEscapedClass = lastEscapedClass;
          lastClassValue = classValue;
          lastEscapedClass = escapedClass;
        } else {
          escapedClass = escapeHtml(classValue);
          previousClassValue = lastClassValue;
          previousEscapedClass = lastEscapedClass;
          lastClassValue = classValue;
          lastEscapedClass = escapedClass;
        }
        out += ` class="${escapedClass}"`;
      }
      continue;
    }
    const attr = ATTR_ALIASES[key] ?? key;
    if (value === true) {
      out += " " + attr;
    } else if (key === "style" && typeof value === "object") {
      out += ` style="${escapeHtml(formatStyle(value))}"`;
    } else {
      const sv = typeof value === "string" ? value : String(value);
      // Drop URL attributes whose value resolves to a dangerous scheme
      // (`javascript:` etc.) — HTML-escaping alone wouldn't neutralize it.
      if (URL_ATTRS.has(attr) && isDangerousUrl(sv, NAV_URL_ATTRS.has(attr))) continue;
      out += ` ${attr}="${escapeHtml(sv)}"`;
    }
  }
  return out;
}

/** Coerce any Renderable into AsyncIterable<string>. The host iterator
 *  pumps these into the HTTP response body. Pure adapter — order of
 *  yields exactly matches the order the engine reaches the values. */
export async function* asAsyncIterable(value: Renderable): AsyncIterable<string> {
  if (value == null || value === false || value === true) return;
  if (value instanceof SafeHtml) { yield value.s; return; } // brand → clean HTML, no sentinel
  // NOTE: do NOT escape here — asAsyncIterable also re-processes already-
  // rendered HTML fragments (asyncElement tag open/close, streaming/Suspense
  // chunks) which carry no sentinel. Escaping of user-data string children
  // happens at the element boundary (asyncElement / Fragment), not here.
  if (typeof value === "string") { yield value; return; }
  if (typeof value === "number") { yield String(value); return; }
  if (Array.isArray(value)) {
    // Coalesce runs of SYNC leaves (string / number / SafeHtml) into a single
    // yield instead of delegating to a fresh `asAsyncIterable` generator per
    // item. A mixed array (e.g. `{items.map(...)}` interleaved with an async
    // child) otherwise spins up N nested `yield*` generators, each with its own
    // Promise/microtask chain. Behaviour-identical: asAsyncIterable never
    // escapes strings here, and yields `SafeHtml.s` / `String(number)` for the
    // other two — exactly what the buffer accumulates.
    let buf = "";
    for (const v of value) {
      if (v == null || v === false || v === true) continue;
      if (typeof v === "string") { buf += v; continue; }
      if (typeof v === "number") { buf += String(v); continue; }
      if (v instanceof SafeHtml) { buf += v.s; continue; }
      if (buf) { yield buf; buf = ""; }
      yield* asAsyncIterable(v);
    }
    if (buf) yield buf;
    return;
  }
  // Promise<Renderable>
  if (typeof (value as any).then === "function") {
    const resolved = await (value as Promise<Renderable>);
    yield* asAsyncIterable(resolved);
    return;
  }
  // AsyncIterable<Renderable>
  if (typeof (value as any)[Symbol.asyncIterator] === "function") {
    for await (const item of value as AsyncIterable<Renderable>) {
      yield* asAsyncIterable(item);
    }
    return;
  }
  // Defensive — shouldn't reach here for well-typed components.
  yield escapeHtml(String(value));
}

/** Drain an AsyncIterable<string> into a single string. Used by tests
 *  and by the host's non-streaming fallback. Streaming consumers should
 *  iterate directly via `for await`. */
export async function collect(iter: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of iter) out += chunk;
  return out;
}

/** The JSX factory.
 *
 *  Returns a string when the entire subtree resolves synchronously
 *  (zero allocations beyond the existing string concat). Returns an
 *  `AsyncIterable<string>` (or `Promise<string>` from a component) as
 *  soon as anything async is encountered, so the streaming host can
 *  pipe chunks to the response without buffering. */
export function h(tag: Tag, props: Props, ...children: any[]): Renderable {
  // Component invocation. We don't know yet whether the result is
  // sync or async — pass it back to the caller as-is. The runtime
  // adapters (`asAsyncIterable`) handle either.
  if (typeof tag === "function") {
    if (children.length === 0) {
      // No children — pass props directly, skip the {...props} clone.
      return (tag as Component)(props ?? {});
    }
    const merged: any = { ...props };
    const flatChildren = flat(children);
    merged.children = flatChildren.length === 1 ? flatChildren[0] : flatChildren;
    return (tag as Component)(merged);
  }

  const attrs = formatAttrs(props);

  // Raw-text elements (HTML spec): `<script>` / `<style>` content is CDATA —
  // the parser reads verbatim until the closing tag and does NOT decode
  // character references. HTML-escaping their children would corrupt the JS/CSS
  // (`<` → `&lt;`). So children pass through unescaped here, exactly as a string
  // template would. (`<textarea>`/`<title>` are *escapable* raw-text — they DO
  // get escaped, which is correct: it prevents `</textarea>` breakout.)
  const rawText = tag === "script" || tag === "style";

  // dangerouslySetInnerHTML — sync, regardless of children (which are dropped).
  if (props?.dangerouslySetInnerHTML?.__html != null) {
    return safe(`<${tag}${attrs}>${props.dangerouslySetInnerHTML.__html}</${tag}>`);
  }

  // Void elements (self-closing) — sync.
  if (isVoidElement(tag)) {
    return safe(`<${tag}${attrs}>`);
  }

  // Element body. Fast-path the common cases: zero/one primitive
  // children, then all-primitive children (skip flat() allocation
  // and Array.join entirely). Fall through to the general path for
  // arrays / mixed / async children.
  const len = children.length;
  if (len === 0) return safe(`<${tag}${attrs}></${tag}>`);
  if (len === 1) {
    const c = children[0];
    if (c == null || c === false || c === true) return safe(`<${tag}${attrs}></${tag}>`);
    const t = typeof c;
    if (t === "string") return safe(`<${tag}${attrs}>${rawText ? c : emitChild(c)}</${tag}>`);
    if (t === "number" || t === "boolean") return safe(`<${tag}${attrs}>${c}</${tag}>`);
    if (c instanceof SafeHtml) return safe(`<${tag}${attrs}>${c.s}</${tag}>`);
    // else fall through to general path
  }

  // Speculatively build the sync body while classifying children. The old
  // shape first scanned the whole list with isAsync(), then scanned it again
  // to concatenate. Nested JSX is overwhelmingly SafeHtml/string/number, so a
  // single pass removes both the duplicate walk and async-property probes from
  // the steady-state path. If an array/async child appears, discard this small
  // prefix and take the fully general path below.
  let body = "";
  let allPrimitive = true;
  for (let i = 0; i < len; i++) {
    const c = children[i];
    if (c == null || c === false || c === true) continue;
    const t = typeof c;
    if (t === "string") { body += rawText ? c : emitChild(c); continue; }
    if (t === "number") { body += c; continue; }
    if (c instanceof SafeHtml) { body += c.s; continue; }
    if (Array.isArray(c) || isAsync(c)) { allPrimitive = false; break; }
    body += c;
  }
  if (allPrimitive) return safe(`<${tag}${attrs}>${body}</${tag}>`);

  // General path: handle arrays + falsy + Promises/iters.
  const flatChildren = flat(children);
  let anyAsync = false;
  for (let i = 0; i < flatChildren.length; i++) {
    if (isAsync(flatChildren[i])) { anyAsync = true; break; }
  }
  if (!anyAsync) {
    let body = "";
    for (let i = 0; i < flatChildren.length; i++) {
      const c = flatChildren[i];
      body += typeof c === "string" ? (rawText ? c : emitChild(c)) : (c instanceof SafeHtml ? c.s : String(c));
    }
    return safe(`<${tag}${attrs}>${body}</${tag}>`);
  }
  return asyncElement(tag, attrs, flatChildren);
}

async function* asyncElement(
  tag: string,
  attrs: string,
  children: any[],
): AsyncIterable<string> {
  const rawText = tag === "script" || tag === "style";
  yield `<${tag}${attrs}>`;
  // Coalesce consecutive sync children (string / SafeHtml / number) into one
  // yield; only break the buffer for genuinely async children. `children` is
  // already flattened (no arrays / nullish) by the caller. Behaviour-identical
  // to the per-child path: string → emitChild (or verbatim for raw-text),
  // SafeHtml → `.s`, number → String — the same values asAsyncIterable yielded.
  let buf = "";
  for (const child of children) {
    if (typeof child === "string") { buf += rawText ? child : emitChild(child); continue; }
    if (child instanceof SafeHtml) { buf += child.s; continue; }
    if (typeof child === "number") { buf += String(child); continue; }
    if (buf) { yield buf; buf = ""; }
    yield* asAsyncIterable(child);
  }
  if (buf) yield buf;
  yield `</${tag}>`;
}

/** Pass-through HTML, no escape applied. The opt-out for the
 *  auto-escape default introduced alongside `[render] auto_escape_children`.
 *
 *  Today bext's JSX runtime treats string children as already-rendered
 *  HTML (passthrough). When auto-escape is enabled (config flag) string
 *  children are escaped by default; `Raw` is the explicit "I really do
 *  mean HTML" opt-out:
 *
 *    <p>{user.bio}</p>                  // escaped (when flag is on)
 *    <p><Raw html={renderedMarkdown} /></p>  // passthrough
 *
 *  Use sparingly. The argument MUST be a string the caller has already
 *  vetted as safe HTML — otherwise this is an XSS primitive. Async
 *  values are accepted (Promise<string> / AsyncIterable<string>) so a
 *  streamed-MDX child works without a wrapper. */
export function Raw(props: {
  html: string | Promise<string> | AsyncIterable<string>;
}): Renderable {
  const v: any = props?.html;
  if (v == null) return "";
  if (typeof v === "string") return safe(v);
  if (v instanceof SafeHtml) return v;
  // Async Raw: yield the already-vetted HTML verbatim (NO \x01 sentinel —
  // zerostrip). These chunks flow only to asAsyncIterable → the streaming sink
  // (which does not re-escape) or get collected into a buffered body; neither
  // re-escapes, so the marker was pure strip-bait. (The one theoretical loss:
  // collect()-ing an async Raw and re-embedding the string as a {fold child}
  // would now escape it — but nothing does that; async Raw is streamed in-tree.)
  if (typeof v.then === "function") {
    return (async function* () {
      const s = await v;
      yield s == null ? "" : String(s);
    })();
  }
  if (typeof v[Symbol.asyncIterator] === "function") {
    return (async function* () {
      for await (const chunk of v) yield String(chunk);
    })();
  }
  return safe(String(v));
}

/** Stringify a JSX child the way h()'s general path does: drop
 *  null/false/true, recursively flatten arrays, concat the rest.
 *  The PRISM compile pass (`bext-core::transform::prism_compile`)
 *  emits `__bextChild(expr)` for Tier 2 `{expr}` fallbacks so the
 *  folded output matches h()'s `flat()`+`.join("")` semantics — a
 *  raw `(arr)` would Array.toString() with commas, and `(null)`
 *  would stringify as "null". Sync only: Tier 2 already bails when
 *  the expression references `children`, so async values never
 *  reach this helper. */
export function renderChild(c: any): string {
  // Compiled loops overwhelmingly feed scalar strings here (table cells,
  // labels, option text). Keep that case ahead of the null/brand/array
  // fallbacks so it pays only one typeof check plus the escaping contract.
  if (typeof c === "string") {
    if (c.length > 0 && c.charCodeAt(0) === 1) return c.slice(1);
    return escapeHtml(c);
  }
  if (c == null || c === false || c === true) return "";
  if (c instanceof SafeHtml) return c.s; // brand → clean passthrough (no sentinel)
  if (Array.isArray(c)) {
    let s = "";
    for (let i = 0; i < c.length; i++) s += renderChild(c[i]);
    return s;
  }
  return escapeHtml(String(c));
}

/** JSX `<>...</>` fragment. Same sync-vs-async logic as element children. */
export function Fragment(props: { children?: any }): Renderable {
  const c = props.children;
  if (c == null) return "";
  const arr = Array.isArray(c) ? flat(c) : [c];
  let body = "";
  let anyAsync = false;
  for (let i = 0; i < arr.length; i++) {
    const child = arr[i];
    if (typeof child === "string") { body += emitChild(child); continue; }
    if (child instanceof SafeHtml) { body += child.s; continue; }
    if (isAsync(child)) { anyAsync = true; break; }
    body += String(child);
  }
  if (!anyAsync) return safe(body);
  return (async function* () {
    for (const child of arr) {
      if (typeof child === "string") yield emitChild(child);
      else yield* asAsyncIterable(child);
    }
  })();
}

// ── Automatic JSX runtime exports ──────────────────────────────────────
// SWC / tsc-rs's `jsx: "react-jsx"` mode emits
//   `import { jsx, jsxs, Fragment } from "<jsxImportSource>/jsx-runtime"`
// at every JSX call site. We provide those bindings HERE (instead of in
// a separate `jsx-runtime.ts`) so a single bundled module satisfies
// both the framework's primitives and the compiled-JSX import target.
//
// Why merged: bext-turbopack's closure walker only inlines a module
// once into `globalThis.__modules`. The page's compiled code emits
// `require("/abs/.../jsx-runtime.ts")`; resolving that to the SAME
// abs path the walker already inlined (jsx.ts) means the runtime
// finds the bindings without needing a second registry entry.
// Package.json `./jsx-runtime` re-points to `./src/jsx.ts` for this
// reason.
function _jsx(tag: any, props: any, _key?: any): Renderable {
  // Intrinsic formatting already ignores the `children` prop. Reuse the
  // compiler-created props object instead of cloning it at every element.
  if (typeof tag !== "function") {
    const children = props?.children;
    if (Array.isArray(children)) return h(tag, props, ...children);

    // Automatic JSX emits the common zero/scalar-child shapes directly in
    // `props`. Render those here so every leaf does not allocate h()'s rest
    // array and take a second dispatch. Complex objects (Promise/iterable)
    // retain the general h() path below.
    const childType = typeof children;
    const safeChild = childType === "object" && children instanceof SafeHtml;
    if (
      children == null || children === false || children === true ||
      childType === "string" || childType === "number" ||
      safeChild
    ) {
      const attrs = formatAttrs(props);
      if (props?.dangerouslySetInnerHTML?.__html != null) {
        return safe(`<${tag}${attrs}>${props.dangerouslySetInnerHTML.__html}</${tag}>`);
      }
      if (isVoidElement(tag)) return safe(`<${tag}${attrs}>`);
      if (children == null || children === false || children === true) {
        return safe(`<${tag}${attrs}></${tag}>`);
      }
      if (childType === "string") {
        const rawText = tag === "script" || tag === "style";
        return safe(`<${tag}${attrs}>${rawText ? children : emitChild(children)}</${tag}>`);
      }
      if (safeChild) {
        return safe(`<${tag}${attrs}>${children.s}</${tag}>`);
      }
      return safe(`<${tag}${attrs}>${children}</${tag}>`);
    }
    return h(tag, props, children);
  }

  if (props == null || !("children" in props)) return tag(props ?? {});
  const componentChildren = props.children;
  if (Array.isArray(componentChildren)) {
    if (componentChildren.length > 1) {
      let alreadyFlat = true;
      for (let i = 0; i < componentChildren.length; i++) {
        const child = componentChildren[i];
        if (!(i in componentChildren) || child == null || child === false || child === true || Array.isArray(child)) {
          alreadyFlat = false;
          break;
        }
      }
      if (alreadyFlat) return tag(props);
    }
  } else if (
    componentChildren != null && componentChildren !== false && componentChildren !== true
  ) return tag(props);

  const { children, ...rest } = props || {};
  if (children != null) {
    if (Array.isArray(children)) return h(tag, rest, ...children);
    return h(tag, rest, children);
  }
  return h(tag, rest);
}
// Direct exports (NOT re-export aliases): the prod compile runs Turbopack
// tree_shaking_mode=ReexportsOnly; jsx/jsxs are consumed via a runtime
// require() the static shaker cannot see, so an 
// re-export gets dropped -> .
export function jsx(tag: any, props: any, key?: any) { return _jsx(tag, props, key); }
export function jsxs(tag: any, props: any, key?: any) { return _jsx(tag, props, key); }
export function jsxDEV(tag: any, props: any, key?: any) { return _jsx(tag, props, key); }
