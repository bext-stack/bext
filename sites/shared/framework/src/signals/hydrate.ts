// Hydrate a signals island. No virtual DOM, no re-render of the
// initial markup.
//
// Steps:
//   1. Locate the island root (the `<bext-island data-runtime="signals">`).
//   2. Run the component once to allocate fresh signals / handlers /
//      bindings — same call sequence the server made, so IDs line up.
//   3. Walk the existing server-rendered DOM. For each marker:
//        <!--bsN-->...<!--/bsN-->        → text binding (effect updates
//                                          a Text node)
//        data-bs-attrN="<name>"          → attr binding (effect updates
//                                          the attribute)
//        data-bs-on<event>="<id>"        → addEventListener
//        <!--bsListN-->...<!--/bsListN--> → list binding (effect re-renders
//                                          items into the range)
//   4. Marker / data-bs-* attributes are stripped after binding so the
//      DOM ends up clean.
//
// Why run the component twice (server + client): closures aren't
// serializable. The component body builds the reactive graph
// declaratively; running it once on each side is the cheapest way to
// rebuild it. Render of static markup happens only on the server.

import { effect, isSignal, type Signal } from "./core";
import {
  createRenderContext,
  setRenderContext,
  type Binding,
  type Reactive,
  type RenderContext,
} from "./jsx";

export interface MountOptions {
  /** Fail loudly if marker counts don't match — useful in dev. */
  strict?: boolean;
}

export interface MountResult {
  /** Disposes all reactive subscriptions for this island. */
  dispose: () => void;
}

/** Attach reactivity to an island root that was server-rendered with
 *  resumability markers. */
export function hydrateSignalsIsland(
  root: HTMLElement,
  Component: (props: any) => string,
  props: any = {},
  options: MountOptions = {},
): MountResult {
  // Re-run the component to rebuild the reactive graph + bindings list.
  const ctx = createRenderContext("client");
  setRenderContext(ctx);
  try {
    Component(props);
  } finally {
    setRenderContext(null);
  }

  const disposers = attachReactivityWithin(root, ctx, options);

  return {
    dispose() {
      for (const d of disposers) {
        try { d(); } catch (e) { console.error("[signals] dispose threw:", e); }
      }
    },
  };
}

