// validation.ts — schema validation for PRISM apps (the TS app-developer facade).
//
// This is the TypeScript, in-isolate counterpart to the server-side Rust
// `ValidatorPlugin` capability (see docs /capabilities/validator). That trait
// validates config files / queue payloads / plugin boundaries in Rust; THIS
// module is what a PRISM site author reaches for when handling a server-action
// `FormData` or a JSON request body — no plugin to configure, no IPC, no
// dependency. It's pure JS (like sql.ts), so it runs identically on V8 and
// QuickJS and never crosses the host boundary.
//
// Design goals, in order:
//   1. Typed by construction — `Infer<typeof schema>` gives you the parsed shape.
//   2. Web-form native — coerces the all-strings world of FormData (numbers,
//      checkboxes, repeated keys → arrays) instead of rejecting it.
//   3. Multi-error — every failing check reports in ONE pass (across fields AND
//      within a field), so the UI can show all problems at once (Laravel's
//      validator / the Rust trait both do this). `errorsByField` still returns
//      the FIRST message per field, and checks run in declaration order, so
//      putting `.nonempty()` before `.email()` gives the natural "required THEN
//      format" UX for free; `errorsByFieldAll` exposes the full list.
//
// Zod-shaped on purpose (`v.object({...})`, `.parse` / `.safeParse`), so the
// mental model transfers, but ~1/50th the size and zero deps.
//
// Quick start:
//   import { v, validate, errorsByField } from "@bext-stack/framework/validation";
//   const Signup = v.object({
//     email:    v.string().trim().nonempty("Email required").email("Looks malformed"),
//     username: v.string().trim().min(3).regex(/^[a-z0-9_]+$/i, "letters, digits, _ only"),
//     age:      v.number().int().min(13).max(120),
//   });
//   type Signup = Infer<typeof Signup>;
//   // in a server action:
//   const result = await validate(request, Signup);   // reads FormData | JSON
//   if (!result.ok) return { ok: false, errors: errorsByField(result.errors) };
//   const user = result.data;  // fully typed & coerced

// ---------------------------------------------------------------------------
// Result & error types
// ---------------------------------------------------------------------------

/** One validation failure. `path` is the field name (dot/bracket-joined for
 *  nested objects & arrays, e.g. `address.zip`, `tags[2]`). `code` is a stable
 *  machine key (`required`, `min`, `email`, `type`, `custom`, …). */
export interface FieldError {
  path: string;
  message: string;
  code: string;
}

export type ValidationResult<T> =
  | { ok: true; data: T; errors: null }
  | { ok: false; data: null; errors: FieldError[] };

/** Thrown by `.parse()` on failure. `.safeParse()` never throws. */
export class ValidationError extends Error {
  readonly errors: FieldError[];
  constructor(errors: FieldError[]) {
    super(errors.map((e) => `${e.path || "value"}: ${e.message}`).join("; ") || "Validation failed");
    this.name = "ValidationError";
    this.errors = errors;
  }
}

/** Static type a validator produces: `Infer<typeof schema>`. */
export type Infer<V> = V extends Validator<infer T> ? T : never;

// ---------------------------------------------------------------------------
// Internal run protocol
// ---------------------------------------------------------------------------

type Run<T> = (input: unknown, path: string) => { ok: true; value: T } | { ok: false; issues: FieldError[] };

const issue = (path: string, message: string, code: string): { ok: false; issues: FieldError[] } => ({
  ok: false,
  issues: [{ path, message, code }],
});

// ---------------------------------------------------------------------------
// Base validator
// ---------------------------------------------------------------------------

export interface Validator<T> {
  readonly _bextValidator: true;
  /** @internal */ _run: Run<T>;
  /** Validate, collecting ALL field errors. Never throws for invalid input. */
  safeParse(input: unknown): ValidationResult<T>;
  /** Validate; return the typed value or throw {@link ValidationError}. */
  parse(input: unknown): T;
  /** Accept `undefined` (a missing field) as valid, yielding `undefined`. */
  optional(): Validator<T | undefined>;
  /** Accept `null` as valid, yielding `null`. */
  nullable(): Validator<T | null>;
  /** Substitute a value (or factory) when the field is absent (`undefined`). */
  default(value: T | (() => T)): Validator<T>;
  /** Add a custom predicate; fails with `message`/`code` when it returns false. */
  refine(test: (value: T) => boolean, message?: string, code?: string): Validator<T>;
  /** Map the validated value to a new shape (runs only on success). */
  transform<U>(fn: (value: T) => U): Validator<U>;
}

