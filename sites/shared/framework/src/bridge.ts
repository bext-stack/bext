// Typed access to bext's native IO bridge globals.
// These are registered by Rust's JSC bridge (bridge.rs) before bundle evaluation.

declare global {
  /** Read a file's contents as a UTF-8 string. */
  function __readFile(path: string): string;
  /** Check if a file or directory exists. */
  function __readFileExists(path: string): boolean;
  /** List directory contents. Returns JSON array of filenames. */
  function __readDir(path: string): string;
  /** Synchronous HTTP fetch. Returns JSON: { ok, status, body, error? } */
  function __httpFetch(url: string, optsJson?: string): string;
  /** Execute a SQLite query. Returns the result as a native V8 object
   *  ({ rows, columns } or { changes, last_insert_rowid }) since the
   *  `__dbQuery returns native V8 row objects` change; older builds returned
   *  a JSON string. `dbQuery` below tolerates both. */
  function __dbQuery(dbPath: string, sql: string, paramsJson?: string): unknown;
  /** Read an environment variable. Returns null if not set. */
  function __env(key: string): string | null;
  /** Log a message through Rust's tracing system. */
  function __log(level: string, msg: string): void;
  /** Mint a presigned URL for the configured object store.
   *  Throws if no [storage] is configured. Pure CPU (HMAC-SHA256). */
  function __storagePresign(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string,
    ttlSecs?: number,
    contentType?: string,
  ): string;
  /** Public URL for a key on the configured object store, or null. */
  function __storagePublicUrl(key: string): string | null;
  /** Declarative streaming HTML rewrite (lol-html). Returns rewritten HTML. */
  function __htmlRewrite(html: string, rulesJson: string): string;
}

/** One declarative HTML-rewrite rule: a CSS selector + actions for each match. */
export interface HtmlRule {
  selector: string;
  /** `[name, value]` — set/overwrite an attribute (e.g. CSP `nonce`). */
  setAttribute?: [string, string];
  removeAttribute?: string;
  /** `[name, prefix]` — prefix a relative attr value (CDN rewrite). */
  prefixAttribute?: [string, string];
  beforeHtml?: string;
  prependHtml?: string;
  setInnerHtml?: string;
  appendHtml?: string;
  afterHtml?: string;
  remove?: boolean;
}

/** Declarative streaming HTML rewrite via lol-html (CSP nonces, CDN URL
 *  rewrites, fragment injection) — runs natively, no JS per-element callback. */
export function htmlRewrite(html: string, rules: HtmlRule[]): string {
  return __htmlRewrite(html, JSON.stringify(rules));
}

/** Read a file as UTF-8. Throws if file doesn't exist. */
export function readFile(path: string): string {
  return __readFile(path);
}

/** Check if a path exists. */
export function fileExists(path: string): boolean {
  return __readFileExists(path);
}

/** List files in a directory. */
export function readDir(path: string): string[] {
  return JSON.parse(__readDir(path));
}

/** Synchronous HTTP fetch. */
export function httpFetch(
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string; timeout_ms?: number },
): { ok: boolean; status: number; body: string; error?: string } {
  return JSON.parse(__httpFetch(url, opts ? JSON.stringify(opts) : undefined));
}

/** Execute a SQLite query. */
export function dbQuery(
  dbPath: string,
  sql: string,
  params?: unknown[],
): { rows?: Record<string, unknown>[]; columns?: string[]; changes?: number; last_insert_rowid?: number } {
  // Normalise across __dbQuery contracts so every consumer keeps the stable
  // `{ rows, columns, changes, last_insert_rowid }` shape:
  //   • current builds return native V8 values — a row-object ARRAY for SELECT,
  //     or `{ changes, lastInsertRowid }` for a write (no JSON round-trip);
  //   • older builds returned a JSON string of `{ rows, columns, ... }`.
  const raw = __dbQuery(dbPath, sql, params ? JSON.stringify(params) : undefined);
  if (typeof raw === "string") return JSON.parse(raw); // legacy JSON contract
  if (Array.isArray(raw)) {
    const rows = raw as Record<string, unknown>[];
    return { rows, columns: rows.length ? Object.keys(rows[0]) : [] };
  }
  const w = (raw ?? {}) as { changes?: number; lastInsertRowid?: number; last_insert_rowid?: number; rows?: Record<string, unknown>[]; columns?: string[] };
  // A write (native `{ changes, lastInsertRowid }`) — map camelCase → snake_case.
  // A future object-shaped SELECT (`{ rows, columns }`) passes straight through.
  return {
    rows: w.rows,
    columns: w.columns,
    changes: w.changes,
    last_insert_rowid: w.last_insert_rowid ?? w.lastInsertRowid,
  };
}

/** Read an environment variable. */
export function env(key: string): string | null {
  return __env(key);
}

/** Structured logging via Rust's tracing. */
export function log(level: "debug" | "info" | "warn" | "error", msg: string): void {
  __log(level, msg);
}
