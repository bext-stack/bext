// migrate.ts — schema builder + migration runner for PRISM apps.
//
// The piece bext was missing: real, tracked, idempotent database migrations
// instead of lazy `CREATE TABLE IF NOT EXISTS` on every request or an
// out-of-band `db push`. Define ordered migrations, call `migrate(...)` once
// (safe to call every boot — it only runs the pending ones), and a
// `_bext_migrations` ledger records what's been applied.
//
//   const migrations = [
//     { id: "0001_create_notes", up: (db) => db.schema.createTable("notes", (t) => {
//         t.id();
//         t.text("body").notNull();
//         t.integer("created_at").notNull();
//       }),
//       down: (db) => db.schema.dropTable("notes"),
//     },
//   ];
//   migrate({ db: ".bext/data/app.db" }, migrations);   // applies pending, idempotent
//
// Shares the pluggable `Executor` with the ORM (@bext-stack/framework/orm), so
// migrations run in the isolate (native bridge) or against any SQLite in tests.

import { sql, SqlQuery, SQLITE_DIALECT, type SqlDialect } from "./sql";
import { resolveExecutor, type Executor } from "./orm";

// ---------------------------------------------------------------------------
// Schema builder (a small SQLite "Blueprint")
// ---------------------------------------------------------------------------

type ColType = "INTEGER" | "TEXT" | "REAL" | "BLOB";

interface ColumnSpec {
  name: string;
  type: ColType;
  notNull: boolean;
  unique: boolean;
  primaryKey: boolean;
  autoincrement: boolean;
  default?: { kind: "literal"; value: unknown } | { kind: "raw"; expr: string };
  references?: { table: string; column: string };
}

