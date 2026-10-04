// testing.ts — a tiny testing-library for bext signals islands.
//
// Wraps the existing render + hydrate primitives (renderSignalsToString +
// hydrateSignalsIsland) and a happy-dom DOM so you can render a component,
// query it, interact, and assert — without a browser. Import ONLY from test
// files (`@bext-stack/framework/testing`); it pulls in happy-dom, so it is
// deliberately NOT re-exported from the framework index.
//
//   import { render } from "@bext-stack/framework/testing";
//   const { text, getByTestId, click } = render(Counter, { start: 5 });
//   expect(text()).toContain("Count: 5");
//   click(getByTestId("inc"));
//   expect(text()).toContain("Count: 6");
//
// Queries use getElementsByTagName + manual matching (no CSS-selector parser —
// happy-dom's is unreliable). Use `data-testid` to find interactive elements.

import { Window } from "happy-dom";
import { renderSignalsToString, hydrateSignalsIsland } from "./signals";

let _win: unknown;

/** Install happy-dom globals once. Idempotent. */
export function setupDom(): void {
  if (_win) return;
  const win = new Window();
  _win = win;
  const g = globalThis as Record<string, unknown>;
  for (const k of [
    "document", "Node", "NodeFilter", "Event", "CustomEvent",
    "Comment", "Text", "Element", "HTMLElement",
  ]) {
    g[k] = (win as unknown as Record<string, unknown>)[k];
  }
  g.window = win;
  // happy-dom's CSS selector parser reads `this.window.SyntaxError` to throw on
  // a bad selector; in some setups that's undefined and even a VALID selector
  // (e.g. `querySelectorAll("*")` used by the hydrator) blows up. Backfill it.
  const w = win as unknown as Record<string, unknown>;
  if (!w.SyntaxError) w.SyntaxError = SyntaxError;
}

type El = {
  textContent: string | null;
  value?: string;
  getAttribute(n: string): string | null;
  getElementsByTagName(t: string): ArrayLike<El>;
  dispatchEvent(e: unknown): boolean;
  innerHTML: string;
};

export interface RenderResult {
  /** The mounted container element. */
  container: El;
  /** The SSR HTML that was hydrated. */
  html: string;
  /** Trimmed textContent of the whole container — the usual assertion target. */
  text(): string;
  /** Find the deepest element whose text matches (string contains / RegExp test). Throws if none. */
  getByText(match: string | RegExp): El;
  /** All elements whose text matches. */
  getAllByText(match: string | RegExp): El[];
  /** Find an element by its `data-testid`. Throws if none. */
  getByTestId(id: string): El;
  /** All elements with the given tag name. */
  getAllByTag(tag: string): El[];
  /** Dispatch a bubbling click on `el`. */
  click(el: El): void;
  /** Set `el.value` and dispatch a bubbling input event (for inputs). */
  type(el: El, value: string): void;
  /** Dispatch an arbitrary bubbling event by name. */
  fire(el: El, event: string): void;
}

/** Render a "use signals" component, hydrate it in a happy-dom container, and
 *  return query + interaction helpers. */
export function render(Component: (props: any) => string, props: any = {}): RenderResult {
  setupDom();
  const g = globalThis as unknown as { document: { createElement(t: string): El; body: { appendChild(e: El): void } }; Event: new (t: string, o?: unknown) => unknown };
  const { html } = renderSignalsToString(Component, props);
  const container = g.document.createElement("div");
  container.innerHTML = html;
  g.document.body.appendChild(container);
  // Hydrate exactly as the browser wrapper would.
  hydrateSignalsIsland(container as unknown as HTMLElement, Component, props);
  return makeResult(container, html);
}

function makeResult(container: El, html: string): RenderResult {
  const g = globalThis as unknown as { Event: new (t: string, o?: unknown) => unknown };
  const all = (): El[] => Array.from(container.getElementsByTagName("*") as ArrayLike<El>);
  const matches = (m: string | RegExp, s: string) => (m instanceof RegExp ? m.test(s) : s.includes(m));
  // Deepest match = the element with no matching descendant (most specific).
  const findDeep = (m: string | RegExp): El[] => {
    const hits = all().filter((e) => matches(m, (e.textContent ?? "").trim()));
    return hits.filter((e) => {
      const kids = Array.from(e.getElementsByTagName("*") as ArrayLike<El>);
      return !kids.some((k) => matches(m, (k.textContent ?? "").trim()));
    });
  };
  return {
    container,
    html,
    text: () => (container.textContent ?? "").trim().replace(/\s+/g, " "),
    getByText(m) {
      const hit = findDeep(m)[0];
      if (!hit) throw new Error(`getByText: no element matching ${m}`);
      return hit;
    },
    getAllByText: (m) => findDeep(m),
    getByTestId(id) {
      const hit = all().find((e) => e.getAttribute("data-testid") === id);
      if (!hit) throw new Error(`getByTestId: no element with data-testid="${id}"`);
      return hit;
    },
    getAllByTag: (tag) => Array.from(container.getElementsByTagName(tag) as ArrayLike<El>),
    click(el) {
      el.dispatchEvent(new g.Event("click", { bubbles: true }));
    },
    type(el, value) {
      el.value = value;
      el.dispatchEvent(new g.Event("input", { bubbles: true }));
    },
    fire(el, event) {
      el.dispatchEvent(new g.Event(event, { bubbles: true }));
    },
  };
}
