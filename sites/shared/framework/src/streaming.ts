// Streaming + Suspense for PRISM.
//
// PRISM's `jsx.ts` already handles async components / Promise children /
// AsyncIterable children. This module adds the missing piece: a
// `<Suspense>` boundary that emits its `fallback` immediately when its
// children would suspend, then streams the resolved real children later
// via an out-of-order template-swap protocol.
//
// ── Wire format ────────────────────────────────────────────────────────
//
//  In-stream order (what bytes the response body emits, top to bottom):
//
//    <bext-suspense data-id="1"><div>Loading…</div></bext-suspense>   ← fallback
//    ...rest of the page...
//    <template data-suspense-real="1">...real children...</template>  ← out-of-order
//    <script>__bextSuspense.swap(1)</script>
//
//  Client-side: `__bextSuspense.swap(id)` is a 5-line inline script
//  injected by the host (or appended to <body> by the renderer). It
//  finds the placeholder, finds the template, replaces the
//  placeholder with the template's contents.
//
// ── Why this works without React ───────────────────────────────────────
//
//  The host iterates the AsyncIterable<string> the page returns, writing
//  each chunk to the HTTP body. A Suspense boundary yields the placeholder
//  shell synchronously (so the page can keep streaming past it), then
//  schedules a continuation on the same iterator that yields the
//  real-content template + swap script when the children resolve.
//
//  No fiber tree, no reconciliation. Just async generators.

import { asAsyncIterable, h, SafeHtml, type Renderable } from "./jsx";

// Module-level counter for unique boundary IDs within a single render.
// Reset by `renderToStream()` for each new request to keep IDs stable.
let _boundaryCounter = 0;
export function _resetSuspenseCounter(): void {
  _boundaryCounter = 0;
}
function nextBoundaryId(): number {
  _boundaryCounter += 1;
  return _boundaryCounter;
}

// Per-render queue of boundaries that suspended. The host's renderer
// drains this after the main shell finishes, yielding each completed
// boundary's <template> + <script>. Module-level (not request-local)
// because PRISM runs one request per V8 isolate context. If we move to
// shared isolates we'll need to pass this through render context instead.
type PendingBoundary = {
  id: number;
  realChildrenIter: AsyncIterable<string>;
};
let _pending: PendingBoundary[] = [];
export function _drainPending(): PendingBoundary[] {
  const drained = _pending;
  _pending = [];
  return drained;
}

/** Suspense boundary. Renders `fallback` if `children` would suspend
 *  (i.e. contains a Promise / async component); the real children are
 *  scheduled on the per-render queue and emitted out-of-order via a
 *  `<template>` + a `<script>__bextSuspense.swap(id)</script>` pair. */
export function Suspense(props: { fallback?: Renderable; children?: Renderable }): Renderable {
  const fallback = props.fallback ?? "";
  const children = props.children;

  // Sync fast-path: children resolve synchronously → render inline,
  // no boundary needed. Detect by checking whether every reachable
  // child is a sync leaf — if so, h() of children would return a
  // string. We piggy-back on that: try to render children sync first.
  // The cheap approximation: if children is already a string/number/
  // sync-only thing, skip the boundary.
  if (children == null) return "";
  if (typeof children === "string") return children;
  // Branded sync HTML (h()/Fragment/Raw result) — render inline, no boundary.
  if (children instanceof SafeHtml) return children;
  if (typeof children === "number" || typeof children === "boolean") {
    return String(children);
  }

  // Anything that isn't a primitive may suspend. Materialize the
  // streaming path: emit placeholder, queue real content for later.
  const id = nextBoundaryId();
  const realChildrenIter = asAsyncIterable(children);
  _pending.push({ id, realChildrenIter });

  // Inline placeholder. The fallback is itself rendered through
  // asAsyncIterable so async fallbacks are fine (rare but allowed).
  return (async function* () {
    yield `<bext-suspense data-id="${id}">`;
    for await (const chunk of asAsyncIterable(fallback)) yield chunk;
    yield `</bext-suspense>`;
  })();
}

/** Inline client-side runtime that swaps suspense placeholders with
 *  resolved real-content templates as they arrive. ~150 bytes; appended
 *  to the streaming response body once (typically right after the
 *  opening `<body>` so subsequent swap()`s find the function defined). */
export const SUSPENSE_CLIENT_RUNTIME = `<script>window.__bextSuspense={swap:function(id){var p=document.querySelector('bext-suspense[data-id="'+id+'"]'),t=document.querySelector('template[data-suspense-real="'+id+'"]');if(p&&t)p.replaceWith(t.content.cloneNode(true))}};</script>`;

