// Server-side render for "use signals" components.
//
// renderSignalsToString(Component, props) → { html, propsJson }
//
// The HTML is whatever the component returned, with resumability
// markers already embedded by the JSX adapter (see ./jsx.ts).
// The propsJson is what we hand to the client to re-instantiate the
// component — same Component(props) call yields the same signals +
// handlers + counters, so the client's bindings line up with the
// server's markers.
//
// Resumability: we DON'T serialize signal values. The component runs
// again on the client with the same initial state, and the hydrator
// attaches the fresh signals/handlers to the existing DOM. The user
// only paid the render cost once on the server; the client just
// rebuilds the reactive graph (cheap) and binds — no virtual DOM
// reconciliation, no double render of the markup.

import { createRenderContext, setRenderContext } from "./jsx";

export interface SignalsRenderResult {
  /** HTML produced by the component, with `<!--bsN-->` and
   *  `data-bs-*` markers already embedded. */
  html: string;
  /** JSON-serialized props to embed alongside the island. */
  propsJson: string;
  /** Number of bindings allocated — useful for debug / smoke. */
  markerCount: number;
  /** Number of handlers allocated. */
  handlerCount: number;
}

/** Render a "use signals" component to an HTML string. The component
 *  must return a string from its JSX (the signals JSX adapter does
 *  this — every h() call returns a string). Async / streaming is
 *  intentionally not supported here yet; signals islands are
 *  synchronous render units. Async data should sit above the island
 *  in a regular bext component (which can be Suspense-streamed). */
export function renderSignalsToString(
  Component: (props: any) => string,
  props: any = {},
): SignalsRenderResult {
  const ctx = createRenderContext("server");
  setRenderContext(ctx);
  let html: string;
  try {
    const out = Component(props);
    html = typeof out === "string" ? out : String(out ?? "");
  } finally {
    setRenderContext(null);
  }
  return {
    html,
    propsJson: JSON.stringify(props ?? {}),
    markerCount: ctx.nextMarker,
    handlerCount: ctx.nextHandler,
  };
}

/** Wrap a rendered island in the standard host element + props
 *  payload. The hydrator finds these by selector. */
export function wrapSignalsIsland(
  componentName: string,
  result: SignalsRenderResult,
  opts?: { lazy?: "visible" | "idle" | "interaction" },
): string {
  // Single-quoted JSON with `'` and `<` escaped so it's safe inside
  // an attribute and inside a `<script>` (no `</script>` ambiguity).
  const safeProps = result.propsJson
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "\\u003c");
  // Lazy hydration (opt-in): the signals-island browser loader reads `data-lazy`
  // and defers the mount (visible/idle/interaction) off the critical path.
  // Absent → eager (unchanged). The practical slice of resumability.
  const lazyAttr =
    opts?.lazy === "visible" || opts?.lazy === "idle" || opts?.lazy === "interaction"
      ? ` data-lazy="${opts.lazy}"`
      : "";
  // Sentinel-prefixed (\x01) so a bare `{signalsIsland(...)}` child is passed
  // through under auto-escaping; the response sink strips it.
  return (
    `\x01<bext-island data-component="${componentName}" data-runtime="signals" ` +
    `data-props='${safeProps}'${lazyAttr}>${result.html}</bext-island>`
  );
}
