/**
 * next/head compatibility shim for PRISM.
 *
 * In Next.js Pages Router, Head is used to inject elements into <head>.
 * In App Router (what PRISM targets), use export const metadata instead.
 *
 * This shim renders children into a hidden fragment — the metadata
 * convention handles actual <head> injection.
 */

import React from "react";

function Head({ children }: { children?: React.ReactNode }) {
  // In SSR context, we can't inject into <head> from a component.
  // This is a passthrough — use export const metadata for head tags.
  return null;
}

export default Head;
export { Head };
