// Universal JSX adapter for "use signals" components.
//
// One factory, two modes. The render context (set by the entry points
// in `./server.ts` and `./hydrate.ts`) tells `h()` whether it's in
// "server" mode (emit HTML strings with resumability markers) or
// "client" mode (emit HTML strings AND collect bindings for hydration).
//
// Marker convention
//
//   Reactive text content:
//     <!--bs<N>-->INITIAL<!--/bs<N>-->
//   Reactive attribute:
//     <el data-bs-attr<N>="<name>" <name>="INITIAL"> ...
//   Event handler:
//     <el data-bs-on<event>="<N>"> ...
//
// IDs are allocated in source order during component execution. Both
// server and client run the same component code, so the IDs match.
// The hydrator walks the existing DOM looking for these markers and
// attaches bindings/handlers from the bindings list it collected.
//
// HTML escape policy: same as the base bext JSX runtime — string
// children are *not* auto-escaped (they're treated as pre-rendered
// HTML). Signal/computed/function-derived values get coerced to
// strings then escaped — so `{user.name}` is XSS-safe when expressed
// reactively, while raw `{rawHtml}` interpolation is the user's
// responsibility (mirrors the base runtime).

import { isSignal, type Signal } from "./core";
import { escapeHtml } from "../jsx";

// ── Render context ─────────────────────────────────────────────────────

export type RenderMode = "server" | "client";

export type Reactive<T> = Signal<T> | (() => T);

export type Binding =
  | { type: "text"; markerId: number; reactive: Reactive<unknown> }
  | { type: "attr"; markerId: number; name: string; reactive: Reactive<unknown> }
  | {
      type: "list";
      markerId: number;
      reactive: Reactive<unknown[]>;
      render: (item: any, i: number) => string;
      /** Optional key fn — when present, the hydrator does keyed
       *  reconciliation (move existing item nodes instead of full
       *  rebuild) and items render in per-item subcontexts so handler
       *  IDs don't collide across items. */
      key?: (item: any, i: number) => string | number;
    }
  | {
      /** Reactive subtree swap. Server emits the active branch wrapped
       *  in `<!--bsShow{markerId}-->...<!--/bsShow{markerId}-->`; client
       *  re-runs the active branch's render in a fresh subcontext on
       *  every `when` change and replaces the inner DOM. Per-render
       *  handlers/bindings are scoped to that render and disposed when
       *  the branch flips. Use this for any state-dependent subtree —
       *  loading skeletons, error banners, modal open/close, etc. */
      type: "show";
      markerId: number;
      when: Reactive<unknown>;
      body: () => string;
      fallback?: () => string;
    };

export interface RenderContext {
  mode: RenderMode;
  /** Counter for marker IDs (text/attr bindings). */
  nextMarker: number;
  /** Counter for handler IDs. */
  nextHandler: number;
  /** Client-side: handler functions in the order they were attached.
   *  Server-side: stays empty (closures aren't serializable). */
  handlers: Function[];
  /** Client-side: the bindings the hydrator attaches after DOM walk.
   *  Server-side: stays empty. */
  bindings: Binding[];
  /** Resumable render only: maps each `__rsig`/`__rcomp`-registered reactive to
   *  its stable id, so the renderer can serialize values + marker→signalId.
   *  Unset otherwise. */
  __sigToId?: Map<unknown, string>;
  /** Resumable render only: the ids registered via `__rcomp` (computeds). The
   *  serializer skips these when emitting plain-signal values — a computed is
   *  re-derived on resume from its `__ccomp` formula, not serialized. */
  __computedIds?: Set<string>;
}

let _ctx: RenderContext | null = null;

export function setRenderContext(ctx: RenderContext | null): void {
  _ctx = ctx;
}

export function getRenderContext(): RenderContext {
  if (!_ctx) {
    // A reactive re-render (effect) reached a JSX component with no active
    // context. Throwing here aborts the binding's render and FREEZES the
    // subtree (e.g. a <Switch> that never swaps off "Project not found").
    // Provide a fresh client context instead so the render completes — the
    // produced HTML is still correct; at worst a deeply-nested reactive bit
    // in this orphaned subtree renders once without re-binding, which is far
    // better than aborting the whole swap. Set it so sibling calls in the
    // same synchronous render share one context (consistent marker numbering).
    _ctx = createRenderContext("client");
  }
  return _ctx;
}

