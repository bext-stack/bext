/**
 * Solid SSR adapter for bext.
 *
 * Wraps Solid's synchronous `renderToString` for use inside bext's JSC pool.
 *
 * ```tsx
 * import { renderSolid } from "@bext-stack/framework/solid";
 *
 * // Render a Solid component:
 * const html = renderSolid(() => <Counter initial={0} />);
 * ```
 */

let _renderToString: ((fn: () => any, opts?: any) => string) | null = null;

function ensureSolid() {
  if (!_renderToString) {
    try {
      const solidWeb = require("solid-js/web");
      _renderToString = solidWeb.renderToString;
    } catch (e) {
      throw new Error(
        "Solid is not available. Add solid-js to your dependencies " +
        "and ensure it is bundled into the SSR bundle."
      );
    }
  }
}

/**
 * Render a Solid component tree to an HTML string (synchronous).
 *
 * @param fn — Function that returns a Solid component (e.g., `() => <App />`)
 * @returns HTML string
 */
export function renderSolid(fn: () => any): string {
  ensureSolid();
  return _renderToString!(fn);
}
