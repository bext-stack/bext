// orm.ts — a tiny typed model / query-builder layer for PRISM apps.
//
// The app-developer counterpart to raw `sql`/`dbQuery`: an Eloquent-lite
// repository over bext's in-process SQLite. Injection-safe by construction
// (every value goes through the `sql` tagged template), and it returns REAL
// typed objects — it zips the positional-array rows the bridge hands back, so
// you never touch `.columns`/`.rows` again.
//
//   interface Note { id: number; body: string; created_at: number }
//   const Notes = defineModel<Note>({ table: "notes", db: ".bext/data/app.db", timestamps: true });
//
//   Notes.create({ body: "hello" });                     // INSERT, returns the row
//   Notes.where("id", ">", 10).orderBy("id", "desc").limit(20).all();
//   Notes.find(3);                                        // by primary key
//   Notes.update(3, { body: "edited" });
//   Notes.delete(3);
//
// Pairs with the migration runner (@bext-stack/framework/migrate) for schema.
// Execution is pluggable via `Executor`, so the same models run in the V8/QuickJS
// isolate (default: the native `dbQuery` bridge) or against any SQLite in tests.

import { sql, SqlQuery, SQLITE_DIALECT, type SqlDialect } from "./sql";
import { dbQuery } from "./bridge";

// ---------------------------------------------------------------------------
// Executor — the one seam between the query layer and a concrete SQLite
// ---------------------------------------------------------------------------

export interface Executor {
  /** Run a SELECT, returning rows as plain objects (columns already zipped). */
  rows(text: string, params: unknown[]): Record<string, unknown>[];
  /** Run a write, returning affected-row count + last inserted rowid. */
  run(text: string, params: unknown[]): { changes: number; lastInsertRowid: number };
}

/** The default executor: bext's native in-process SQLite via `dbQuery`. It zips
 *  the bridge's positional-array rows into objects (the documented row-shape
 *  gotcha) and is defensive if a future runtime returns objects already. */
export function bridgeExecutor(dbPath: string): Executor {
  return {
    rows(text, params) {
      const r = dbQuery(dbPath, text, params) as { rows?: unknown[]; columns?: string[] };
      const cols = r.columns ?? [];
      const raw = r.rows ?? [];
      return raw.map((row) => {
        if (Array.isArray(row)) {
          const obj: Record<string, unknown> = {};
          cols.forEach((c, i) => (obj[c] = row[i]));
          return obj;
        }
        return row as Record<string, unknown>;
      });
    },
    run(text, params) {
      const r = dbQuery(dbPath, text, params) as { changes?: number; last_insert_rowid?: number };
      return { changes: r.changes ?? 0, lastInsertRowid: r.last_insert_rowid ?? 0 };
    },
  };
}

