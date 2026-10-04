// sql.ts — injection-safe tagged-template SQL for bext's SDK.
//
// Stolen from Bun.SQL's design (bun-src/src/js/internal/sql/shared.ts): one
// tagged template + a single "normalize" choke point where interpolated values
// become bound params and ONLY identifiers/raw/fragments contribute text. The
// ergonomic API + composition live in pure JS, so it runs identically on V8 and
// QuickJS; only `{ text, params }` crosses into Rust via __dbQuery (bridge.ts).
//
// Injection is impossible by construction: a `${value}` is pushed to the params
// array and replaced by a placeholder — its text is never concatenated into SQL.
// See plan/bun-steals/ (steal #3, "SDK sql`` tagged-template").

import { dbQuery } from "./bridge";

// --- adapter seam: the only DB-specific bits (Bun's BaseSQLAdapter hooks) -----
export interface SqlDialect {
  /** Positional placeholder for the i-th bound param (0-based). SQLite: "?". */
  placeholder(index: number): string;
  /** Escape an identifier (table/column name). Standard: double-quote. */
  escapeIdentifier(name: string): string;
}

/** SQLite (rusqlite) — bext's in-process default. Positional `?` binding. */
export const SQLITE_DIALECT: SqlDialect = {
  placeholder: () => "?",
  escapeIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
};

/** Postgres-ready seam (the future steal): `$1..$N`. Not used until bext has a
 *  network PG client; here to prove the abstraction holds. */
export const POSTGRES_DIALECT: SqlDialect = {
  placeholder: (i) => `$${i + 1}`,
  escapeIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
};

// --- value wrappers (identifier / raw text) ----------------------------------
const IDENT = Symbol.for("bext.sql.ident");
const RAW = Symbol.for("bext.sql.raw");
interface Identifier {
  [IDENT]: true;
  name: string;
}
interface RawText {
  [RAW]: true;
  text: string;
}

/** A lazily-compiled, composable SQL fragment/query. */
export class SqlQuery {
  /** Brand — detected structurally (not `instanceof`) so it survives duplicate
   *  bundle copies, like the framework's `__bextSignal` convention. */
  readonly _bextSql = true as const;
  constructor(
    readonly strings: readonly string[],
    readonly values: readonly unknown[],
  ) {}

  /** Compile to `{ text, params }`. Injection-safe: scalars → placeholders +
   *  params; identifiers escaped; nested fragments thread one global param
   *  counter so `$N`-style dialects number consistently. */
  compile(dialect: SqlDialect = SQLITE_DIALECT): { text: string; params: unknown[] } {
    const params: unknown[] = [];
    const text = buildSql(this, dialect, params);
    return { text, params };
  }
}

function isQuery(v: unknown): v is SqlQuery {
  return !!v && typeof v === "object" && (v as { _bextSql?: unknown })._bextSql === true;
}

function buildSql(q: SqlQuery, dialect: SqlDialect, params: unknown[]): string {
  let text = "";
  for (let i = 0; i < q.strings.length; i++) {
    text += q.strings[i];
    if (i < q.values.length) text += emitValue(q.values[i], dialect, params);
  }
  return text;
}

function emitValue(value: unknown, dialect: SqlDialect, params: unknown[]): string {
  if (isQuery(value)) return buildSql(value, dialect, params); // nested fragment
  if (value && typeof value === "object") {
    if ((value as Partial<Identifier>)[IDENT]) return dialect.escapeIdentifier((value as Identifier).name);
    if ((value as Partial<RawText>)[RAW]) return (value as RawText).text;
  }
  if (Array.isArray(value)) {
    // expand `${[1,2,3]}` → "?, ?, ?" for `IN (...)`
    return value
      .map((v) => {
        params.push(v);
        return dialect.placeholder(params.length - 1);
      })
      .join(", ");
  }
  params.push(value); // scalar / null / Date / object → one bound param
  return dialect.placeholder(params.length - 1);
}

// --- the tagged template + helpers -------------------------------------------
export interface SqlTag {
  (strings: TemplateStringsArray, ...values: unknown[]): SqlQuery;
  /** Quote an identifier (table/column) for safe interpolation. */
  id(name: string): Identifier;
  /** Raw, UNescaped text — caller asserts safety (e.g. a fixed `ASC`/`DESC`). */
  raw(text: string): RawText;
  /** Conditionally include a fragment, else nothing. */
  if(cond: unknown, frag: SqlQuery): SqlQuery | RawText;
  /** Join fragments with a separator (e.g. ` AND `, `, `). */
  join(frags: readonly SqlQuery[], separator: string): SqlQuery;
}

const EMPTY_RAW: RawText = { [RAW]: true, text: "" };

export const sql: SqlTag = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]) =>
    new SqlQuery(strings as unknown as string[], values),
  {
    id: (name: string): Identifier => ({ [IDENT]: true, name }),
    raw: (text: string): RawText => ({ [RAW]: true, text }),
    if: (cond: unknown, frag: SqlQuery): SqlQuery | RawText => (cond ? frag : EMPTY_RAW),
    join: (frags: readonly SqlQuery[], separator: string): SqlQuery => {
      // Build a synthetic template whose static parts are the separators.
      const strings: string[] = [""];
      const values: unknown[] = [];
      frags.forEach((f, i) => {
        values.push(f);
        strings.push(i < frags.length - 1 ? separator : "");
      });
      return new SqlQuery(strings, values);
    },
  },
) as SqlTag;

// --- execution: bind a db file, run compiled queries through the SDK bridge ---
export interface BextDb {
  /** All rows. */
  all<T = Record<string, unknown>>(q: SqlQuery): T[];
  /** First row or null. */
  get<T = Record<string, unknown>>(q: SqlQuery): T | null;
  /** A write; returns `{ changes, last_insert_rowid }`. */
  run(q: SqlQuery): { changes: number; last_insert_rowid: number };
  /** Inspect the compiled SQL without executing. */
  compile(q: SqlQuery): { text: string; params: unknown[] };
}

/** Bind a SQLite file: `const db = database("data.sqlite");
 *  db.all(sql\`SELECT * FROM t WHERE id = ${id}\`)`. */
export function database(dbPath: string, dialect: SqlDialect = SQLITE_DIALECT): BextDb {
  const exec = (q: SqlQuery) => {
    const { text, params } = q.compile(dialect);
    return dbQuery(dbPath, text, params);
  };
  return {
    all<T = Record<string, unknown>>(q: SqlQuery): T[] {
      return (exec(q).rows ?? []) as T[];
    },
    get<T = Record<string, unknown>>(q: SqlQuery): T | null {
      return ((exec(q).rows ?? [])[0] ?? null) as T | null;
    },
    run(q: SqlQuery): { changes: number; last_insert_rowid: number } {
      const r = exec(q);
      return { changes: r.changes ?? 0, last_insert_rowid: r.last_insert_rowid ?? 0 };
    },
    compile(q: SqlQuery) {
      return q.compile(dialect);
    },
  };
}