export class ColumnBuilder {
  /** @internal */ spec: ColumnSpec;
  constructor(name: string, type: ColType) {
    this.spec = { name, type, notNull: false, unique: false, primaryKey: false, autoincrement: false };
  }
  notNull(): this {
    this.spec.notNull = true;
    return this;
  }
  unique(): this {
    this.spec.unique = true;
    return this;
  }
  primaryKey(): this {
    this.spec.primaryKey = true;
    return this;
  }
  /** DEFAULT a literal (strings are quoted, numbers/booleans inlined). */
  default(value: unknown): this {
    this.spec.default = { kind: "literal", value };
    return this;
  }
  /** DEFAULT a raw SQL expression, e.g. `CURRENT_TIMESTAMP`. */
  defaultRaw(expr: string): this {
    this.spec.default = { kind: "raw", expr };
    return this;
  }
  /** Foreign key → `table(column)` (column defaults to `id`). */
  references(table: string, column = "id"): this {
    this.spec.references = { table, column };
    return this;
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
function literalDefault(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}
function columnDdl(spec: ColumnSpec): string {
  let s = `${quoteIdent(spec.name)} ${spec.type}`;
  if (spec.primaryKey) s += spec.autoincrement ? " PRIMARY KEY AUTOINCREMENT" : " PRIMARY KEY";
  if (spec.notNull && !spec.primaryKey) s += " NOT NULL";
  if (spec.unique && !spec.primaryKey) s += " UNIQUE";
  if (spec.default) s += ` DEFAULT ${spec.default.kind === "raw" ? spec.default.expr : literalDefault(spec.default.value)}`;
  if (spec.references) s += ` REFERENCES ${quoteIdent(spec.references.table)}(${quoteIdent(spec.references.column)})`;
  return s;
}

export class TableBuilder {
  /** @internal */ columns: ColumnBuilder[] = [];
  private add(name: string, type: ColType): ColumnBuilder {
    const c = new ColumnBuilder(name, type);
    this.columns.push(c);
    return c;
  }
  /** Auto-increment INTEGER primary key (default name `id`). */
  id(name = "id"): ColumnBuilder {
    const c = this.add(name, "INTEGER");
    c.spec.primaryKey = true;
    c.spec.autoincrement = true;
    return c;
  }
  integer(name: string): ColumnBuilder {
    return this.add(name, "INTEGER");
  }
  text(name: string): ColumnBuilder {
    return this.add(name, "TEXT");
  }
  real(name: string): ColumnBuilder {
    return this.add(name, "REAL");
  }
  /** Stored as INTEGER 0/1. */
  boolean(name: string): ColumnBuilder {
    return this.add(name, "INTEGER");
  }
  blob(name: string): ColumnBuilder {
    return this.add(name, "BLOB");
  }
  /** JSON text column. */
  json(name: string): ColumnBuilder {
    return this.add(name, "TEXT");
  }
  /** `created_at` + `updated_at` (epoch-ms INTEGER, NOT NULL). */
  timestamps(): void {
    this.add("created_at", "INTEGER").notNull();
    this.add("updated_at", "INTEGER").notNull();
  }
  /** @internal */ toSql(tableName: string, ifNotExists: boolean): string {
    const cols = this.columns.map((c) => "  " + columnDdl(c.spec)).join(",\n");
    return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdent(tableName)} (\n${cols}\n)`;
  }
}

/** Build a `CREATE TABLE` statement. Returns the SQL string. */
export function createTable(name: string, build: (t: TableBuilder) => void, opts: { ifNotExists?: boolean } = {}): string {
  const t = new TableBuilder();
  build(t);
  return t.toSql(name, opts.ifNotExists ?? false);
}

/** Build a `DROP TABLE` statement. */
export function dropTable(name: string, opts: { ifExists?: boolean } = {}): string {
  return `DROP TABLE ${opts.ifExists ?? true ? "IF EXISTS " : ""}${quoteIdent(name)}`;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/** The db handle a migration's up/down receives. */
export interface MigrateDb {
  /** Run raw DDL/SQL text. */
  exec(sqlText: string): void;
  /** Run a `sql\`\`` query. */
  run(query: SqlQuery): { changes: number; lastInsertRowid: number };
  /** Read rows from a `sql\`\`` query. */
  rows(query: SqlQuery): Record<string, unknown>[];
  schema: {
    createTable(name: string, build: (t: TableBuilder) => void, opts?: { ifNotExists?: boolean }): void;
    dropTable(name: string, opts?: { ifExists?: boolean }): void;
    raw(sqlText: string): void;
  };
}

export interface Migration {
  /** Unique, sortable id — e.g. `"0001_create_notes"`. Migrations run in id order. */
  id: string;
  up: (db: MigrateDb) => void;
  down?: (db: MigrateDb) => void;
}

const LEDGER = "_bext_migrations";

function makeDb(exec: Executor, dialect: SqlDialect): MigrateDb {
  const db: MigrateDb = {
    exec(text) {
      exec.run(text, []);
    },
    run(query) {
      const q = query.compile(dialect);
      return exec.run(q.text, q.params);
    },
    rows(query) {
      const q = query.compile(dialect);
      return exec.rows(q.text, q.params);
    },
    schema: {
      createTable(name, build, opts) {
        exec.run(createTable(name, build, opts), []);
      },
      dropTable(name, opts) {
        exec.run(dropTable(name, opts), []);
      },
      raw(text) {
        exec.run(text, []);
      },
    },
  };
  return db;
}

function ensureLedger(exec: Executor): void {
  exec.run(`CREATE TABLE IF NOT EXISTS ${quoteIdent(LEDGER)} (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`, []);
}
function appliedMap(exec: Executor): Map<string, string> {
  const rows = exec.rows(`SELECT id, applied_at FROM ${quoteIdent(LEDGER)}`, []);
  const m = new Map<string, string>();
  for (const r of rows) m.set(String(r.id), String(r.applied_at));
  return m;
}
function sortById(migrations: Migration[]): Migration[] {
  return [...migrations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function nowIso(): string {
  // Site/isolate code may use Date (unlike workflow scripts).
  return new Date().toISOString();
}

/** Apply all pending migrations in id order. Idempotent — already-applied ones
 *  are skipped. Returns which ids ran vs. were already present. */
export function migrate(
  source: { db?: string; executor?: Executor; dialect?: SqlDialect },
  migrations: Migration[],
): { applied: string[]; skipped: string[] } {
  const exec = resolveExecutor(source);
  const dialect = source.dialect ?? SQLITE_DIALECT;
  ensureLedger(exec);
  const done = appliedMap(exec);
  const db = makeDb(exec, dialect);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const m of sortById(migrations)) {
    if (done.has(m.id)) {
      skipped.push(m.id);
      continue;
    }
    m.up(db);
    exec.run(`INSERT INTO ${quoteIdent(LEDGER)} (id, applied_at) VALUES (?, ?)`, [m.id, nowIso()]);
    applied.push(m.id);
  }
  return { applied, skipped };
}

/** Roll back the last `steps` applied migrations (default 1), newest first.
 *  Migrations without a `down` are skipped (their ledger row stays). */
export function rollback(
  source: { db?: string; executor?: Executor; dialect?: SqlDialect },
  migrations: Migration[],
  steps = 1,
): { rolledBack: string[] } {
  const exec = resolveExecutor(source);
  const dialect = source.dialect ?? SQLITE_DIALECT;
  ensureLedger(exec);
  const done = appliedMap(exec);
  const db = makeDb(exec, dialect);
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const appliedNewestFirst = [...done.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const rolledBack: string[] = [];
  for (const id of appliedNewestFirst) {
    if (rolledBack.length >= steps) break;
    const m = byId.get(id);
    if (m?.down) m.down(db);
    exec.run(`DELETE FROM ${quoteIdent(LEDGER)} WHERE id = ?`, [id]);
    rolledBack.push(id);
  }
  return { rolledBack };
}

/** Which migrations are applied vs. pending (with applied timestamps). */
export function migrationStatus(
  source: { db?: string; executor?: Executor },
  migrations: Migration[],
): { id: string; applied: boolean; appliedAt?: string }[] {
  const exec = resolveExecutor(source);
  ensureLedger(exec);
  const done = appliedMap(exec);
  return sortById(migrations).map((m) => ({
    id: m.id,
    applied: done.has(m.id),
    appliedAt: done.get(m.id),
  }));
}
