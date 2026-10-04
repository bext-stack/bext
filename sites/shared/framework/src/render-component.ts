// `renderToString` — a documented one-liner for the
// `collect(asAsyncIterable(Component(props)))` idiom (T1.2 — additive).
//
// Today that idiom lives buried in test scaffolding (`form.test.ts`). This
// promotes it to a first-class, awaited helper: invoke a component, coerce its
// result (string | Promise | AsyncIterable | array | …) into a string stream,
// and drain it to the final HTML string. Substrate for the T3 test/preview
// harness + snapshot testing. Reuses the existing `asAsyncIterable` + `collect`
// from `./jsx` — no new render machinery.

import { asAsyncIterable, collect } from "./jsx";
import type { Renderable } from "./jsx";

/**
 * Render a component to its final HTML string, awaiting async + streaming
 * output. Equivalent to `collect(asAsyncIterable(Component(props)))`.
 *
 *   const html = await renderToString(Card, { title: "Hi" });
 *
 * Works for sync, async, and async-generator (streaming) components alike —
 * the result is fully buffered, so use this for tests / previews / non-
 * streaming contexts, not the hot streaming response path.
 *
 * The result still carries the framework's `\x01` safe-HTML sentinels (the
 * response sink strips them on the wire); strip them yourself via
 * `stripSentinel` from `./jsx` if you need a sentinel-free string for an
 * assertion.
 */
export async function renderToString<P = {}>(
  Component: (props: P) => Renderable,
  props?: P,
): Promise<string> {
  return collect(asAsyncIterable(Component((props ?? {}) as P)));
}
