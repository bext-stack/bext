/**
 * next/navigation compatibility shim for PRISM.
 *
 * Provides useRouter(), usePathname(), useSearchParams(), useParams()
 * for "use client" components.
 *
 * Usage:
 *   import { useRouter, usePathname } from "next/navigation";
 *   const router = useRouter();
 *   router.push("/about");
 */

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

/** Router object matching Next.js API. */
export function useRouter() {
  const push = useCallback((href: string) => {
    window.history.pushState({ scrollY: window.scrollY }, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const replace = useCallback((href: string) => {
    window.history.replaceState({ scrollY: window.scrollY }, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const back = useCallback(() => window.history.back(), []);
  const forward = useCallback(() => window.history.forward(), []);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  const prefetch = useCallback((href: string) => {
    // Trigger browser prefetch
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = href;
    document.head.appendChild(link);
  }, []);

  return useMemo(() => ({ push, replace, back, forward, refresh, prefetch }), [push, replace, back, forward, refresh, prefetch]);
}

/** Returns the current pathname. */
export function usePathname(): string {
  const [pathname, setPathname] = useState(() =>
    typeof window !== "undefined" ? window.location.pathname : "/"
  );

  useEffect(() => {
    const handler = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", handler);
    // Also listen for PRISM SPA navigations
    const observer = new MutationObserver(() => {
      if (window.location.pathname !== pathname) setPathname(window.location.pathname);
    });
    observer.observe(document.querySelector("main") || document.body, { childList: true });
    return () => { window.removeEventListener("popstate", handler); observer.disconnect(); };
  }, [pathname]);

  return pathname;
}

/** Returns the current search params. */
export function useSearchParams(): URLSearchParams {
  const [params, setParams] = useState(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams()
  );

  useEffect(() => {
    const handler = () => setParams(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  return params;
}

/** Returns dynamic route params from __BEXT_DATA__. */
export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  const [params] = useState<T>(() => {
    if (typeof document === "undefined") return {} as T;
    const el = document.getElementById("__BEXT_DATA__");
    if (!el) return {} as T;
    try { return JSON.parse(el.textContent || "{}"); } catch { return {} as T; }
  });
  return params;
}

/** Returns the selected layout segment. Stub — returns empty string. */
export function useSelectedLayoutSegment(): string | null {
  return null;
}

/** Returns all selected layout segments. Stub — returns empty array. */
export function useSelectedLayoutSegments(): string[] {
  return [];
}

// Re-export for Next.js compatibility (from lightweight helpers, not serve.ts)
export { redirect, notFound, revalidatePath, revalidateTag } from "../helpers";
