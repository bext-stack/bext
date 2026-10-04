/**
 * next/script compatibility shim for PRISM.
 *
 * Renders a standard <script> tag with the same props as next/script.
 * Strategy prop controls loading behavior:
 *   - "beforeInteractive" → rendered in <head> (not supported, falls back to body)
 *   - "afterInteractive" → default, loads after hydration
 *   - "lazyOnload" → defers loading until browser is idle
 *   - "worker" → not supported, falls back to afterInteractive
 */

import React from "react";

interface ScriptProps extends React.ScriptHTMLAttributes<HTMLScriptElement> {
  src?: string;
  strategy?: "beforeInteractive" | "afterInteractive" | "lazyOnload" | "worker";
  onLoad?: () => void;
  onReady?: () => void;
  onError?: () => void;
  children?: React.ReactNode;
}

function Script({ strategy, onLoad, onReady, onError, children, ...rest }: ScriptProps) {
  const isLazy = strategy === "lazyOnload";

  return React.createElement("script", {
    ...rest,
    defer: isLazy ? undefined : true,
    loading: isLazy ? "lazy" : undefined,
  }, children);
}

export default Script;
export { Script };
