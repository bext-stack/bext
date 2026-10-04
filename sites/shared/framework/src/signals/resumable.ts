// resumable.ts — Qwik-style RESUMABILITY for "use resumable" islands.
//
// The opposite of hydrate.ts: the client NEVER re-runs the component. The server
// serializes plain-signal VALUES + the list of computed ids + a marker→readSym
// map into the island; the client reconstructs the signals, re-derives the
// computeds from their `__ccomp` formulas, wires the DOM markers with real
// effects that re-evaluate the read's `__rexpr` formula, and lazily resolves a
// handler from the component's lifted `__rh` map ONLY when an event fires.
// Opt-in via the `"use resumable"` directive (a separate compiler path) — zero
// impact on the existing signals/PRISM system.
//
// The compiler (prism_resumable.rs, v2) transforms a component to:
//   const a = __rsig("a", signal(props.a ?? 1));
//   const total = __rcomp("total", computed(() => a.value + b.value));
//   ...onClick={__rhref("Sum@0")}...{__rread("Sum$0", () => a.value)}...{__rread("Sum$2", () => total.value)}
//   export const __resume = {
//     rh:    { "Sum@0": (scope) => { const a = scope.a; return (() => { a.value++; }); } },
//     rexpr: { "Sum$0": (scope) => { const a = scope.a; return (a.value); }, ... },
//     ccomp: { "total": (scope) => { const a = scope.a; const b = scope.b; return (a.value + b.value); } },
//   };
//
// On resume the read symbols (`Sum$N`) index `__rexpr`, the computed ids
// (`total`) index `__ccomp`, and the handler symbols (`Sum@N`) index `__rh` —
// all keyed off one reconstructed `scope`. v2 lets ARBITRARY reactive reads
// (multi-signal `a.value + b.value`, `items.value.length`, conditionals) and
// `computed()` resume reactively, not just single-signal reads.

import { signal, computed, effect, type Signal } from "./core";
import { createRenderContext, setRenderContext, getRenderContext } from "./jsx";

// ── render-time helpers (inserted by the compiler) ──────────────────────

/** Register a PLAIN signal under a stable id so the resumable renderer can
 *  serialize its value and map markers to it. Returns the signal unchanged. */
export function __rsig<T>(id: string, sig: Signal<T>): Signal<T> {
  const ctx = getRenderContext();
  if (ctx && ctx.__sigToId) ctx.__sigToId.set(sig as unknown, id);
  return sig;
}

/** Register a COMPUTED under a stable id. The computed is NOT serialized (it's
 *  re-derived on resume from its `__ccomp` formula); we just record the id so
 *  the serializer can (a) list it under `computeds` and (b) skip it when
 *  emitting plain-signal values. Returns the computed unchanged. */
export function __rcomp<T>(id: string, c: Signal<T>): Signal<T> {
  const ctx = getRenderContext();
  if (ctx) {
    if (!ctx.__computedIds) ctx.__computedIds = new Set();
    ctx.__computedIds.add(id);
    // Map the computed instance to its id too, so any code that walks
    // __sigToId can find it (and so it owns the id over a same-named signal).
    if (ctx.__sigToId) ctx.__sigToId.set(c as unknown, id);
  }
  return c;
}

/** Tag a reactive read thunk with its compiler-minted symbol so the renderer
 *  can map the DOM marker it produces back to the lifted `__rexpr` factory.
 *  Stays callable — the server invokes it for the marker's initial value. */
export function __rread<T>(sym: string, thunk: () => T): () => T {
  (thunk as any).__rsym = sym;
  return thunk;
}

/** A handler reference. The signals `h()` adapter emits it as
 *  `data-bs-on<event>="<sym>"`; the resume runtime resolves it from `__rh`. */
export function __rhref(sym: string): { __rhsym: string } {
  return { __rhsym: sym };
}

// ── serialized resume state ──────────────────────────────────────────────

export interface ResumeState {
  /** plain-signalId → serialized value (computeds are NOT serialized). */
  signals: Record<string, unknown>;
  /** ids of computeds to re-derive on resume from `__ccomp`. */
  computeds: string[];
  /** markerId → read symbol (`Comp$N`), indexing `__rexpr`. */
  markers: Record<string, string>;
  /** props passed to the component (for reference/debug). */
  props: unknown;
}

export interface ResumableRenderResult {
  html: string;
  state: ResumeState;
}

// ── server render (runs the component ONCE, on the server, to serialize) ──

export function renderResumableToString(
  Component: (props: any) => string,
  props: any = {},
): ResumableRenderResult {
  // Run in "client" mode so the JSX adapter records bindings (marker→reactive);
  // __rhref handlers emit symbols, so no closures are stored.
  const ctx = createRenderContext("client");
  ctx.__sigToId = new Map();
  ctx.__computedIds = new Set();
  setRenderContext(ctx);
  let html: string;
  try {
    const out = Component(props);
    html = typeof out === "string" ? out : String(out ?? "");
  } finally {
    setRenderContext(null);
  }

  // Map each text/attr marker to the READ SYMBOL the compiler tagged on its
  // thunk (`__rread`). On resume that symbol indexes `__rexpr`, so the marker
  // re-evaluates the (possibly multi-signal / computed) read formula.
  const markers: Record<string, string> = {};
  for (const b of ctx.bindings as Array<{ type: string; markerId: number; reactive: unknown }>) {
    if (b.type !== "text" && b.type !== "attr") continue; // text + attr bindings
    const r = b.reactive as { __rsym?: string } | undefined;
    const sym = r != null ? r.__rsym : undefined;
    if (sym != null) markers[String(b.markerId)] = sym;
  }

  // Serialize PLAIN-signal values by id — computeds are skipped (re-derived on
  // resume from their `__ccomp` formula).
  const computedIds = ctx.__computedIds!;
  const signals: Record<string, unknown> = {};
  const computeds: string[] = [];
  for (const [sig, id] of ctx.__sigToId!) {
    if (computedIds.has(id)) {
      computeds.push(id);
      continue;
    }
    signals[id] = (sig as { peek(): unknown }).peek();
  }

  return { html, state: { signals, computeds, markers, props } };
}

