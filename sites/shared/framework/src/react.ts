/**
 * React SSR adapter for bext.
 *
 * Wraps React's synchronous `renderToString` for use inside bext's JSC pool.
 * Use this to render React components alongside bext's built-in JSX.
 *
 * ```tsx
 * import { renderReact } from "@bext-stack/framework/react";
 * import { MyChart } from "./components/Chart"; // React component
 *
 * // In a bext template:
 * <div dangerouslySetInnerHTML={{ __html: renderReact(MyChart, { data: [1,2,3] }) }} />
 * ```
 */

// These imports are resolved at bundle time by Bun.
// Sites using @bext-stack/framework/react must have react and react-dom in their dependencies.
import { renderToString as _rts } from "react-dom/server";
import { createElement as _ce } from "react";

/**
 * Render a React component to an HTML string (synchronous).
 *
 * @param component — React component function or class
 * @param props — Props to pass to the component
 * @returns HTML string
 */
export function renderReact(component: any, props?: Record<string, any>): string {
  const element = _ce(component, props ?? {});
  return _rts(element);
}

/**
 * Render a React element (already created with React.createElement or JSX) to string.
 */
export function renderReactElement(element: any): string {
  return _rts(element);
}
