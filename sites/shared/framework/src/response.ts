import type { BextResponse, CacheHint } from "./types";

export function json(data: unknown, status = 200): BextResponse {
  return {
    status,
    headers: [["content-type", "application/json; charset=utf-8"]],
    body: JSON.stringify(data),
  };
}

export function html(body: string, status = 200, cache?: CacheHint): BextResponse {
  return {
    status,
    headers: [["content-type", "text/html; charset=utf-8"]],
    body,
    cache,
  };
}

export function text(body: string, status = 200): BextResponse {
  return {
    status,
    headers: [["content-type", "text/plain; charset=utf-8"]],
    body,
  };
}

export function xml(body: string, status = 200): BextResponse {
  return {
    status,
    headers: [["content-type", "application/xml; charset=utf-8"]],
    body,
  };
}

export function redirect(location: string, status: 301 | 302 | 307 | 308 = 302): BextResponse {
  return { status, headers: [["location", location]], body: "" };
}

export function notFound(body = "Not Found"): BextResponse {
  return { status: 404, headers: [["content-type", "text/plain"]], body };
}

export function cached(response: BextResponse, ttlMs: number, tags?: string[]): BextResponse {
  return { ...response, cache: { enabled: true, ttl_ms: ttlMs, tags } };
}