// ── Reusable reactivity attachment ─────────────────────────────────────
//
// Walks `root` for handlers / attr / text / list markers and binds
// each to the matching entry in `ctx`. Used by `hydrateSignalsIsland`
// for the top-level mount AND by list re-renders for newly-spliced
// per-item content. Returns the list of disposers so callers can
// teardown in their own scope.
export function attachReactivityWithin(
  root: HTMLElement,
  ctx: RenderContext,
  options: MountOptions = {},
): Array<() => void> {
  const disposers: Array<() => void> = [];

  // Install keyed list bindings FIRST. Each item renders in a fresh
  // subcontext, so its handler IDs are local — and the server emitted
  // them under per-item subcontexts too. The keyed installer's
  // per-item scoped walk consumes those `data-bs-on*` attributes
  // before the outer global walk below sees them; otherwise the outer
  // walk would (a) attach the wrong handler from `ctx.handlers` and
  // (b) delete the attribute, leaving the keyed walk with nothing.
  // Unkeyed lists keep using the global ctx (handler IDs continuous)
  // so they're handled by the outer walk just like any other element.
  for (const b of ctx.bindings) {
    if (b.type !== "list" || !b.key) continue;
    const range = findMarkerRange(root, `bsList${b.markerId}`, `/bsList${b.markerId}`);
    if (!range || !range.close) {
      if (options.strict) console.warn(`[signals] missing list marker ${b.markerId}`);
      continue;
    }
    disposers.push(installKeyedListBinding(range, b as ListBinding, options));
  }

  // Handlers — walk every element under root, scan dataset for
  // `bsOn<event>` keys.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const ds = el.dataset;
    for (const key of Object.keys(ds)) {
      if (!key.startsWith("bsOn")) continue;
      const eventName = key.slice("bsOn".length).toLowerCase();
      const idStr = ds[key];
      if (idStr == null) continue;
      const id = Number(idStr);
      const fn = ctx.handlers[id];
      if (typeof fn !== "function") {
        if (options.strict) {
          console.warn(`[signals] no handler for ${key}=${idStr}`);
        }
        continue;
      }
      const listener = (e: Event) => fn(e);
      el.addEventListener(eventName, listener);
      disposers.push(() => el.removeEventListener(eventName, listener));
      delete ds[key];
      el.removeAttribute(`data-bs-on${eventName}`);
    }
  }

  // Attribute bindings.
  for (const b of ctx.bindings) {
    if (b.type !== "attr") continue;
    const sel = `[data-bs-attr${b.markerId}]`;
    const el = root.querySelector<HTMLElement>(sel);
    if (!el) {
      if (options.strict) console.warn(`[signals] missing attr placeholder ${sel}`);
      continue;
    }
    const dispose = effect(() => bindAttr(el, b));
    disposers.push(dispose);
    el.removeAttribute(`data-bs-attr${b.markerId}`);
  }

  // Text bindings.
  for (const b of ctx.bindings) {
    if (b.type !== "text") continue;
    const range = findMarkerRange(root, `bs${b.markerId}`, `/bs${b.markerId}`);
    if (!range) {
      if (options.strict) console.warn(`[signals] missing text marker ${b.markerId}`);
      continue;
    }
    const textNode = document.createTextNode("");
    const dispose = effect(() => {
      const v = readReactive(b.reactive);
      textNode.data = v == null ? "" : String(v);
    });
    spliceMarkerRange(range, [textNode]);
    disposers.push(dispose);
  }

  // List bindings — two paths.
  //
  //  Without `key`: full re-render on every change. Initial items
  //  came from the server; on first effect run we leave the DOM as-is
  //  (per-item handlers were attached via the outer ctx walk above).
  //  On subsequent runs we tear down all per-item disposers, re-render
  //  every item in a fresh ctx, and splice the resulting HTML into the
  //  range between the list markers.
  //
  //  With `key`: keyed reconciliation. On first run we walk per-item
  //  marker pairs (`bsI{listId}:{key}`), re-run each item's render in a
  //  fresh ctx, and attach reactivity scoped to that item's DOM range.
  //  We retain a `Map<key, ItemState>`. On subsequent runs we diff:
  //  unchanged keys keep their DOM (and focus / animations / scroll),
  //  removed keys' DOM is dropped + disposers run, new keys render +
  //  insert at the right spot, reordered keys move via insertBefore.
  for (const b of ctx.bindings) {
    if (b.type !== "list") continue;
    if (b.key) continue; // already installed above
    const range = findMarkerRange(root, `bsList${b.markerId}`, `/bsList${b.markerId}`);
    if (!range || !range.close) {
      if (options.strict) console.warn(`[signals] missing list marker ${b.markerId}`);
      continue;
    }
    disposers.push(installUnkeyedListBinding(range, b, options));
  }

  // Show / Switch bindings — reactive subtree swap.
  for (const b of ctx.bindings) {
    if (b.type !== "show") continue;
    const range = findMarkerRange(root, `bsShow${b.markerId}`, `/bsShow${b.markerId}`);
    if (!range || !range.close) {
      if (options.strict) console.warn(`[signals] missing show marker ${b.markerId}`);
      continue;
    }
    disposers.push(installShowBinding(range, b, options));
  }

  return disposers;
}

// ── Internals ──────────────────────────────────────────────────────────

function readReactive(r: Reactive<unknown>): unknown {
  return isSignal(r) ? (r as Signal<unknown>).value : (r as () => unknown)();
}

function bindAttr(el: HTMLElement, b: Binding & { type: "attr" }): void {
  const v = readReactive(b.reactive);
  if (v == null || v === false) {
    el.removeAttribute(b.name);
    return;
  }
  if (v === true) {
    el.setAttribute(b.name, "");
    return;
  }
  if (b.name === "value" && "value" in el) (el as any).value = String(v);
  else if (b.name === "checked" && "checked" in el) (el as any).checked = !!v;
  else el.setAttribute(b.name, String(v));
}

interface MarkerRange { open: Comment; close: Comment | null; }

