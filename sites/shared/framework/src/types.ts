// ─── Auth ───────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isSuperAdmin: boolean;
}

// ─── Pages ──────────────────────────────────────────────────────────────────

export interface Page {
  title: string;
  description: string;
  html: string;
}

export type PageMap = Record<string, Page>;

export interface PagesModule {
  getPage(path: string): Page | null;
  getPagePaths?(): string[];
}

// ─── Template ───────────────────────────────────────────────────────────────

export interface RenderContext {
  path: string;
  authHtml: string;
  user: AuthUser | null;
  request: BextRequest;
}

export interface TemplateModule {
  renderPage(page: Page, ctx: RenderContext): string;
}

// ─── Request / Response ─────────────────────────────────────────────────────

export interface BextRequest {
  method: string;
  url: string;
  pathname: string;
  headers: [string, string][];
  body: string | null;
  tenant_id: string | null;
  site_id: string | null;
  auth_user: AuthUser | null;
  client_ip: string | null;
  locale: string | null;
  is_bot: boolean;
}

export interface BextResponse {
  status: number;
  headers: [string, string][];
  body: string;
  cache?: CacheHint;
}

export interface CacheHint {
  enabled: boolean;
  ttl_ms?: number;
  swr_ms?: number;
  tags?: string[];
}

// ─── Route Handlers ─────────────────────────────────────────────────────────

export interface RouteContext {
  request: BextRequest;
  path: string;
  url: URL;
  user: AuthUser | null;
  authHtml: string;
  query: URLSearchParams;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => BextResponse | null;

// ─── SEO ────────────────────────────────────────────────────────────────────

export interface SeoConfig {
  hostname: string;
  additionalPaths?: string[];
  disallowPaths?: string[];
}

// ─── Site Configuration ─────────────────────────────────────────────────────

export interface SiteConfig {
  pages?: PagesModule;
  template?: TemplateModule;
  hostname: string;
  /** Flat route handlers (legacy). First non-null wins. */
  routes?: RouteHandler[];
  /** File-based router with layouts (preferred over flat routes). */
  router?: { handle(ctx: RouteContext): BextResponse | null };
  seo?: SeoConfig | false;
  cacheTtlMs?: number;
  authHtml?: (user: AuthUser | null) => string;
  init?: () => void;
}
