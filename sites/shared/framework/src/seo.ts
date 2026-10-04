import type { BextResponse, PagesModule, SeoConfig } from "./types";
import { text, xml } from "./response";

export function robotsTxt(config: SeoConfig): BextResponse {
  const lines = ["User-agent: *", "Allow: /"];
  for (const p of config.disallowPaths ?? []) lines.push(`Disallow: ${p}`);
  lines.push(`Sitemap: https://${config.hostname}/sitemap.xml`);
  lines.push("");
  return text(lines.join("\n"));
}

export function sitemapXml(config: SeoConfig, pages: PagesModule): BextResponse {
  const paths = [...(pages.getPagePaths?.() ?? []), ...(config.additionalPaths ?? [])];
  const now = new Date().toISOString().split("T")[0];
  const urls = paths
    .map((p) => `  <url><loc>https://${config.hostname}${p}</loc><lastmod>${now}</lastmod></url>`)
    .join("\n");
  return xml(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`,
  );
}
