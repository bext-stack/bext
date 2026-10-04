import type {
  BextRequest,
  BextResponse,
  SiteConfig,
  RouteContext,
  RenderContext,
  Page,
} from "./types";
import { html, cached } from "./response";
import { robotsTxt, sitemapXml } from "./seo";

/**
 * Wire up a bext template site. Call this in your `server/entry.ts`:
 *
 * ```ts
 * import { createSite } from "@bext-stack/framework/entry";
 * import * as pages from "./pages";
 * import * as template from "./template";
 *
 * createSite({ pages, template, hostname: "my-site.bext.dev" });
 * ```
 *
 * This registers `globalThis.__fetch` which bext's JSC pool calls for every request.
 */
export function createSite(config: SiteConfig): void {
  if (config.init) config.init();

  const seo = config.seo === false ? null : (config.seo ?? { hostname: config.hostname });

  (globalThis as any).__fetch = function (requestJson: string): string {
    const req: BextRequest = JSON.parse(requestJson);
    let path = req.pathname;
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    const authHtml = config.authHtml?.(req.auth_user) ?? "";

    // SEO routes
    if (seo) {
      if (path === "/robots.txt") return serialize(robotsTxt(seo));
      if (path === "/sitemap.xml") return serialize(sitemapXml(seo, config.pages));
    }

    // Route context
    let url: URL;
    try {
      url = new URL(req.url || `https://${config.hostname}${path}`);
    } catch {
      url = new URL(`https://${config.hostname}${path}`);
    }

    const ctx: RouteContext = {
      request: req,
      path,
      url,
      user: req.auth_user,
      authHtml,
      query: url.searchParams,
      params: {},
    };

    // File-based router with layouts (preferred)
    if (config.router) {
      const result = config.router.handle(ctx);
      if (result) return serialize(result);
    }

    // Flat route handlers (legacy, first non-null wins)
    if (config.routes) {
      for (const handler of config.routes) {
        const result = handler(ctx);
        if (result) return serialize(result);
      }
    }

    // Static pages
    const page = config.pages?.getPage(path);
    if (page) {
      const renderCtx: RenderContext = { path, authHtml, user: req.auth_user, request: req };
      const body = config.template.renderPage(page, renderCtx);
      const response = html(body);
      if (config.cacheTtlMs) {
        return serialize(cached(response, config.cacheTtlMs, ["page:" + path]));
      }
      return serialize(response);
    }

    // 404
    const notFoundHtml = "<section class='hero'><div class='container'><h1>404</h1><p>Page not found. <a href='/'>Go home</a>.</p></div></section>";
    if (config.template) {
      const notFoundPage: Page = { title: "Not Found", description: "", html: notFoundHtml };
      const renderCtx: RenderContext = { path, authHtml, user: req.auth_user, request: req };
      const body = config.template.renderPage(notFoundPage, renderCtx);
      return serialize({ status: 404, headers: [["content-type", "text/html; charset=utf-8"]], body });
    }
    return serialize({ status: 404, headers: [["content-type", "text/html; charset=utf-8"]], body: notFoundHtml });
  };
}

function serialize(response: BextResponse): string {
  return JSON.stringify(response);
}