function build<T>(run: Run<T>): Validator<T> {
  const self: Validator<T> = {
    _bextValidator: true,
    _run: run,
    safeParse(input) {
      const r = run(input, "");
      return r.ok ? { ok: true, data: r.value, errors: null } : { ok: false, data: null, errors: r.issues };
    },
    parse(input) {
      const r = run(input, "");
      if (!r.ok) throw new ValidationError(r.issues);
      return r.value;
    },
    optional() {
      return build<T | undefined>((i, p) => (i === undefined ? { ok: true, value: undefined } : run(i, p)));
    },
    nullable() {
      return build<T | null>((i, p) => (i === null ? { ok: true, value: null } : run(i, p)));
    },
    default(value) {
      return build<T>((i, p) =>
        i === undefined ? { ok: true, value: typeof value === "function" ? (value as () => T)() : value } : run(i, p),
      );
    },
    refine(test, message = "Invalid value", code = "custom") {
      return build<T>((i, p) => {
        const r = run(i, p);
        if (!r.ok) return r;
        return test(r.value) ? r : issue(p, message, code);
      });
    },
    transform(fn) {
      return build((i, p) => {
        const r = run(i, p);
        return r.ok ? { ok: true, value: fn(r.value) } : r;
      });
    },
  };
  return self;
}

// ---------------------------------------------------------------------------
// string
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface StringValidator extends Validator<string> {
  min(n: number, message?: string): StringValidator;
  max(n: number, message?: string): StringValidator;
  length(n: number, message?: string): StringValidator;
  /** Reject the empty string (e.g. a present-but-blank form field). */
  nonempty(message?: string): StringValidator;
  regex(re: RegExp, message?: string): StringValidator;
  email(message?: string): StringValidator;
  url(message?: string): StringValidator;
  /** Trim surrounding whitespace before the checks run. */
  trim(): StringValidator;
  toLowerCase(): StringValidator;
}

type StrCheck = (s: string) => { message: string; code: string } | null;

/** Override the built-in messages for the absent/wrong-type cases (the ones
 *  `.min()`/`.email()` can't reach). */
export interface StringOptions {
  required?: string;
  type?: string;
}

function makeString(transforms: ((s: string) => string)[], checks: StrCheck[], msgs: StringOptions): StringValidator {
  const run: Run<string> = (input, path) => {
    if (input === undefined || input === null) return issue(path, msgs.required ?? "Required", "required");
    let s: string;
    if (typeof input === "string") s = input;
    else if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") s = String(input);
    else return issue(path, msgs.type ?? "Must be text", "type");
    for (const tr of transforms) s = tr(s);
    const issues: FieldError[] = [];
    for (const chk of checks) {
      const fail = chk(s);
      if (fail) issues.push({ path, message: fail.message, code: fail.code }); // collect every failing check
    }
    return issues.length ? { ok: false, issues } : { ok: true, value: s };
  };
  const withCheck = (c: StrCheck) => makeString(transforms, [...checks, c], msgs);
  const withTransform = (t: (s: string) => string) => makeString([...transforms, t], checks, msgs);
  const fail = (message: string, code: string) => ({ message, code });
  return Object.assign(build(run), {
    min: (n: number, m?: string) => withCheck((s) => (s.length < n ? fail(m ?? `Must be at least ${n} characters`, "min") : null)),
    max: (n: number, m?: string) => withCheck((s) => (s.length > n ? fail(m ?? `Must be at most ${n} characters`, "max") : null)),
    length: (n: number, m?: string) => withCheck((s) => (s.length !== n ? fail(m ?? `Must be exactly ${n} characters`, "length") : null)),
    nonempty: (m?: string) => withCheck((s) => (s.length === 0 ? fail(m ?? "Required", "required") : null)),
    regex: (re: RegExp, m?: string) => withCheck((s) => (!re.test(s) ? fail(m ?? "Invalid format", "regex") : null)),
    email: (m?: string) => withCheck((s) => (!EMAIL_RE.test(s) ? fail(m ?? "Must be a valid email", "email") : null)),
    url: (m?: string) =>
      withCheck((s) => {
        try {
          new URL(s);
          return null;
        } catch {
          return fail(m ?? "Must be a valid URL", "url");
        }
      }),
    trim: () => withTransform((s) => s.trim()),
    toLowerCase: () => withTransform((s) => s.toLowerCase()),
  }) as StringValidator;
}

