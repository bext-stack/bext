/**
 * next/router compatibility shim for PRISM.
 *
 * This is the Pages Router version (older API). Most App Router apps
 * use next/navigation instead, but shared components may still
 * import from next/router.
 *
 * Provides useRouter() that maps to PRISM's navigation.
 */

"use client";

import { useRouter as useAppRouter, usePathname, useSearchParams } from "./navigation";

export function useRouter() {
  const router = useAppRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return {
    pathname,
    query: Object.fromEntries(searchParams.entries()),
    asPath: pathname + (searchParams.toString() ? "?" + searchParams.toString() : ""),
    push: router.push,
    replace: router.replace,
    back: router.back,
    reload: router.refresh,
    isReady: true,
    events: { on() {}, off() {}, emit() {} },
    isFallback: false,
    basePath: "",
    locale: undefined,
    locales: undefined,
    defaultLocale: undefined,
  };
}

export default { useRouter };
