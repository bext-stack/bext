// Object storage — typed wrapper around bext's `__storagePresign` and
// `__storagePublicUrl` host functions. Backed by the `[storage]` section
// of bext.config.toml; supports S3, R2, MinIO. Body bytes never traverse
// the V8 ↔ host boundary — this module mints URLs, then real I/O goes
// over the regular async `fetch()` (which routes through `__httpFetch`).

import "./bridge";

export type PresignMethod = "GET" | "PUT" | "DELETE" | "HEAD";

export interface PresignOptions {
  method: PresignMethod;
  key: string;
  /** Default 900 (15 min). Cap is 7 days. */
  ttlSecs?: number;
  /** Bound into the signature for PUT only. The uploader MUST send the
   *  exact same Content-Type or the upload is rejected. */
  contentType?: string;
}

/** Mint a presigned URL for the configured object store.
 *  Throws when no [storage] provider is configured. */
export function presign(opts: PresignOptions): string {
  return __storagePresign(opts.method, opts.key, opts.ttlSecs, opts.contentType);
}

export function presignGet(key: string, ttlSecs?: number): string {
  return __storagePresign("GET", key, ttlSecs);
}

export function presignPut(
  key: string,
  opts?: { ttlSecs?: number; contentType?: string },
): string {
  return __storagePresign("PUT", key, opts?.ttlSecs, opts?.contentType);
}

export function presignDelete(key: string, ttlSecs?: number): string {
  return __storagePresign("DELETE", key, ttlSecs);
}

export function presignHead(key: string, ttlSecs?: number): string {
  return __storagePresign("HEAD", key, ttlSecs);
}

/** Public URL for a key, or null when the configured backend has no
 *  public URL convention (local filesystem, missing config). The URL
 *  is only reachable when the bucket / object policy allows it. */
export function publicUrl(key: string): string | null {
  return __storagePublicUrl(key);
}

/** Best-effort: delete an object via a short-lived presigned URL.
 *  Server-side; works inside V8 (over __httpFetch) and in Bun/Node. */
export async function deleteObject(key: string, ttlSecs = 60): Promise<void> {
  const url = presignDelete(key, ttlSecs);
  const r = await fetch(url, { method: "DELETE" });
  if (!r.ok && r.status !== 404) {
    throw new Error(`storage.deleteObject: ${r.status}`);
  }
}

export interface HeadResult {
  size: number;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
}

/** HEAD an object; returns null when it does not exist. */
export async function head(
  key: string,
  ttlSecs = 60,
): Promise<HeadResult | null> {
  const url = presignHead(key, ttlSecs);
  const r = await fetch(url, { method: "HEAD" });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(`storage.head: ${r.status}`);
  }
  const len = r.headers.get("content-length");
  return {
    size: len ? parseInt(len, 10) : 0,
    contentType: r.headers.get("content-type") ?? "application/octet-stream",
    etag: r.headers.get("etag"),
    lastModified: r.headers.get("last-modified"),
  };
}

/** Browser-side: PUT a File or Blob directly to a presigned URL the
 *  server already minted. Use `presignPut` server-side, ship the URL
 *  to the client, then call this. The browser → S3 path bypasses
 *  bext entirely; bytes never enter V8 or actix. */
export async function uploadDirect(
  presignedPutUrl: string,
  body: Blob | ArrayBuffer | Uint8Array,
  contentType?: string,
): Promise<{ etag: string | null; status: number }> {
  const headers: Record<string, string> = {};
  if (contentType) headers["content-type"] = contentType;
  const r = await fetch(presignedPutUrl, {
    method: "PUT",
    headers,
    body: body as BodyInit,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`storage.uploadDirect: ${r.status} ${text}`);
  }
  return { etag: r.headers.get("etag"), status: r.status };
}