/** Resolve either a db path (→ bridge executor) or an explicit executor. */
export function resolveExecutor(source: { db?: string; executor?: Executor }): Executor {
  if (source.executor) return source.executor;
  if (source.db) return bridgeExecutor(source.db);
  throw new Error("orm: provide either `db` (a SQLite path) or `executor`");
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

export type Op = "=" | "!=" | "<" | "<=" | ">" | ">=" | "like" | "not like";
const OPS: Record<Op, string> = {
  "=": "=",
  "!=": "!=",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
  like: "LIKE",
  "not like": "NOT LIKE",
};

interface QueryState {
  wheres: SqlQuery[];
  orders: SqlQuery[];
  limit: number | null;
  offset: number | null;
}

export class QueryBuilder<T> {
  private state: QueryState = { wheres: [], orders: [], limit: null, offset: null };
  constructor(
    private readonly table: string,
    private readonly exec: Executor,
    private readonly dialect: SqlDialect,
    private readonly primaryKey: string,
  ) {}

  /** `AND` condition. `op` is validated against a fixed allowlist. */
  where(column: keyof T & string, op: Op, value: unknown): this {
    const sqlOp = OPS[op];
    if (!sqlOp) throw new Error(`orm: unsupported operator "${op}"`);
    this.state.wheres.push(sql`${sql.id(column)} ${sql.raw(sqlOp)} ${value}`);
    return this;
  }

  /** `AND column IN (...)`. Empty list matches nothing. */
  whereIn(column: keyof T & string, values: unknown[]): this {
    this.state.wheres.push(values.length ? sql`${sql.id(column)} IN (${values})` : sql`1 = 0`);
    return this;
  }

  orderBy(column: keyof T & string, direction: "asc" | "desc" = "asc"): this {
    this.state.orders.push(sql`${sql.id(column)} ${sql.raw(direction === "desc" ? "DESC" : "ASC")}`);
    return this;
  }

  limit(n: number): this {
    this.state.limit = n;
    return this;
  }
  offset(n: number): this {
    this.state.offset = n;
    return this;
  }

  private whereClause(): SqlQuery {
    return this.state.wheres.length ? sql`WHERE ${sql.join(this.state.wheres, " AND ")}` : sql``;
  }
  private tailClause(): SqlQuery {
    const order = this.state.orders.length ? sql`ORDER BY ${sql.join(this.state.orders, ", ")}` : sql``;
    const limit = this.state.limit != null ? sql`LIMIT ${this.state.limit}` : sql``;
    const offset = this.state.offset != null ? sql`OFFSET ${this.state.offset}` : sql``;
    return sql`${order} ${limit} ${offset}`;
  }

  /** The compiled SELECT — for logging / debugging. */
  toSql(): { text: string; params: unknown[] } {
    return sql`SELECT * FROM ${sql.id(this.table)} ${this.whereClause()} ${this.tailClause()}`.compile(this.dialect);
  }

  all(): T[] {
    const q = sql`SELECT * FROM ${sql.id(this.table)} ${this.whereClause()} ${this.tailClause()}`.compile(this.dialect);
    return this.exec.rows(q.text, q.params) as T[];
  }

  first(): T | null {
    this.state.limit = 1;
    return (this.all()[0] ?? null) as T | null;
  }

  count(): number {
    const q = sql`SELECT COUNT(*) AS n FROM ${sql.id(this.table)} ${this.whereClause()}`.compile(this.dialect);
    const row = this.exec.rows(q.text, q.params)[0] as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** Bulk update the matched rows. Returns affected count. */
  update(data: Partial<T>): number {
    const cols = Object.keys(data);
    if (!cols.length) return 0;
    const sets = sql.join(cols.map((c) => sql`${sql.id(c)} = ${(data as Record<string, unknown>)[c]}`), ", ");
    const q = sql`UPDATE ${sql.id(this.table)} SET ${sets} ${this.whereClause()}`.compile(this.dialect);
    return this.exec.run(q.text, q.params).changes;
  }

  /** Bulk delete the matched rows. Returns affected count. */
  delete(): number {
    const q = sql`DELETE FROM ${sql.id(this.table)} ${this.whereClause()}`.compile(this.dialect);
    return this.exec.run(q.text, q.params).changes;
  }
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export interface ModelConfig {
  table: string;
  /** SQLite file path (uses the native bridge). Mutually exclusive with `executor`. */
  db?: string;
  /** Explicit executor (tests, or a non-bridge backend). */
  executor?: Executor;
  /** Primary key column. Default `"id"`. */
  primaryKey?: string;
  /** Auto-manage `created_at` / `updated_at` (epoch ms) on create/update. */
  timestamps?: boolean;
  dialect?: SqlDialect;
}

export interface Model<T> {
  readonly table: string;
  /** Start a query. */
  query(): QueryBuilder<T>;
  /** Shorthand for `query().where(...)`. */
  where(column: keyof T & string, op: Op, value: unknown): QueryBuilder<T>;
  all(): T[];
  find(id: unknown): T | null;
  first(): T | null;
  count(): number;
  /** INSERT a row; returns it (re-read by primary key, so defaults/ids are populated). */
  create(data: Partial<T>): T;
  /** UPDATE by primary key; returns affected count. */
  update(id: unknown, data: Partial<T>): number;
  /** DELETE by primary key; returns affected count. */
  delete(id: unknown): number;
  /** Escape hatch: run an arbitrary `sql\`\`` query, rows typed as `T`. */
  raw(query: SqlQuery): T[];
}

export function defineModel<T>(config: ModelConfig): Model<T> {
  const table = config.table;
  const pk = config.primaryKey ?? "id";
  const dialect = config.dialect ?? SQLITE_DIALECT;
  const exec = resolveExecutor(config);
  const newQuery = () => new QueryBuilder<T>(table, exec, dialect, pk);

  const model: Model<T> = {
    table,
    query: newQuery,
    where(column, op, value) {
      return newQuery().where(column, op, value);
    },
    all() {
      return newQuery().all();
    },
    find(id) {
      return newQuery().where(pk as keyof T & string, "=", id).first();
    },
    first() {
      return newQuery().first();
    },
    count() {
      return newQuery().count();
    },
    create(data) {
      const row: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      if (config.timestamps) {
        const now = Date.now();
        if (row.created_at === undefined) row.created_at = now;
        if (row.updated_at === undefined) row.updated_at = now;
      }
      const cols = Object.keys(row);
      const colFrag = sql.join(cols.map((c) => sql`${sql.id(c)}`), ", ");
      const valFrag = sql.join(cols.map((c) => sql`${row[c]}`), ", ");
      const q = sql`INSERT INTO ${sql.id(table)} (${colFrag}) VALUES (${valFrag})`.compile(dialect);
      const { lastInsertRowid } = exec.run(q.text, q.params);
      // Re-read so server-side defaults / autoincrement id are reflected.
      const found = model.find(row[pk] ?? lastInsertRowid);
      return (found ?? (row as T)) as T;
    },
    update(id, data) {
      const patch: Record<string, unknown> = { ...(data as Record<string, unknown>) };
      if (config.timestamps && patch.updated_at === undefined) patch.updated_at = Date.now();
      return newQuery().where(pk as keyof T & string, "=", id).update(patch as Partial<T>);
    },
    delete(id) {
      return newQuery().where(pk as keyof T & string, "=", id).delete();
    },
    raw(query) {
      const q = query.compile(dialect);
      return exec.rows(q.text, q.params) as T[];
    },
  };
  return model;
}