export function createRenderContext(mode: RenderMode): RenderContext {
  return {
    mode,
    nextMarker: 0,
    nextHandler: 0,
    handlers: [],
    bindings: [],
  };
}

// ── HTML constants (mirror base jsx.ts) ────────────────────────────────

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const ATTR_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  tabIndex: "tabindex",
  crossOrigin: "crossorigin",
  autoComplete: "autocomplete",
  autoFocus: "autofocus",
};

function isReactive(v: unknown): v is Reactive<unknown> {
  return isSignal(v) || typeof v === "function";
}

function readReactive(v: Reactive<unknown>): unknown {
  if (typeof v === "function") return (v as () => unknown)();
  // `.value` (tracking), NOT `.peek()`. When a signal/computed is passed
  // DIRECTLY as a control-flow condition (`<Show when={sig}>`,
  // `<Match when={sig}>`), the hydration effect must subscribe to it so the
  // branch re-renders when it changes. `peek()` reads without tracking, so
  // direct-signal conditions silently never updated (e.g. cloud
  // ProjectDetail stuck on "Project not found" after its data loaded).
  // During SSR there's no observer, so `.value` doesn't track — same as peek.
  return v.value;
}

function formatStyle(style: Record<string, string | number>): string {
  return Object.entries(style)
    .map(([k, val]) => {
      const prop = k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
      return `${prop}:${val}`;
    })
    .join(";");
}

// ── h() ────────────────────────────────────────────────────────────────

type Props = Record<string, any> | null;
type Tag = string | ((props: any) => string);

/** JSX factory. Always returns a string (the HTML for this subtree).
 *  Side effects: increments marker/handler counters on the active
 *  render context, and pushes to `handlers` / `bindings` in client
 *  mode. */