function findMarkerRange(root: Node, openText: string, closeText: string): MarkerRange | null {
  let open: Comment | null = null;
  let close: Comment | null = null;
  // Depth-balanced match. A <Switch> and a <Show> in its body both emit
  // `<!--bsShow{id}-->` and can collide on the same id (the body renders in a
  // fresh sub-context whose marker counter restarts at 0). Naive "first close
  // after open" then grabs the INNER close, corrupting the swap. Count nesting
  // so we pair the OUTER open with the OUTER close.
  let depth = 0;
  const COMMENT_NODE = 8;
  function visit(n: Node): boolean {
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i] as Node;
      if (c.nodeType === COMMENT_NODE) {
        const data = (c as Comment).data;
        if (data === openText) {
          if (!open) {
            open = c as Comment;
            depth = 1;
          } else {
            depth += 1;
          }
        } else if (data === closeText && open) {
          depth -= 1;
          if (depth === 0) {
            close = c as Comment;
            return true;
          }
        }
      } else if (c.nodeType === 1 /* element */) {
        if (visit(c)) return true;
      }
    }
    return false;
  }
  visit(root);
  if (!open) return null;
  return { open, close };
}

/** Drop the open/close markers and any nodes between them, replacing
 *  with the provided nodes (inserted at the open marker's position). */
function spliceMarkerRange(range: MarkerRange, replacements: Node[]): void {
  const parent = range.open.parentNode!;
  for (const n of replacements) parent.insertBefore(n, range.open);
  let n: Node | null = range.open;
  while (n && n !== range.close) {
    const next: Node | null = n.nextSibling;
    parent.removeChild(n);
    n = next;
  }
  if (range.close) parent.removeChild(range.close);
}

/** Replace nodes between `range.open` and `range.close` (exclusive of
 *  the markers themselves) with the parsed HTML. Markers stay in
 *  place — they're our anchors for future re-renders. */
function replaceRangeWithHtml(range: MarkerRange, html: string): void {
  if (!range.close) return;
  const parent = range.open.parentNode!;
  // Remove existing inner.
  let n: Node | null = range.open.nextSibling;
  while (n && n !== range.close) {
    const next: Node | null = n.nextSibling;
    parent.removeChild(n);
    n = next;
  }
  // Parse + insert. Use a temporary div for browser/linkedom parity.
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  while (tmp.firstChild) {
    parent.insertBefore(tmp.firstChild, range.close);
  }
}

/** Return the nodes currently between `range.open` and `range.close`,
 *  exclusive of the markers themselves. */
function collectScope(range: MarkerRange): Node[] {
  const out: Node[] = [];
  let n: Node | null = range.open.nextSibling;
  while (n && n !== range.close) {
    out.push(n);
    n = n.nextSibling;
  }
  return out;
}

/** Variant of `attachReactivityWithin` that runs over a flat list of
 *  scope nodes (the just-spliced list items). Walks each subtree's
 *  descendants for handlers/markers, mirroring the main hydrator. */
