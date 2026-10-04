/**
 * next/headers compatibility shim for PRISM.
 *
 * Provides cookies() and headers() for server components.
 * These read from a request context set during SSR.
 *
 * Note: In PRISM, prefer using getServerData({ request }) which
 * gives direct access to cookies and headers. These shims exist
 * for Next.js compatibility only.
 */

// Server-side request context (set during SSR)
let _requestContext: { headers: Record<string, string>; cookies: Record<string, string> } | null = null;

/** Set the request context for the current render. Called by PRISM's SSR pipeline. */
export function _setRequestContext(ctx: { headers: Record<string, string>; cookies: Record<string, string> } | null) {
  _requestContext = ctx;
}

/** Read-only headers map (Next.js compatible). */
export function headers(): ReadonlyMap<string, string> {
  const h = _requestContext?.headers ?? {};
  return new Map(Object.entries(h));
}

/** Read-only cookies map (Next.js compatible). */
export function cookies() {
  const c = _requestContext?.cookies ?? {};
  return {
    get(name: string) {
      const value = c[name];
      return value !== undefined ? { name, value } : undefined;
    },
    getAll() {
      return Object.entries(c).map(([name, value]) => ({ name, value }));
    },
    has(name: string) {
      return name in c;
    },
    // set/delete are not supported in server components (read-only)
    set() { throw new Error("cookies().set() is not available in Server Components"); },
    delete() { throw new Error("cookies().delete() is not available in Server Components"); },
  };
}
