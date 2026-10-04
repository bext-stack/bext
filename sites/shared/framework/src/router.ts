/**
 * File-based nested router with layout composition for bext.
 *
 * Directory structure → URL routes:
 *
 *   server/routes/
 *     layout.tsx              → Root layout (wraps everything)
 *     page.tsx                → / (homepage)
 *     about/page.tsx          → /about
 *     blog/
 *       layout.tsx            → Blog layout (wraps all /blog/* pages)
 *       page.tsx              → /blog (listing)
 *       [slug]/page.tsx       → /blog/:slug (dynamic)
 *     docs/
 *       [...path]/page.tsx    → /docs/* (catch-all)
 *     (auth)/                 → Route group (no URL impact)
 *       login/page.tsx        → /login
 *       register/page.tsx     → /register
 *     api/
 *       users/route.ts        → /api/users (API handler)
 *       users/[id]/route.ts   → /api/users/:id
 */

import type { BextRequest, BextResponse, RouteContext, AuthUser } from "./types";

// ─── Route Types ────────────────────────────────────────────────────────────

/** A page component receives context and returns HTML. */
export type PageComponent = (ctx: RouteContext) => string;

/** A layout wraps child content. */
export type LayoutComponent = (props: { children: string; ctx: RouteContext }) => string;

/** An API route handler returns a response or null. */
export type ApiHandler = (ctx: RouteContext) => BextResponse | null;

/** A registered route with its matched layouts. */
export interface Route {
  /** URL pattern with :params (e.g., "/blog/:slug") */
  pattern: string;
  /** Segments for matching */
  segments: Segment[];
  /** Page component */
  page?: PageComponent;
  /** API handler (for route.ts files) */
  handler?: ApiHandler;
  /** Layout stack from root to most specific */
  layouts: LayoutComponent[];
  /** Whether this is an API route (no layout wrapping) */
  isApi: boolean;
}

type Segment =
  | { type: "static"; value: string }
  | { type: "param"; name: string }
  | { type: "catchAll"; name: string };

// ─── Router ─────────────────────────────────────────────────────────────────

export class Router {
  private routes: Route[] = [];
  private rootLayout: LayoutComponent | null = null;

  /** Register the root layout (wraps all pages). */
  layout(component: LayoutComponent): this {
    this.rootLayout = component;
    return this;
  }

  /** Register a page route with optional layouts. */
  page(pattern: string, component: PageComponent, layouts: LayoutComponent[] = []): this {
    this.routes.push({
      pattern,
      segments: parsePattern(pattern),
      page: component,
      layouts: this.rootLayout ? [this.rootLayout, ...layouts] : layouts,
      isApi: false,
    });
    return this;
  }

  /** Register an API route (no layout wrapping). */
  api(pattern: string, handler: ApiHandler): this {
    this.routes.push({
      pattern,
      segments: parsePattern(pattern),
      handler,
      layouts: [],
      isApi: true,
    });
    return this;
  }

  /** Match a request path and return the response. */
  handle(ctx: RouteContext): BextResponse | null {
    for (const route of this.routes) {
      const params = matchRoute(route.segments, ctx.path);
      if (params === null) continue;

      // Populate params on context
      const routeCtx: RouteContext = { ...ctx, params };

      // API route — call handler directly
      if (route.isApi && route.handler) {
        return route.handler(routeCtx);
      }

      // Page route — render with layout composition
      if (route.page) {
        let content = route.page(routeCtx);

        // Wrap in layouts (innermost to outermost)
        for (let i = route.layouts.length - 1; i >= 0; i--) {
          content = route.layouts[i]({ children: content, ctx: routeCtx });
        }

        return {
          status: 200,
          headers: [["content-type", "text/html; charset=utf-8"]],
          body: content,
        };
      }
    }

    return null;
  }

  /** Convert this router into a RouteHandler for use with createSite. */
  toHandler(): (ctx: RouteContext) => BextResponse | null {
    return (ctx) => this.handle(ctx);
  }
}

/** Create a new router instance. */
export function createRouter(): Router {
  return new Router();
}

// ─── Pattern Parsing ────────────────────────────────────────────────────────

function parsePattern(pattern: string): Segment[] {
  return pattern
    .split("/")
    .filter(Boolean)
    .map((seg): Segment => {
      if (seg.startsWith("[...") && seg.endsWith("]")) {
        return { type: "catchAll", name: seg.slice(4, -1) };
      }
      if (seg.startsWith("[") && seg.endsWith("]")) {
        return { type: "param", name: seg.slice(1, -1) };
      }
      if (seg.startsWith(":") && seg.endsWith("+")) {
        return { type: "catchAll", name: seg.slice(1, -1) };
      }
      if (seg.startsWith(":")) {
        return { type: "param", name: seg.slice(1) };
      }
      return { type: "static", value: seg };
    });
}

// ─── Route Matching ─────────────────────────────────────────────────────────

function matchRoute(
  segments: Segment[],
  path: string,
): Record<string, string> | null {
  const parts = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];

    if (seg.type === "catchAll") {
      // Catch-all consumes remaining segments
      params[seg.name] = parts.slice(i).join("/");
      return params;
    }

    if (i >= parts.length) return null; // URL too short

    if (seg.type === "static") {
      if (parts[i] !== seg.value) return null;
    } else if (seg.type === "param") {
      params[seg.name] = parts[i];
    }
  }

  // URL must be fully consumed (unless catch-all already matched)
  if (parts.length !== segments.length) return null;

  return params;
}

// ─── File-Based Route Builder ───────────────────────────────────────────────

/**
 * Define routes using a file-system-like structure.
 *
 * ```ts
 * const router = defineRoutes({
 *   layout: RootLayout,
 *   routes: {
 *     "/": { page: HomePage },
 *     "/about": { page: AboutPage },
 *     "/blog": {
 *       layout: BlogLayout,
 *       page: BlogListPage,
 *       children: {
 *         "/[slug]": { page: BlogPostPage },
 *       },
 *     },
 *     "/api/users": { handler: usersHandler },
 *     "/api/users/[id]": { handler: userByIdHandler },
 *   },
 * });
 * ```
 */
export interface RouteTree {
  layout?: LayoutComponent;
  routes: Record<string, RouteNode>;
}

export interface RouteNode {
  /** Page component for this route. */
  page?: PageComponent;
  /** API handler for this route (mutually exclusive with page). */
  handler?: ApiHandler;
  /** Layout that wraps this route and its children. */
  layout?: LayoutComponent;
  /** Child routes. */
  children?: Record<string, RouteNode>;
}

/** Build a Router from a declarative route tree. */
export function defineRoutes(tree: RouteTree): Router {
  const router = createRouter();
  if (tree.layout) router.layout(tree.layout);

  function walk(
    prefix: string,
    node: Record<string, RouteNode>,
    parentLayouts: LayoutComponent[],
  ) {
    for (const [path, route] of Object.entries(node)) {
      const fullPath = prefix + path;
      const layouts = route.layout
        ? [...parentLayouts, route.layout]
        : parentLayouts;

      if (route.handler) {
        router.api(fullPath, route.handler);
      }
      if (route.page) {
        router.page(fullPath, route.page, layouts);
      }
      if (route.children) {
        walk(fullPath, route.children, layouts);
      }
    }
  }

  walk("", tree.routes, []);
  return router;
}