function attachReactivityToNodes(
  scope: Node[],
  ctx: RenderContext,
  options: MountOptions,
): Array<() => void> {
  const disposers: Array<() => void> = [];

  function walkHandlers(n: Node) {
    if (n.nodeType === 1 /* element */) {
      const el = n as HTMLElement;
      const ds = el.dataset;
      for (const key of Object.keys(ds)) {
        if (!key.startsWith("bsOn")) continue;
        const eventName = key.slice("bsOn".length).toLowerCase();
        const idStr = ds[key];
        if (idStr == null) continue;
        const id = Number(idStr);
        const fn = ctx.handlers[id];
        if (typeof fn !== "function") continue;
        const listener = (e: Event) => fn(e);
        el.addEventListener(eventName, listener);
        disposers.push(() => el.removeEventListener(eventName, listener));
        delete ds[key];
        el.removeAttribute(`data-bs-on${eventName}`);
      }
      for (let i = 0; i < el.childNodes.length; i++) {
        walkHandlers(el.childNodes[i] as Node);
      }
    } else if (n.nodeType === 11 /* doc fragment */) {
      for (let i = 0; i < n.childNodes.length; i++) {
        walkHandlers(n.childNodes[i] as Node);
      }
    }
  }
  for (const n of scope) walkHandlers(n);

  // Attr bindings — for each "attr" binding in ctx, find the
  // matching `[data-bs-attrN]` inside any of the scope nodes.
  for (const b of ctx.bindings) {
    if (b.type !== "attr") continue;
    const sel = `[data-bs-attr${b.markerId}]`;
    let el: HTMLElement | null = null;
    for (const n of scope) {
      if (n.nodeType !== 1) continue;
      const root = n as HTMLElement;
      if (root.matches?.(sel)) { el = root; break; }
      const found = root.querySelector?.<HTMLElement>(sel);
      if (found) { el = found; break; }
    }
    if (!el) {
      if (options.strict) console.warn(`[signals] missing attr placeholder ${sel}`);
      continue;
    }
    const dispose = effect(() => bindAttr(el!, b));
    disposers.push(dispose);
    el.removeAttribute(`data-bs-attr${b.markerId}`);
  }

  // Text bindings — find marker pair across the scope nodes.
  for (const b of ctx.bindings) {
    if (b.type !== "text") continue;
    const open = `bs${b.markerId}`;
    const close = `/bs${b.markerId}`;
    const range = findMarkerRangeInScope(scope, open, close);
    if (!range) {
      if (options.strict) console.warn(`[signals] missing text marker ${b.markerId}`);
      continue;
    }
    const textNode = document.createTextNode("");
    const dispose = effect(() => {
      const v = readReactive(b.reactive);
      textNode.data = v == null ? "" : String(v);
    });
    spliceMarkerRange(range, [textNode]);
    disposers.push(dispose);
  }

  // Nested list bindings — find each list's marker range within the
  // scope nodes and install the appropriate (keyed / unkeyed)
  // binding. Disposers are part of the per-item disposer list so the
  // outer item's cleanup cascades into nested lists automatically.
  for (const b of ctx.bindings) {
    if (b.type !== "list") continue;
    const range = findMarkerRangeInScope(
      scope,
      `bsList${b.markerId}`,
      `/bsList${b.markerId}`,
    );
    if (!range || !range.close) {
      if (options.strict) console.warn(`[signals] nested list marker ${b.markerId} missing`);
      continue;
    }
    if (b.key) {
      disposers.push(installKeyedListBinding(range, b as ListBinding, options));
    } else {
      disposers.push(installUnkeyedListBinding(range, b as ListBinding, options));
    }
  }

  return disposers;
}

// ── LIS-based reconciliation helper ────────────────────────────────────

/** Return the indices `i` of `arr` whose values form a Longest
 *  Increasing Subsequence. Indices with value `-1` are skipped (those
 *  represent newly-added items that have no old position).
 *
 *  Standard patience-sort with parent pointers, O(n log n).
 *  Vue 3 / Solid / Inferno all use the same algorithm for keyed-list
 *  reconciliation: items whose old positions form an increasing
 *  subsequence don't need to move; only the rest do.
 *
 *  Exported only for tests — production callers use it via the keyed
 *  list installer below. */
