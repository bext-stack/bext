/**
 * Preact SSR adapter for bext.
 *
 * Wraps Preact's synchronous `renderToString` for use inside bext's JSC pool.
 * Preact is ~3KB — much smaller than React (~7.5MB) with the same JSX API.
 *
 * ```tsx
 * import { renderPreact } from "@bext-stack/framework/preact";
 * import { h } from "preact";
 *
 * function Badge({ text }) { return h("span", { class: "badge" }, text); }
 * const html = renderPreact(h(Badge, { text: "New" }));
 * ```
 *
 * Or with Preact's own JSX (set jsxImportSource to "preact"):
 * ```tsx
 * const html = renderPreact(<Badge text="New" />);
 * ```
 */

import { renderToString } from "preact-render-to-string";
import { h, type VNode } from "preact";

/**
 * Render a Preact VNode to an HTML string (synchronous).
 */
export function renderPreact(vnode: VNode): string {
  return renderToString(vnode);
}

/**
 * Render a Preact component with props to an HTML string.
 *
 * @param component — Preact component function
 * @param props — Props to pass
 */
export function renderPreactComponent(component: any, props?: Record<string, any>): string {
  return renderToString(h(component, props ?? {}));
}

export { h, renderToString };
