// Generic loopback SDK client — the first *shared* wrapper around bext's
// `http://127.0.0.1/__bext/sdk/*` platform endpoints. Until now every site
// carried its own copy-pasted `kv.ts` / `db.ts` / `queue.ts`; this centralizes
// the wire format (loopback bypass: on 127.0.0.1 with `X-Bext-App-Id`, JWT is
// skipped and all data is app-scoped — see CLAUDE.md "SDK loopback bypass").
//
// Used by the task worker (`./task-worker`) to build a job's `ctx`, but usable
// standalone by any on-host Bun process (a sidecar, a one-shot script).

const DEFAULT_BASE = "http://127.0.0.1/__bext/sdk";

export interface SdkOptions {
  /** Override the SDK base URL (default `http://127.0.0.1/__bext/sdk`). */
  base?: string;
  /** Per-request timeout in ms (default 30_000). */
  timeoutMs?: number;
}

/** Wire-auth headers injected by bext into trusted on-host app workers. */
export function sdkWireHeaders(appId: string): Record<string, string> {
  const runtime = globalThis as typeof globalThis & {
    __env?: (key: string) => string | null | undefined;
    process?: { env?: Record<string, string | undefined> };
  };
  const processEnv = (
    globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process?.env;
  const read = (key: string): string | undefined => {
    const isolated = typeof runtime.__env === "function" ? runtime.__env(key) : undefined;
    return isolated || processEnv?.[key] || undefined;
  };
  const token = read("__BEXT_SDK_TOKEN");
  // V8 isolates receive their immutable identity as __BEXT_SITE, while
  // locked Bun command/task workers receive __BEXT_SDK_CALLER_SITE and
  // BEXT_APP_ID. The requested SDK namespace may intentionally differ (for
  // an exact operator-approved alias), so never infer the token identity from
  // appId until all authoritative runtime identities are absent.
  const callerSite =
    read("__BEXT_SITE") || read("__BEXT_SDK_CALLER_SITE") || read("BEXT_APP_ID") || appId;
  return token
    ? {
        "X-Bext-Caller-Site": callerSite,
        "X-Bext-Sdk-Token": token,
      }
    : { "X-Bext-Caller-Site": callerSite };
}

async function post(
  base: string,
  appId: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "X-Bext-App-Id": appId,
        ...sdkWireHeaders(appId),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: ctl.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(json?.error || `SDK ${path} → HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function get(
  base: string,
  appId: string,
  path: string,
  timeoutMs: number,
): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      headers: {
        "X-Bext-App-Id": appId,
        ...sdkWireHeaders(appId),
        Accept: "application/json",
      },
      signal: ctl.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(json?.error || `SDK ${path} → HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

/**
 * The KV store double-encodes on `set` (the value is JSON-stringified, then the
 * server stores that string as JSON again), so a `get` may come back wrapped up
 * to 3×. Peel defensively — the proven discipline from the per-site clients.
 */
function peel(raw: unknown): unknown {
  let v = raw;
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}

/** Bind params for the SQLite SDK, which accepts string params only: NULLs are
 *  inlined into the SQL is the caller's job; here we stringify scalars. */
function bindParams(params: unknown[]): string[] {
  return params.map((p) =>
    p === null || p === undefined ? "" : typeof p === "string" ? p : String(p),
  );
}

export interface BextSdk {
  appId: string;
  kv: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown, ttlSecs?: number): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(prefix?: string, limit?: number): Promise<string[]>;
  };
  db: {
    all<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
    get<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
    exec(
      sql: string,
      params?: unknown[],
    ): Promise<{ changes: number; lastInsertId: string | number | null }>;
  };
  queue: {
    push(queue: string, payload: unknown, delaySecs?: number): Promise<string>;
  };
  realtime: {
    publish(topic: string, data: unknown): Promise<boolean>;
  };
  email: {
    send(msg: {
      to: string[];
      subject: string;
      html?: string;
      text?: string;
    }): Promise<boolean>;
  };
  secrets: {
    get(key: string): Promise<string | null>;
  };
}

/** Build an app-scoped SDK client. */
export function createSdk(appId: string, opts: SdkOptions = {}): BextSdk {
  const base = opts.base ?? DEFAULT_BASE;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const P = (path: string, body: unknown) => post(base, appId, path, body, timeoutMs);
  const G = (path: string) => get(base, appId, path, timeoutMs);

  return {
    appId,
    kv: {
      async get<T = unknown>(key: string): Promise<T | null> {
        const r = await P("/kv/get", { key });
        if (r.value === null || r.value === undefined) return null;
        return peel(r.value) as T;
      },
      async set(key: string, value: unknown, ttlSecs?: number): Promise<void> {
        await P("/kv/set", { key, value: JSON.stringify(value), ttl: ttlSecs });
      },
      async delete(key: string): Promise<boolean> {
        const r = await P("/kv/delete", { key });
        return !!r.deleted;
      },
      async list(prefix?: string, limit = 100): Promise<string[]> {
        const r = await P("/kv/list", { prefix: prefix ?? "", limit });
        return Array.isArray(r.keys) ? r.keys : [];
      },
    },
    db: {
      async all<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
        const r = await P("/db/query", { sql, params: bindParams(params) });
        const cols: string[] = r.columns ?? [];
        const rows: unknown[][] = r.rows ?? [];
        return rows.map((row) => {
          const o: any = {};
          cols.forEach((c, i) => (o[c] = row[i]));
          return o as T;
        });
      },
      async get<T = any>(sql: string, params: unknown[] = []): Promise<T | null> {
        const rows = await this.all<T>(sql, params);
        return rows[0] ?? null;
      },
      async exec(sql: string, params: unknown[] = []) {
        const r = await P("/db/execute", { sql, params: bindParams(params) });
        return {
          changes: r.changes ?? 0,
          lastInsertId: r.last_insert_id ?? null,
        };
      },
    },
    queue: {
      async push(queue: string, payload: unknown, delaySecs?: number): Promise<string> {
        const r = await P("/queue/push", {
          queue,
          payload: typeof payload === "string" ? payload : JSON.stringify(payload),
          // The server reads `delay`; `delay_seconds` is kept for older servers.
          delay: delaySecs,
          delay_seconds: delaySecs,
        });
        return r.id ?? "";
      },
    },
    realtime: {
      async publish(topic: string, data: unknown): Promise<boolean> {
        try {
          const r = await P("/realtime/publish", { topic, data });
          return !!r.ok || !!r.published;
        } catch {
          return false;
        }
      },
    },
    email: {
      async send(msg): Promise<boolean> {
        const r = await P("/email/send", msg);
        return !!r.ok || !!r.sent;
      },
    },
    secrets: {
      async get(key: string): Promise<string | null> {
        try {
          // The server reads `name`; `key` is kept for older servers.
          const q = encodeURIComponent(key);
          const r = await G(`/secrets/get?name=${q}&key=${q}`);
          return r.value ?? null;
        } catch {
          return null;
        }
      },
    },
  };
}
