/**
 * PRISM Islands — Partial hydration for React components.
 *
 * Use `<Island>` to mark individual components for client-side hydration
 * while the rest of the page stays as static HTML (zero JS).
 *
 * ```tsx
 * // src/app/page.tsx (server page — NO "use client")
 * import { Island } from "@bext-stack/framework/island-react";
 * import { PricingToggle } from "../components/PricingToggle";
 *
 * export default function Page() {
 *   return (
 *     <div>
 *       <h1>Static heading (no JS)</h1>
 *       <Island component={PricingToggle} name="PricingToggle" plan="monthly" />
 *       <p>More static content (no JS)</p>
 *     </div>
 *   );
 * }
 * ```
 *
 * The component is rendered to HTML during SSR (SEO + instant paint).
 * On the client, only the island is hydrated — not the whole page.
 *
 * Props:
 *   component — The React component to render and hydrate
 *   name      — Unique island name (maps to client bundle)
 *   lazy      — "idle" | "visible" | "eager" (default: "eager")
 *   ...rest   — All other props are passed to the component
 */

import React from "react";

export interface IslandProps {
  /** The React component to render as an island. */
  component: React.ComponentType<any>;
  /** Unique name for this island (used to load the client bundle). */
  name: string;
  /** Loading strategy: "eager" (immediate), "visible" (intersection observer), "idle" (requestIdleCallback). */
  lazy?: "eager" | "visible" | "idle";
  /** All other props are forwarded to the component. */
  [key: string]: any;
}

/**
 * Renders a React component as a partially-hydrated island.
 *
 * During SSR: renders the component to HTML, wrapped in a `<bext-island>` marker.
 * On the client: the island loader hydrates ONLY this subtree, not the whole page.
 */
export function Island({ component: Component, name, lazy, ...props }: IslandProps) {
  // Serialize props for the client (escape < to prevent XSS in JSON)
  const serialized = JSON.stringify(props).replace(/</g, "\\u003c");

  return React.createElement(
    "bext-island",
    {
      "data-component": name,
      "data-props": serialized,
      ...(lazy && lazy !== "eager" ? { "data-lazy": lazy } : {}),
      // SSR: suppress hydration warning since client will take over this subtree
      suppressHydrationWarning: true,
    },
    React.createElement(Component, props),
  );
}

/**
 * Generate the inline island loader script.
 * This ~800 byte script finds all <bext-island> elements and hydrates them.
 *
 * @param manifestJson — JSON string mapping island names to bundle URLs
 */
export function islandLoaderScript(manifestJson: string): string {
  return `<script type="module">
(function(){
  var m=${manifestJson};
  function hydrate(el){
    var n=el.dataset.component,u=m[n];
    if(!u)return;
    import(u).then(function(mod){
      var C=mod.default||mod[n]||Object.values(mod)[0];
      if(!C)return;
      var p=JSON.parse(el.dataset.props||"{}");
      var R=window.__REACT__;
      if(!R){import("/_bext/vendor-react.js").then(function(r){window.__REACT__=r;mount(el,C,p,r)}).catch(console.error);return;}
      mount(el,C,p,R);
    }).catch(console.error);
  }
  function mount(el,C,p,R){
    R.hydrateRoot(el,R.createElement(C,p));
  }
  var islands=document.querySelectorAll("bext-island[data-component]");
  islands.forEach(function(el){
    var lazy=el.dataset.lazy;
    if(lazy==="visible"&&"IntersectionObserver"in window){
      var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){io.disconnect();hydrate(el);}});},{rootMargin:"200px"});
      io.observe(el);
    }else if(lazy==="idle"&&"requestIdleCallback"in window){
      requestIdleCallback(function(){hydrate(el);});
    }else{
      hydrate(el);
    }
  });
})();
</script>`;
}