export function longestIncreasingSubsequence(arr: ReadonlyArray<number>): Set<number> {
  const out = new Set<number>();
  if (arr.length === 0) return out;
  // tails[k] = index into `arr` of the smallest tail of an LIS of
  // length k+1 seen so far.
  const tails: number[] = [];
  const prev: number[] = new Array(arr.length).fill(-1);
  for (let i = 0; i < arr.length; i++) {
    const x = arr[i];
    if (x < 0) continue; // new item, not part of any LIS
    // Binary search for first tails[j] whose value >= x.
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[tails[mid]] < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  // Reconstruct via prev pointers from the end of the longest tail.
  let cur = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (cur >= 0) {
    out.add(cur);
    cur = prev[cur];
  }
  return out;
}

// ── List binding installers ────────────────────────────────────────────

interface ListBinding {
  type: "list";
  markerId: number;
  reactive: Reactive<unknown[]>;
  render: (item: any, i: number) => string;
  key?: (item: any, i: number) => string | number;
}

/** Sanitize a key the same way `<List>`'s server-side emitter does so
 *  the hydrator's marker lookups match the comments in the DOM. Mirrors
 *  the regex in `signals/jsx.ts:sanitizeKey`. */
function sanitizeKey(k: string | number): string {
  const s = String(k);
  return s.replace(/[^A-Za-z0-9_:.]/g, "_") || "_";
}

/** Unkeyed list — on signal change, tear down all per-item disposers,
 *  re-render every item in a single fresh ctx, splice into the range. */
/** Install a `<Show>` / `<Switch>` reactive subtree binding. The
 *  initial branch was already rendered by the server; on subsequent
 *  signal changes we re-run the active branch in a fresh subcontext,
 *  splice the resulting HTML between the show markers, walk the new
 *  scope to attach handlers + bindings, and dispose the old subscope.
 *
 *  The first run intentionally short-circuits: the initial DOM is
 *  already there from the server render, and the OUTER hydrate pass
 *  already attached the initial branch's handlers via the global ctx
 *  walk above. We only need to subscribe so subsequent flips re-render. */
function installShowBinding(
  range: MarkerRange,
  b: Binding & { type: "show" },
  options: MountOptions,
): () => void {
  let subDisposers: Array<() => void> = [];
  let firstRun = true;
  let lastHtml: string | null = null;

  const stop = effect(() => {
    // Read `when` (subscribes the effect to it). The body may also
    // subscribe to other signals — for <Switch> the body itself reads
    // each branch's `when`, so signals inside the active branch are
    // tracked here naturally.
    const cur = readReactive(b.when);
    const active = !!cur;
    const renderFn = active ? b.body : (b.fallback ?? (() => ""));

    // First run — initial branch already rendered + initial handlers
    // attached by the outer hydrate walk. Run renderFn once in tracking
    // mode so signals it reads are registered with this effect, but
    // discard the output (the DOM is correct).
    if (firstRun) {
      firstRun = false;
      const probeCtx = createRenderContext("client");
      setRenderContext(probeCtx);
      try {
        lastHtml = renderFn();
      } finally {
        setRenderContext(null);
      }
      return;
    }

    // Re-run the active branch's render. Skip the DOM swap if the HTML
    // didn't change — covers the case where multiple signals nudge
    // `when` but the rendered body is identical.
    const subCtx = createRenderContext("client");
    setRenderContext(subCtx);
    let html = "";
    try {
      const out = renderFn();
      html = typeof out === "string" ? out : String(out ?? "");
    } finally {
      setRenderContext(null);
    }
    if (html === lastHtml) return;
    lastHtml = html;

    // Dispose old subtree's reactivity, splice in the new HTML, and
    // attach reactivity to the new scope.
    for (const d of subDisposers) {
      try { d(); } catch (e) { console.error("[signals] show cleanup threw:", e); }
    }
    subDisposers = [];
    replaceRangeWithHtml(range, html);
    const newScope = collectScope(range);
    subDisposers = attachReactivityToNodes(newScope, subCtx, options);
  });

  return () => {
    stop();
    for (const d of subDisposers) {
      try { d(); } catch {}
    }
  };
}

function installUnkeyedListBinding(
  range: MarkerRange,
  b: ListBinding,
  options: MountOptions,
): () => void {
  let perItemDisposers: Array<() => void> = [];
  let firstRun = true;

  const stop = effect(() => {
    const items = readReactive(b.reactive) as unknown[];
    const arr = Array.isArray(items) ? items : [];
    if (firstRun) {
      // Initial items already in DOM, handlers attached via outer ctx.
      firstRun = false;
      return;
    }
    for (const d of perItemDisposers) {
      try { d(); } catch (e) { console.error("[signals] list cleanup threw:", e); }
    }
    perItemDisposers = [];
    const itemCtx = createRenderContext("client");
    setRenderContext(itemCtx);
    let html = "";
    try {
      for (let i = 0; i < arr.length; i++) {
        const out = b.render(arr[i], i);
        html += typeof out === "string" ? out : String(out ?? "");
      }
    } finally {
      setRenderContext(null);
    }
    replaceRangeWithHtml(range, html);
    const newScope = collectScope(range);
    perItemDisposers = attachReactivityToNodes(newScope, itemCtx, options);
  });

  return () => {
    stop();
    for (const d of perItemDisposers) {
      try { d(); } catch {}
    }
  };
}

/** Keyed list — full reconciliation. Per-item state stored in a Map
 *  so unchanged items keep their DOM across signal updates. */
function installKeyedListBinding(
  range: MarkerRange,
  b: ListBinding,
  options: MountOptions,
): () => void {
  if (!range.close) return () => {};
  const keyFn = b.key!;
  const parent = range.open.parentNode!;

  interface ItemState {
    /** Sanitized key (matches the DOM marker text). */
    key: string;
    /** Open + close marker comments wrapping this item's nodes. */
    range: MarkerRange;
    /** Reactivity disposers for this item only. */
    disposers: Array<() => void>;
  }
  const prevItems = new Map<string, ItemState>();
  /** Order of keys produced by the previous render. Used to compute
   *  old-index per new key so the LIS can skip moves for already-
   *  in-order items. */
  let prevKeyOrder: string[] = [];
  let firstRun = true;

  function disposeItem(state: ItemState): void {
    for (const d of state.disposers) {
      try { d(); } catch (e) { console.error("[signals] item dispose threw:", e); }
    }
    removeRangeInclusive(state.range);
  }

  const stop = effect(() => {
    const items = readReactive(b.reactive) as unknown[];
    const arr = Array.isArray(items) ? items : [];
    const newKeys = arr.map((it, i) => sanitizeKey(keyFn(it, i)));

    if (firstRun) {
      // Walk existing per-item markers in the DOM, populate prevItems.
      for (let i = 0; i < arr.length; i++) {
        const k = newKeys[i];
        const itemRange = findMarkerRangeInRoot(
          range,
          `bsI${b.markerId}:${k}`,
          `/bsI${b.markerId}:${k}`,
        );
        if (!itemRange || !itemRange.close) {
          if (options.strict) console.warn(`[signals] missing item marker ${k}`);
          continue;
        }
        const itemCtx = createRenderContext("client");
        setRenderContext(itemCtx);
        try {
          b.render(arr[i], i);
        } finally {
          setRenderContext(null);
        }
        const scope = collectNodesInRange(itemRange);
        const itemDisposers = attachReactivityToNodes(scope, itemCtx, options);
        prevItems.set(k, { key: k, range: itemRange, disposers: itemDisposers });
      }
      prevKeyOrder = newKeys.slice();
      firstRun = false;
      return;
    }

    // Subsequent runs: keyed diff.
    // 1. Remove items not in newKeys.
    const newSet = new Set(newKeys);
    for (const [k, state] of Array.from(prevItems.entries())) {
      if (!newSet.has(k)) {
        disposeItem(state);
        prevItems.delete(k);
      }
    }

    // 2. Compute the LIS over old positions of new keys. Items whose
    //    old indices form the LIS are already in the right relative
    //    order — they don't need DOM moves. Everything else is
    //    moved/inserted via insertBefore.
    const oldIndexOf = new Map<string, number>();
    for (let i = 0; i < prevKeyOrder.length; i++) {
      oldIndexOf.set(prevKeyOrder[i], i);
    }
    const oldIndices: number[] = newKeys.map((k) =>
      oldIndexOf.has(k) ? (oldIndexOf.get(k) as number) : -1,
    );
    const stable = longestIncreasingSubsequence(oldIndices);

    // Walk newKeys right-to-left, anchoring at the next stable item
    // (or `range.close` initially).
    let anchor: Node = range.close!;
    for (let i = arr.length - 1; i >= 0; i--) {
      const k = newKeys[i];
      const item = arr[i];
      let state = prevItems.get(k);
      if (!state) {
        // New item — render in fresh ctx, parse, insert.
        const itemCtx = createRenderContext("client");
        setRenderContext(itemCtx);
        let inner: string;
        try {
          const out = b.render(item, i);
          inner = typeof out === "string" ? out : String(out ?? "");
        } finally {
          setRenderContext(null);
        }
        const wrapped = `<!--bsI${b.markerId}:${k}-->${inner}<!--/bsI${b.markerId}:${k}-->`;
        const tmp = document.createElement("div");
        tmp.innerHTML = wrapped;
        const inserted: Node[] = [];
        while (tmp.firstChild) {
          const n = tmp.firstChild;
          parent.insertBefore(n, anchor);
          inserted.push(n);
        }
        const itemRange = findMarkerRangeInScope(
          inserted,
          `bsI${b.markerId}:${k}`,
          `/bsI${b.markerId}:${k}`,
        );
        if (!itemRange || !itemRange.close) {
          if (options.strict) console.warn(`[signals] new item ${k} markers missing`);
          continue;
        }
        const scope = collectNodesInRange(itemRange);
        const disposers = attachReactivityToNodes(scope, itemCtx, options);
        state = { key: k, range: itemRange, disposers };
        prevItems.set(k, state);
      } else if (stable.has(i)) {
        // In LIS — already in the right relative position. Skip the
        // insertBefore call entirely. Update the anchor so the next
        // moved item lands immediately before this one.
      } else {
        // Existing but moved — relocate its node range before anchor.
        moveRangeBefore(state.range, anchor);
      }
      anchor = state.range.open;
    }
    prevKeyOrder = newKeys.slice();
  });

  return () => {
    stop();
    for (const state of prevItems.values()) {
      for (const d of state.disposers) {
        try { d(); } catch {}
      }
    }
    prevItems.clear();
  };
}

/** Walk descendants of the list range (between open/close markers,
 *  exclusive) for a specific item-marker pair. */
function findMarkerRangeInRoot(
  listRange: MarkerRange,
  openText: string,
  closeText: string,
): MarkerRange | null {
  let open: Comment | null = null;
  let close: Comment | null = null;
  const COMMENT_NODE = 8;
  function visit(n: Node): boolean {
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i] as Node;
      if (c.nodeType === COMMENT_NODE) {
        const data = (c as Comment).data;
        if (data === openText && !open) {
          open = c as Comment;
        } else if (data === closeText && open) {
          close = c as Comment;
          return true;
        }
      } else if (c.nodeType === 1) {
        if (visit(c)) return true;
      }
    }
    return false;
  }
  // Walk from listRange.open's nextSibling up to listRange.close.
  let n: Node | null = listRange.open.nextSibling;
  while (n && n !== listRange.close) {
    if (n.nodeType === COMMENT_NODE) {
      const data = (n as Comment).data;
      if (data === openText && !open) open = n as Comment;
      else if (data === closeText && open) { close = n as Comment; break; }
    } else if (n.nodeType === 1) {
      if (visit(n)) break;
    }
    n = n.nextSibling;
  }
  if (!open) return null;
  return { open, close };
}