// ---------------------------------------------------------------------------
// number (coerces the numeric-string world of forms)
// ---------------------------------------------------------------------------

export interface NumberValidator extends Validator<number> {
  int(message?: string): NumberValidator;
  min(n: number, message?: string): NumberValidator;
  max(n: number, message?: string): NumberValidator;
  positive(message?: string): NumberValidator;
  nonnegative(message?: string): NumberValidator;
}

type NumCheck = (n: number) => { message: string; code: string } | null;

export interface NumberOptions {
  required?: string;
  invalid?: string;
}

function makeNumber(checks: NumCheck[], msgs: NumberOptions): NumberValidator {
  const run: Run<number> = (input, path) => {
    let n: number;
    if (typeof input === "number") n = input;
    else if (typeof input === "string") {
      const s = input.trim();
      if (s === "") return issue(path, msgs.required ?? "Required", "required");
      n = Number(s);
      if (Number.isNaN(n)) return issue(path, msgs.invalid ?? "Must be a number", "type");
    } else if (input === undefined || input === null) return issue(path, msgs.required ?? "Required", "required");
    else return issue(path, msgs.invalid ?? "Must be a number", "type");
    if (!Number.isFinite(n)) return issue(path, "Must be a finite number", "type");
    const issues: FieldError[] = [];
    for (const chk of checks) {
      const fail = chk(n);
      if (fail) issues.push({ path, message: fail.message, code: fail.code });
    }
    return issues.length ? { ok: false, issues } : { ok: true, value: n };
  };
  const withCheck = (c: NumCheck) => makeNumber([...checks, c], msgs);
  const fail = (message: string, code: string) => ({ message, code });
  return Object.assign(build(run), {
    // NB: threshold param is `limit`, NOT `v` — a param named `v` would shadow
    // the module-level `const v` namespace, and the tsc-rs isolate compile binds
    // the inner ref to the outer object (→ `n < NaN` → never fails). Bun scopes
    // it correctly, so this only surfaced against the live V8 render. Don't rename.
    int: (m?: string) => withCheck((n) => (Number.isInteger(n) ? null : fail(m ?? "Must be a whole number", "int"))),
    min: (limit: number, m?: string) => withCheck((n) => (n < limit ? fail(m ?? `Must be at least ${limit}`, "min") : null)),
    max: (limit: number, m?: string) => withCheck((n) => (n > limit ? fail(m ?? `Must be at most ${limit}`, "max") : null)),
    positive: (m?: string) => withCheck((n) => (n > 0 ? null : fail(m ?? "Must be positive", "positive"))),
    nonnegative: (m?: string) => withCheck((n) => (n >= 0 ? null : fail(m ?? "Must be zero or greater", "nonnegative"))),
  }) as NumberValidator;
}

// ---------------------------------------------------------------------------
// boolean (checkbox semantics), enum, literal
// ---------------------------------------------------------------------------

const TRUTHY = new Set(["true", "on", "1", "yes"]);

function booleanType(): Validator<boolean> {
  // Never errors: an absent checkbox is `false`, a present one is `true`.
  return build<boolean>((input) => {
    if (typeof input === "boolean") return { ok: true, value: input };
    if (input === undefined || input === null) return { ok: true, value: false };
    return { ok: true, value: TRUTHY.has(String(input).toLowerCase()) };
  });
}

function enumType<T extends string>(values: readonly T[], message?: string): Validator<T> {
  return build<T>((input, path) => {
    const s = input == null ? "" : String(input);
    return values.includes(s as T)
      ? { ok: true, value: s as T }
      : issue(path, message ?? `Must be one of: ${values.join(", ")}`, "enum");
  });
}

function literalType<T extends string | number | boolean>(value: T, message?: string): Validator<T> {
  return build<T>((input, path) =>
    input === value ? { ok: true, value } : issue(path, message ?? `Must be ${JSON.stringify(value)}`, "literal"),
  );
}

