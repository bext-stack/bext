// Elegant, direct, in-process SQLite for a PRISM render — no loopback, no HTTP.
//
// Backed by the native `globalThis.__dbQuery` bridge (rusqlite in the render
// worker, prepared-statement cache, results returned as native V8 row objects —
// no JSON round-trip). A `db.sql\`…\`` is a native function call. Tagged
// templates bind `${values}` as SQL parameters (injection-safe).
//
//   import { sqlite } from "@bext-stack/framework/db";
//   const db = sqlite("/abs/path/app.sqlite");
//   const rows = db.sql\`SELECT id, name FROM users WHERE id = ${id}\`;   // Row[]
//   const one  = db.get\`SELECT * FROM users WHERE id = ${id}\`;           // Row | undefined
//   const w    = db.run\`UPDATE users SET seen = ${now} WHERE id = ${id}\`; // { changes, lastInsertRowid }

export type Row = Record<string, unknown>;
export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

function build(strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
  let text = strings[0];
  for (let i = 0; i < values.length; i++) text += "?" + strings[i + 1];
  return { text, params: values };
}

// The native bridge returns row objects directly for SELECT, or
// { changes, lastInsertRowid } for a write — no parsing needed.
function call(dbPath: string, text: string, params: unknown[]): any {
  const fn = (globalThis as any).__dbQuery as
    | ((dbPath: string, sql: string, paramsJson?: string) => unknown)
    | undefined;
  if (typeof fn !== "function") {
    throw new Error("bext direct DB unavailable — the __dbQuery bridge is only present inside a bext render");
  }
  return fn(dbPath, text, params.length ? JSON.stringify(params) : undefined);
}

export interface Db {
  /** Run a query, return every row as an object. */
  sql<T = Row>(strings: TemplateStringsArray, ...values: unknown[]): T[];
  /** Run a query, return the first row (or undefined). */
  get<T = Row>(strings: TemplateStringsArray, ...values: unknown[]): T | undefined;
  /** Run a write, return { changes, lastInsertRowid }. */
  run(strings: TemplateStringsArray, ...values: unknown[]): RunResult;
  /** Non-template escape hatch: db.query("SELECT …", [params]). */
  query<T = Row>(sql: string, params?: unknown[]): T[];
}

export function sqlite(dbPath: string): Db {
  return {
    sql(strings, ...values) {
      const { text, params } = build(strings, values);
      return call(dbPath, text, params) as any;
    },
    get(strings, ...values) {
      const { text, params } = build(strings, values);
      return (call(dbPath, text, params) as any[])[0];
    },
    run(strings, ...values) {
      const { text, params } = build(strings, values);
      const r = call(dbPath, text, params);
      return { changes: r?.changes ?? 0, lastInsertRowid: r?.lastInsertRowid ?? 0 };
    },
    query(sql, params = []) {
      return call(dbPath, sql, params) as any;
    },
  };
}