/** Collect nodes between two markers (exclusive of the markers). */
function collectNodesInRange(range: MarkerRange): Node[] {
  const out: Node[] = [];
  let n: Node | null = range.open.nextSibling;
  while (n && n !== range.close) {
    out.push(n);
    n = n.nextSibling;
  }
  return out;
}

/** Move all nodes from `range.open` through `range.close` (inclusive)
 *  to immediately before `anchor`. Existing parent.insertBefore moves
 *  rather than copies, so this is O(nodes) DOM mutations. */
function moveRangeBefore(range: MarkerRange, anchor: Node): void {
  if (!range.close) return;
  const parent = range.open.parentNode!;
  // Collect first to avoid sibling chain races during move.
  const nodes: Node[] = [];
  let n: Node | null = range.open;
  while (n && n !== range.close) {
    nodes.push(n);
    n = n.nextSibling;
  }
  if (range.close) nodes.push(range.close);
  for (const node of nodes) parent.insertBefore(node, anchor);
}

/** Remove all nodes from `range.open` through `range.close`, inclusive. */
function removeRangeInclusive(range: MarkerRange): void {
  const parent = range.open.parentNode;
  if (!parent) return;
  const nodes: Node[] = [];
  let n: Node | null = range.open;
  while (n && n !== range.close) {
    nodes.push(n);
    n = n.nextSibling;
  }
  if (range.close) nodes.push(range.close);
  for (const node of nodes) parent.removeChild(node);
}

function findMarkerRangeInScope(
  scope: Node[],
  openText: string,
  closeText: string,
): MarkerRange | null {
  let open: Comment | null = null;
  let close: Comment | null = null;
  const COMMENT_NODE = 8;
  function visit(n: Node): boolean {
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i] as Node;
      if (c.nodeType === COMMENT_NODE) {
        const data = (c as Comment).data;
        if (data === openText && !open) {
          open = c as Comment;
        } else if (data === closeText && open) {
          close = c as Comment;
          return true;
        }
      } else if (c.nodeType === 1) {
        if (visit(c)) return true;
      }
    }
    return false;
  }
  for (const root of scope) {
    if (root.nodeType === COMMENT_NODE) {
      const data = (root as Comment).data;
      if (data === openText && !open) open = root as Comment;
      else if (data === closeText && open) { close = root as Comment; break; }
    } else {
      if (visit(root)) break;
    }
  }
  if (!open) return null;
  return { open, close };
}
