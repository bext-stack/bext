/**
 * next/link compatibility shim for PRISM.
 *
 * Renders a standard <a> tag. PRISM's client navigation runtime
 * handles SPA navigation automatically for all <a> tags on the page —
 * no special Link component needed. Prefetch on hover is built-in.
 *
 * Supports the same props as next/link:
 *   <Link href="/about">About</Link>
 *   <Link href="/blog/[slug]" as="/blog/hello">Hello</Link>
 *   <Link href={{ pathname: "/search", query: { q: "bext" } }}>Search</Link>
 */

import React from "react";

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string | { pathname: string; query?: Record<string, string> };
  as?: string;
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
  children: React.ReactNode;
}

function Link({ href, as, prefetch, replace, scroll, children, ...rest }: LinkProps) {
  let resolvedHref: string;
  if (typeof href === "object") {
    const params = href.query ? "?" + new URLSearchParams(href.query).toString() : "";
    resolvedHref = href.pathname + params;
  } else {
    resolvedHref = as || href;
  }

  return React.createElement("a", { href: resolvedHref, ...rest }, children);
}

export default Link;
export { Link };

/** Next.js 15 useLinkStatus hook stub. */
export function useLinkStatus(): { pending: boolean } {
  return { pending: false };
}
