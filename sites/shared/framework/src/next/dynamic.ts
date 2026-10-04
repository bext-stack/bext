/**
 * next/dynamic compatibility shim for PRISM.
 *
 * Provides a basic dynamic() that lazily loads components.
 * In PRISM, this just imports the component — code splitting
 * is handled by Bun.build's splitting feature automatically.
 */

import React, { lazy, Suspense } from "react";

interface DynamicOptions {
  loading?: () => React.ReactElement;
  ssr?: boolean;
}

export default function dynamic<T extends React.ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  options?: DynamicOptions,
) {
  const LazyComponent = lazy(importFn);

  const DynamicComponent = (props: React.ComponentPropsWithRef<T>) => {
    const fallback = options?.loading ? options.loading() : null;
    return React.createElement(Suspense, { fallback }, React.createElement(LazyComponent, props));
  };

  DynamicComponent.displayName = "Dynamic";
  return DynamicComponent;
}