export function h(tag: Tag, props: Props, ...children: any[]): string {
  // Component invocation — call it; merged props include children.
  if (typeof tag === "function") {
    const merged: any = { ...(props ?? {}) };
    if (children.length > 0) {
      const flat = children.flat(Infinity).filter((c) => c != null && c !== false && c !== true);
      merged.children = flat.length === 1 ? flat[0] : flat;
    }
    const out = tag(merged);
    return typeof out === "string" ? out : String(out ?? "");
  }

  const ctx = getRenderContext();

  // Build attrs.
  const attrParts: string[] = [];
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (key === "children" || key === "key" || key === "ref") continue;
      if (key === "dangerouslySetInnerHTML") continue;
      if (value == null || value === false) continue;

      // Resumable handler reference (from `__rhref(sym)`): emit the symbol
      // directly so the resume runtime can look it up in `Component.__rh`.
      // No closure is stored — the component never re-runs on the client.
      if (
        key.length > 2 &&
        key.startsWith("on") &&
        value &&
        typeof value === "object" &&
        typeof (value as { __rhsym?: unknown }).__rhsym === "string"
      ) {
        const eventName = key.slice(2).toLowerCase();
        const sym = (value as { __rhsym: string }).__rhsym
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;");
        attrParts.push(`data-bs-on${eventName}="${sym}"`);
        continue;
      }

      // Event handler: onClick → data-bs-onclick="<id>".
      if (key.length > 2 && key.startsWith("on") && typeof value === "function") {
        const eventName = key.slice(2).toLowerCase();
        const id = ctx.nextHandler++;
        if (ctx.mode === "client") {
          ctx.handlers[id] = value as Function;
        }
        attrParts.push(`data-bs-on${eventName}="${id}"`);
        continue;
      }

      // Reactive attribute (signal or thunk).
      if (isReactive(value)) {
        const id = ctx.nextMarker++;
        const initial = readReactive(value);
        const attrName = ATTR_ALIASES[key] ?? key;
        if (ctx.mode === "client") {
          ctx.bindings.push({ type: "attr", markerId: id, name: attrName, reactive: value });
        }
        if (initial == null || initial === false) {
          attrParts.push(`data-bs-attr${id}="${attrName}"`);
        } else if (initial === true) {
          attrParts.push(`data-bs-attr${id}="${attrName}" ${attrName}`);
        } else {
          attrParts.push(
            `data-bs-attr${id}="${attrName}" ${attrName}="${escapeHtml(String(initial))}"`,
          );
        }
        continue;
      }

      // Static value.
      const attr = ATTR_ALIASES[key] ?? key;
      if (value === true) {
        attrParts.push(attr);
      } else if (key === "style" && typeof value === "object") {
        attrParts.push(`style="${escapeHtml(formatStyle(value))}"`);
      } else {
        attrParts.push(`${attr}="${escapeHtml(String(value))}"`);
      }
    }
  }

  const attrs = attrParts.length > 0 ? " " + attrParts.join(" ") : "";

  // dangerouslySetInnerHTML — no children processing, no escaping.
  if (props?.dangerouslySetInnerHTML?.__html != null) {
    return `<${tag as string}${attrs}>${props.dangerouslySetInnerHTML.__html}</${tag as string}>`;
  }

  if (typeof tag === "string" && VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrs}>`;
  }

  // Children — flatten, drop nullish/booleans, render reactive bits with markers.
  let inner = "";
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === true) continue;

    if (typeof child === "string") {
      // Pre-rendered HTML (from a nested h() call) OR raw user string.
      // Match base jsx.ts: pass through unescaped.
      inner += child;
      continue;
    }
    if (typeof child === "number") {
      // Numbers don't need escaping — purely digits.
      inner += String(child);
      continue;
    }

    if (isReactive(child)) {
      // Reactive text — emit markers around the initial value.
      const id = ctx.nextMarker++;
      const initial = readReactive(child);
      if (ctx.mode === "client") {
        ctx.bindings.push({ type: "text", markerId: id, reactive: child });
      }
      const text = initial == null ? "" : escapeHtml(String(initial));
      inner += `<!--bs${id}-->${text}<!--/bs${id}-->`;
      continue;
    }

    // Defensive — unexpected shape.
    inner += escapeHtml(String(child));
  }

  return `<${tag as string}${attrs}>${inner}</${tag as string}>`;
}

/** Reactive list. Server emits paired list markers around the
 *  initially-rendered items; client records a "list" binding so the
 *  hydrator can re-run `render(item, i)` on each `each` change.
 *
 *  Without `key`: full rebuild on every change. Items render in the
 *  outer context, so the global handler-counter advances by N during
 *  initial render. The hydrator's first walk attaches per-item handlers
 *  via the outer ctx; subsequent updates clear all DOM and re-render.
 *
 *  With `key`: keyed reconciliation. Each item renders in its own
 *  subcontext (handler IDs scoped per-item), and per-item open/close
 *  markers `<!--bsI{listId}:{key}-->` wrap the rendered HTML. The
 *  hydrator walks markers to populate a `Map<key, ItemState>`; on
 *  re-render, only changed keys move/render. Identity is preserved
 *  for unchanged items: focus, animations, scroll position survive. */
export function List<T>(props: {
  each: Signal<T[]> | (() => T[]);
  /** JSX expects a function child. Either a single `(item, i) => string`
   *  passed via `children`, or `props.render` if you prefer the explicit
   *  prop. The two are aliases. */
  children?: (item: T, i: number) => string;
  render?: (item: T, i: number) => string;
  /** Stable identity per item. Recommended for non-trivial lists. */
  key?: (item: T, i: number) => string | number;
}): string {
  const ctx = getRenderContext();
  const id = ctx.nextMarker++;
  const renderFn = props.render ?? props.children;
  if (typeof renderFn !== "function") {
    throw new Error("[signals] <List> requires a function child or `render` prop");
  }
  const arr = (typeof props.each === "function"
    ? (props.each as () => T[])()
    : props.each.peek()) as T[];

  if (ctx.mode === "client") {
    ctx.bindings.push({
      type: "list",
      markerId: id,
      reactive: props.each as Reactive<unknown[]>,
      render: renderFn as (item: any, i: number) => string,
      key: props.key as ((item: any, i: number) => string | number) | undefined,
    });
  }

  let inner = "";
  if (props.key) {
    // Keyed: each item renders in a fresh subcontext so its
    // data-bs-* IDs are local. Wrap with per-item markers using the
    // sanitized key.
    for (let i = 0; i < arr.length; i++) {
      const k = sanitizeKey(props.key(arr[i], i));
      const sub = createRenderContext(ctx.mode);
      setRenderContext(sub);
      let itemHtml: string;
      try {
        const out = renderFn(arr[i], i);
        itemHtml = typeof out === "string" ? out : String(out ?? "");
      } finally {
        setRenderContext(ctx);
      }
      inner += `<!--bsI${id}:${k}-->${itemHtml}<!--/bsI${id}:${k}-->`;
    }
  } else {
    // Unkeyed — render in shared parent ctx (current MVP behavior).
    for (let i = 0; i < arr.length; i++) {
      const out = renderFn(arr[i], i);
      inner += typeof out === "string" ? out : String(out ?? "");
    }
  }
  return `<!--bsList${id}-->${inner}<!--/bsList${id}-->`;
}

/** HTML comments forbid `--` and `>` inside the body, so the safe
 *  charset for embedded keys is `[A-Za-z0-9_:.]`. Anything else
 *  (including `-`) is replaced with `_`. Keys are user-provided so
 *  they could be hostile — sanitization is authoritative; the
 *  hydrator trusts whatever sanitizeKey emits. */
function sanitizeKey(k: string | number): string {
  const s = String(k);
  return s.replace(/[^A-Za-z0-9_:.]/g, "_") || "_";
}

/** Reactive conditional rendering. Server emits whichever branch is
 *  active for the current `when` value, wrapped in show markers; the
 *  client re-renders in a fresh subcontext whenever the condition
 *  flips and swaps the inner DOM (per-render handlers + bindings are
 *  scoped to that render and disposed when the branch flips again).
 *
 *  Usage:
 *    <Show when={loading}>
 *      {() => <Skeleton />}
 *    </Show>
 *
 *    <Show when={() => !loading.value && data.value} fallback={() => <div>Empty</div>}>
 *      {() => <Body data={data.value} />}
 *    </Show>
 *
 *  Why a function child instead of plain JSX: the body's render needs
 *  to run again on the client after the condition changes — passing
 *  a thunk lets us defer evaluation. The thunk runs in a fresh signals
 *  render context so its own JSX is markered too (nested signals work
 *  inside <Show>). */
export function Show(props: {
  when: Reactive<unknown>;
  /** Active branch render. Either a function child or `props.body`. */
  children?: () => string;
  body?: () => string;
  /** Optional render for the falsy branch. Defaults to empty string. */
  fallback?: () => string;
}): string {
  const ctx = getRenderContext();
  const id = ctx.nextMarker++;
  const body = props.body ?? props.children;
  if (typeof body !== "function") {
    throw new Error("[signals] <Show> requires a function child or `body` prop");
  }
  const cur = readReactive(props.when);
  const active = !!cur;
  const renderFn = active ? body : (props.fallback ?? (() => ""));

  if (ctx.mode === "client") {
    ctx.bindings.push({
      type: "show",
      markerId: id,
      when: props.when,
      body,
      fallback: props.fallback,
    });
  }

  // Render the active branch in a *sub*-context so its handler / binding
  // IDs don't collide with siblings on either side. The subcontext is
  // discarded on the server (we only need the HTML); on the client the
  // hydrator replays the same subcontext on each branch change.
  const sub = createRenderContext(ctx.mode);
  setRenderContext(sub);
  let inner = "";
  try {
    const out = renderFn();
    inner = typeof out === "string" ? out : String(out ?? "");
  } finally {
    setRenderContext(ctx);
  }
  return `<!--bsShow${id}-->${inner}<!--/bsShow${id}-->`;
}

/** Switch + Match: ergonomic alternative to chained <Show>. The first
 *  Match whose `when` is truthy renders its body; if none match, the
 *  fallback (if any) renders. Implemented as a single `show` binding
 *  with a multi-branch body fn so the runtime stays minimal.
 *
 *  Usage:
 *    <Switch fallback={() => <Empty />}>
 *      <Match when={loading}>{() => <Skeleton />}</Match>
 *      <Match when={error}>{() => <ErrorView />}</Match>
 *      <Match when={data}>{() => <Body data={data.value} />}</Match>
 *    </Switch>
 *
 *  Match is a thin marker so the JSX layer can collect branches; it
 *  never produces output on its own — Switch unwraps and uses props. */
type MatchProps = { when: Reactive<unknown>; children?: () => string; body?: () => string };
type MatchMarker = { __bextMatch: true; when: Reactive<unknown>; body: () => string };

export function Match(props: MatchProps): MatchMarker {
  const body = props.body ?? props.children;
  if (typeof body !== "function") {
    throw new Error("[signals] <Match> requires a function child or `body` prop");
  }
  return { __bextMatch: true, when: props.when, body };
}

export function Switch(props: {
  children?: MatchMarker | MatchMarker[];
  fallback?: () => string;
}): string {
  const arr = Array.isArray(props.children)
    ? (props.children as MatchMarker[])
    : props.children
    ? [props.children as MatchMarker]
    : [];
  const branches = arr.filter((m) => m && (m as any).__bextMatch);
  // Combine branches into a single function for the underlying Show.
  // The Show binding's `when` reads ALL branch conditions on every
  // change; `body` walks branches in declared order and renders the
  // first truthy one (or fallback).
  const fb = props.fallback;
  const aggregateWhen: () => unknown = () => {
    // Truthy iff some branch (or fallback) would render.
    for (const m of branches) if (readReactive(m.when)) return true;
    return !!fb;
  };
  const aggregateBody = () => {
    for (const m of branches) {
      if (readReactive(m.when)) return m.body();
    }
    return fb ? fb() : "";
  };
  // We always want to render — the "fallback" empty case still needs a
  // marker pair so the hydrator can swap into it later. So treat the
  // condition as "always true" for the marker emission, but pass the
  // multi-branch body that picks the right one each time. To get this,
  // we register a `show`-style binding directly without going through
  // <Show>'s active/fallback split.
  const ctx = getRenderContext();
  const id = ctx.nextMarker++;
  if (ctx.mode === "client") {
    ctx.bindings.push({
      type: "show",
      markerId: id,
      when: aggregateWhen,
      body: aggregateBody,
      fallback: undefined,
    });
  }
  const sub = createRenderContext(ctx.mode);
  setRenderContext(sub);
  let inner = "";
  try { inner = aggregateBody(); } finally { setRenderContext(ctx); }
  return `<!--bsShow${id}-->${inner}<!--/bsShow${id}-->`;
}

/** Fragment: just renders children. */
export function Fragment(props: { children?: any }): string {
  const c = props.children;
  if (c == null) return "";
  const arr = Array.isArray(c) ? c.flat(Infinity) : [c];
  let out = "";
  for (const child of arr) {
    if (child == null || child === false || child === true) continue;
    if (typeof child === "string") { out += child; continue; }
    if (typeof child === "number") { out += String(child); continue; }
    if (isReactive(child)) {
      const ctx = getRenderContext();
      const id = ctx.nextMarker++;
      const initial = readReactive(child);
      if (ctx.mode === "client") {
        ctx.bindings.push({ type: "text", markerId: id, reactive: child });
      }
      const text = initial == null ? "" : escapeHtml(String(initial));
      out += `<!--bs${id}-->${text}<!--/bs${id}-->`;
      continue;
    }
    out += escapeHtml(String(child));
  }
  return out;
}

// ── Automatic JSX runtime exports ──────────────────────────────────────

function _jsx(tag: any, props: any, _key?: any): string {
  const { children, ...rest } = props || {};
  if (children != null) {
    if (Array.isArray(children)) return h(tag, rest, ...children);
    return h(tag, rest, children);
  }
  return h(tag, rest);
}

export { _jsx as jsx, _jsx as jsxs, _jsx as jsxDEV };