// ---------------------------------------------------------------------------
// array
// ---------------------------------------------------------------------------

export interface ArrayValidator<T> extends Validator<T[]> {
  min(n: number, message?: string): ArrayValidator<T>;
  max(n: number, message?: string): ArrayValidator<T>;
  nonempty(message?: string): ArrayValidator<T>;
}

function makeArray<T>(inner: Validator<T>, checks: ((a: unknown[]) => { message: string; code: string } | null)[]): ArrayValidator<T> {
  const run: Run<T[]> = (input, path) => {
    if (input === undefined || input === null) return issue(path, "Required", "required");
    // Lenient: a single form value (one repeated key) counts as a 1-element list.
    const arr = Array.isArray(input) ? input : [input];
    for (const chk of checks) {
      const fail = chk(arr);
      if (fail) return issue(path, fail.message, fail.code);
    }
    const out: T[] = [];
    const issues: FieldError[] = [];
    for (let i = 0; i < arr.length; i++) {
      const r = inner._run(arr[i], `${path}[${i}]`);
      if (r.ok) out.push(r.value);
      else issues.push(...r.issues);
    }
    return issues.length ? { ok: false, issues } : { ok: true, value: out };
  };
  const withCheck = (c: (a: unknown[]) => { message: string; code: string } | null) => makeArray(inner, [...checks, c]);
  const fail = (message: string, code: string) => ({ message, code });
  return Object.assign(build(run), {
    min: (n: number, m?: string) => withCheck((a) => (a.length < n ? fail(m ?? `Must have at least ${n} items`, "min") : null)),
    max: (n: number, m?: string) => withCheck((a) => (a.length > n ? fail(m ?? `Must have at most ${n} items`, "max") : null)),
    nonempty: (m?: string) => withCheck((a) => (a.length === 0 ? fail(m ?? "Must not be empty", "required") : null)),
  }) as ArrayValidator<T>;
}

// ---------------------------------------------------------------------------
// object
// ---------------------------------------------------------------------------