/** Evaluate a component tree ONCE and classify it: a fully-rendered sync
 *  string (the FAST PATH — zero async generators, zero microtasks) or an
 *  AsyncIterable to pump (the slow path — something is async or a Suspense
 *  boundary suspended).
 *
 *  The overwhelmingly common PRISM page (brochure / marketing / WP-replacement)
 *  renders fully synchronously: `composeTree(...)` returns a single `SafeHtml`
 *  string. Driving that string through `renderToStream` (an `async function*`)
 *  + `asAsyncIterable` (another `async function*`) cost ~2 generator
 *  allocations and ~4 microtask round-trips per request to move bytes that were
 *  already built. This classifier lets `runRoute` skip all of it.
 *
 *  Resets the per-render Suspense state, then calls the component a SINGLE
 *  time. Callers MUST consume the returned root and NOT also call the
 *  component again (e.g. via `renderToStream`) — a second invocation would
 *  re-run the page and any side effects. A suspended Suspense yields an
 *  AsyncIterable that bubbles up through `h()`'s async path, so a string /
 *  SafeHtml root already implies `_pending` is empty; the explicit
 *  `_pending.length === 0` guard keeps that correct even if it ever changes. */
export function renderTree(
  Component: (props: any) => Renderable,
  props: any,
): { html: string } | { stream: AsyncIterable<string> } {
  _resetSuspenseCounter();
  _pending = [];
  const root = Component(props);
  if (_pending.length === 0) {
    if (root instanceof SafeHtml) return { html: root.s };
    if (typeof root === "string") return { html: root };
    if (typeof root === "number" || typeof root === "boolean") return { html: String(root) };
    if (root == null) return { html: "" };
  }
  return { stream: streamRoot(root) };
}

/** Buffered convenience: render a tree to a single string, taking the sync
 *  fast path when the whole tree resolved synchronously (no generator, no
 *  per-chunk microtasks). Used by the cold paths (slots, error, not-found). */
export async function collectRender(
  Component: (props: any) => Renderable,
  props: any,
): Promise<string> {
  const r = renderTree(Component, props);
  if ("html" in r) return r.html;
  let out = "";
  for await (const chunk of r.stream) out += chunk;
  return out;
}

/** Render a component to a streaming HTML response.
 *
 *  Yields, in order:
 *    1. The shell — components rendered top-to-bottom; sync subtrees
 *       inline as strings, async subtrees await/iterate as encountered.
 *    2. For each Suspense boundary that suspended, when its real
 *       children resolve: a `<template data-suspense-real="N">` block
 *       containing the rendered children, followed by a
 *       `<script>__bextSuspense.swap(N)</script>` to commit the swap.
 *
 *  Boundaries can resolve in any order; templates are emitted in the
 *  order they finish. The browser's swap is idempotent; out-of-order
 *  resolution is fine.
 *
 *  Back-compat entry: classifies via `renderTree` then streams. New callers
 *  prefer `renderTree` directly (to skip the generator on the sync path) or
 *  `collectRender` (buffered). Iterating this for a sync page still costs the
 *  one outer generator — `renderTree` is how the hot path avoids it.
 *
 *  Usage from the V8 host:
 *    for await (const chunk of renderToStream(Page, props)) {
 *      response.write(chunk);
 *    }
 */
export async function* renderToStream(
  Component: (props: any) => Renderable,
  props: any,
): AsyncIterable<string> {
  const r = renderTree(Component, props);
  if ("html" in r) {
    if (r.html) yield r.html;
    return;
  }
  yield* r.stream;
}

/** Pump an already-evaluated root (plus any Suspense boundaries it queued) to
 *  the wire. Split out of `renderToStream` so `renderTree`'s sync fast path can
 *  evaluate the component exactly once and still share the boundary-drain
 *  tail. */
async function* streamRoot(root: Renderable): AsyncIterable<string> {
  // Shell — stream the (already-evaluated) page tree.
  for await (const chunk of asAsyncIterable(root)) {
    yield chunk;
  }

  // The shell is done. Any pending Suspense boundaries are now in
  // `_pending`. Race their AsyncIterables in parallel and emit each
  // boundary's real-content template+swap the moment it settles —
  // not after the slowest sibling. To identify which entry resolved
  // (vanilla Promise.race only tells you the value), wrap each
  // promise so its resolution carries (id, body, self) where `self`
  // is the promise we want to remove from the in-flight set.
  type Settled = { id: number; body: string; self: Promise<Settled> };
  const inflight = new Set<Promise<Settled>>();
  const start = (b: PendingBoundary): void => {
    let p!: Promise<Settled>;
    p = (async () => {
      let body = "";
      for await (const chunk of b.realChildrenIter) body += chunk;
      return { id: b.id, body, self: p };
    })();
    inflight.add(p);
  };

  for (const b of _drainPending()) start(b);

  while (inflight.size > 0) {
    const { id, body, self } = await Promise.race(inflight);
    inflight.delete(self);
    yield `<template data-suspense-real="${id}">${body}</template>`;
    yield `<script>__bextSuspense.swap(${id})</script>`;
    // Boundaries that suspended inside the resolved one surface here —
    // race them alongside any still in flight.
    for (const b of _drainPending()) start(b);
  }
}

// Re-export the JSX entry so the framework's public surface stays
// in `@bext-stack/framework`. `h` lives in jsx.ts; we re-export here purely
// for ergonomic imports — `import { h, Suspense } from "@bext-stack/framework"`.
export { h };