/** Wrap a resumable island in its host element + serialized state container.
 *  When `lazy` is set, the island is tagged `data-resume-lazy` so the loader
 *  DEFERS the bundle download until the first interaction, then replays the
 *  event — zero island JS is downloaded on page load (true resumability). */
export function wrapResumableIsland(
  componentName: string,
  r: ResumableRenderResult,
  lazy = false,
): string {
  const state = JSON.stringify(r.state).replace(/</g, "\\u003c");
  const lazyAttr = lazy ? " data-resume-lazy" : "";
  return (
    `\x01<bext-island data-component="${componentName}" data-runtime="resumable"${lazyAttr}>` +
    `<script type="application/bext-resume">${state}</script>` +
    r.html +
    `</bext-island>`
  );
}

// ── client resume (the component is NEVER re-run) ────────────────────────

/** Scope visible to every lifted factory: reconstructed plain signals +
 *  re-derived computeds, keyed by their stable id. */
type Scope = Record<string, Signal<unknown>>;

/** The component's combined lifted-factory object, emitted by the compiler as
 *  `export const __resume = { rh, rexpr, ccomp }`. The Rust wrapper passes
 *  `module.exports.__resume` here. All optional — a component may have only some
 *  of the three maps. (One object, not three exports: tsc-rs only exports the
 *  first `export const` after an `export default function`.) */
export interface ResumeModule {
  rh?: Record<string, (scope: Scope) => (e: Event) => void>;
  rexpr?: Record<string, (scope: Scope) => unknown>;
  ccomp?: Record<string, (scope: Scope) => unknown>;
}

export function resumeIsland(root: HTMLElement, mod: ResumeModule, state: ResumeState): void {
  // 1. reconstruct plain signals from serialized values.
  const scope: Scope = {};
  for (const id in state.signals) scope[id] = signal(state.signals[id]);

  // 2. re-derive computeds from their `__ccomp` formulas. Lazy — `computed`
  //    only runs the formula on first read, so ordering among computeds (incl.
  //    computed-of-computed) doesn't matter: by read time `scope` is complete.
  const ccomp = mod.ccomp;
  for (const id of state.computeds ?? []) {
    const formula = ccomp?.[id];
    if (formula) scope[id] = computed(() => formula(scope)) as Signal<unknown>;
  }

  // 3. wire DOM markers with real effects that re-evaluate the read formula —
  //    no component re-run. The marker's value is `mod.rexpr[readSym](scope)`.
  const rexpr = mod.rexpr;
  for (const markerId in state.markers) {
    const readSym = state.markers[markerId];
    const read = rexpr?.[readSym];
    if (!read) continue;

    const range = findTextRange(root, markerId);
    if (range) {
      let n: Node | null = range.open.nextSibling;
      while (n && n !== range.close) {
        const next: Node | null = n.nextSibling;
        n.parentNode?.removeChild(n);
        n = next;
      }
      const tn = document.createTextNode("");
      range.close.parentNode?.insertBefore(tn, range.close);
      effect(() => {
        const v = read(scope);
        tn.data = v == null ? "" : String(v);
      });
      continue;
    }

    const el = root.querySelector(`[data-bs-attr${markerId}]`) as HTMLElement | null;
    if (el) {
      const name = el.getAttribute(`data-bs-attr${markerId}`) || "";
      el.removeAttribute(`data-bs-attr${markerId}`);
      effect(() => {
        const v = read(scope);
        if (v == null || v === false) el.removeAttribute(name);
        else if (v === true) el.setAttribute(name, "");
        else el.setAttribute(name, String(v));
      });
    }
  }

  // 4. install handlers by symbol — only the clicked handler ever runs.
  // (getElementsByTagName avoids the CSS-selector parser — faster + portable.)
  const rh = mod.rh;
  for (const el of Array.from(root.getElementsByTagName("*")) as HTMLElement[]) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith("data-bs-on")) continue;
      const event = attr.name.slice("data-bs-on".length);
      const sym = attr.value;
      el.removeAttribute(attr.name);
      const factory = rh?.[sym];
      if (factory) {
        const handler = factory(scope);
        el.addEventListener(event, (e) => {
          try {
            handler(e);
          } catch (err) {
            console.error("[resumable] handler", sym, err);
          }
        });
      }
    }
  }
}

/** Minimal `<!--bsN-->…<!--/bsN-->` range finder (v1: flat text markers). */
function findTextRange(root: Node, markerId: string): { open: Comment; close: Comment } | null {
  const openText = `bs${markerId}`;
  const closeText = `/bs${markerId}`;
  let open: Comment | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const c = node as Comment;
    if (c.data === openText) open = c;
    else if (c.data === closeText && open) return { open, close: c };
  }
  return null;
}