type Shape = Record<string, Validator<any>>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
export type ObjectOutput<S extends Shape> = Simplify<
  { [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> } & {
    [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]>;
  }
>;

export interface ObjectValidator<S extends Shape> extends Validator<ObjectOutput<S>> {
  /** Every field becomes optional (like a PATCH body). */
  partial(): ObjectValidator<Shape>;
  /** Reject unknown keys instead of ignoring them. */
  strict(message?: string): ObjectValidator<S>;
  readonly shape: S;
}

function makeObject<S extends Shape>(shape: S, opts: { strict?: string | false }): ObjectValidator<S> {
  const run: Run<ObjectOutput<S>> = (input, path) => {
    if (input === undefined || input === null) return issue(path, "Required", "required");
    if (typeof input !== "object" || Array.isArray(input)) return issue(path, "Must be an object", "type");
    const rec = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: FieldError[] = [];
    for (const key of Object.keys(shape)) {
      const childPath = path ? `${path}.${key}` : key;
      const r = shape[key]._run(rec[key], childPath);
      if (r.ok) {
        if (r.value !== undefined || key in rec) out[key] = r.value;
      } else issues.push(...r.issues);
    }
    if (opts.strict) {
      for (const key of Object.keys(rec)) {
        if (!(key in shape)) issues.push({ path: path ? `${path}.${key}` : key, message: opts.strict === true ? "Unknown field" : opts.strict, code: "unknown" });
      }
    }
    return issues.length ? { ok: false, issues } : { ok: true, value: out as ObjectOutput<S> };
  };
  return Object.assign(build(run), {
    shape,
    partial() {
      const next: Shape = {};
      for (const key of Object.keys(shape)) next[key] = shape[key].optional();
      return makeObject(next, opts);
    },
    strict(message?: string) {
      return makeObject(shape, { strict: message ?? true });
    },
  }) as ObjectValidator<S>;
}

// ---------------------------------------------------------------------------
// public schema namespace — `v.string()`, `v.object({...})`, …  (zod-shaped)
// ---------------------------------------------------------------------------

export const v = {
  string: (opts?: StringOptions): StringValidator => makeString([], [], opts ?? {}),
  number: (opts?: NumberOptions): NumberValidator => makeNumber([], opts ?? {}),
  boolean: booleanType,
  enum: enumType,
  literal: literalType,
  array: <T>(inner: Validator<T>): ArrayValidator<T> => makeArray(inner, []),
  object: <S extends Shape>(shape: S): ObjectValidator<S> => makeObject(shape, { strict: false }),
};

// ---------------------------------------------------------------------------
// Request / FormData helpers
// ---------------------------------------------------------------------------

/** Flatten a FormData / URLSearchParams into a plain object. Repeated keys
 *  collapse into arrays; File values pass through untouched. */
export function formToObject(fd: FormData | URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const iter = (fd as any).entries ? (fd as any).entries() : [];
  for (const [k, val] of iter) {
    if (k in out) {
      const cur = out[k];
      if (Array.isArray(cur)) cur.push(val);
      else out[k] = [cur, val];
    } else out[k] = val;
  }
  return out;
}

/** Normalise any server-action input into a plain object ready to validate:
 *  a `Request` (JSON or form-encoded body), a `FormData`, a `URLSearchParams`,
 *  or an already-plain object. Multipart bodies that `Request.formData()`
 *  cannot parse degrade to `{}` rather than throwing. */
export async function readInput(input: unknown): Promise<Record<string, unknown>> {
  if (input == null) return {};
  if (typeof FormData !== "undefined" && input instanceof FormData) return formToObject(input);
  if (typeof URLSearchParams !== "undefined" && input instanceof URLSearchParams) return formToObject(input);
  if (typeof Request !== "undefined" && input instanceof Request) {
    const ct = input.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        return (await input.json()) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    try {
      return formToObject(await input.formData());
    } catch {
      /* not form-encodable (e.g. multipart the runtime rejects) */
    }
    try {
      return (await input.json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof input === "object") return input as Record<string, unknown>;
  return {};
}

/**
 * The one-call server-action helper: read the request body (FormData or JSON),
 * validate it against `schema`, and return a typed {@link ValidationResult}.
 *
 *   const r = await validate(request, Signup);
 *   if (!r.ok) return { ok: false, errors: errorsByField(r.errors) };
 *   const user = r.data;   // typed & coerced
 */
export async function validate<S extends Validator<any>>(
  input: unknown,
  schema: S,
): Promise<ValidationResult<Infer<S>>> {
  const obj = await readInput(input);
  return schema.safeParse(obj) as ValidationResult<Infer<S>>;
}

/** Collapse an error list into `{ field: firstMessage }` — the shape a form
 *  page renders next to each input. Later duplicates for a field are dropped. */
export function errorsByField(errors: FieldError[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of errors ?? []) if (!(e.path in out)) out[e.path] = e.message;
  return out;
}

/** Every message per field (use when a field can report multiple problems). */
export function errorsByFieldAll(errors: FieldError[] | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of errors ?? []) (out[e.path] ??= []).push(e.message);
  return out;
}

/** Raw string values keyed by field — for re-populating a rejected form so the
 *  user doesn't lose their typing. */
export function stringValues(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(raw)) {
    const val = raw[k];
    out[k] = Array.isArray(val) ? val.map(String).join(", ") : val == null ? "" : String(val);
  }
  return out;
}

/**
 * Wrap a server action so it only runs once the body validates. On failure it
 * short-circuits to a re-render payload (`{ ok:false, errors, values }`); on
 * success your handler receives the typed, coerced data.
 *
 *   export const action = validated(Signup, async (data, { request }) => {
 *     await createUser(data);                    // data is Signup, fully typed
 *     return new Response(null, { status: 303, headers: { Location: "/welcome" } });
 *   });
 */
export function validated<S extends Validator<any>, R>(
  schema: S,
  handler: (data: Infer<S>, ctx: { request: Request }) => R | Promise<R>,
): (ctx: { request: Request }) => Promise<R | { ok: false; errors: Record<string, string>; issues: FieldError[]; values: Record<string, string> }> {
  return async (ctx) => {
    const raw = await readInput(ctx.request);
    const result = schema.safeParse(raw);
    if (!result.ok) return { ok: false, errors: errorsByField(result.errors), issues: result.errors, values: stringValues(raw) };
    return handler(result.data as Infer<S>, ctx);
  };
}
