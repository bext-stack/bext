// testkit.ts — model factories + a route test client for PRISM apps.
//
// The app-logic testing ergonomics bext was missing (Laravel factories + the
// HTTP test client): `defineFactory` builds seeded, overridable test data, and
// `testRoute` invokes a route's `loader`/`action` with a synthesized request so
// you can assert on the result — all in plain `bun test`, no server, no DOM.
// (For component/DOM testing — render + query + interact — use the separate
// `@bext-stack/framework/testing`, which pulls in happy-dom.)
//
//   const userFactory = defineFactory((n) => ({
//     id: `u${n}`, email: `user${n}@example.com`, role: cycle("admin", "member")(n),
//   }));
//   const users = userFactory.makeMany(3);              // 3 seeded users
//   const admin = userFactory.make({ role: "admin" });  // one, overridden
//
//   import * as signup from "../app/signup/page";
//   const r = testRoute(signup);
//   const bad = await r.post({ email: "nope" });        // calls the action
//   expect(bad.ok).toBe(false);
//   const data = await r.get({ ref: "promo" });         // calls the loader

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export interface Factory<T> {
  /** Build one, applying `overrides` last. */
  make(overrides?: Partial<T>): T;
  /** Build `count`, with static or per-index overrides. */
  makeMany(count: number, overrides?: Partial<T> | ((i: number) => Partial<T>)): T[];
  /** Derive a variant factory that layers a transform on every build (Laravel factory states). */
  state(transform: (attrs: T, n: number) => Partial<T>): Factory<T>;
  /** Reset the sequence counter to 0. */
  reset(): void;
}

/** Define a factory from a builder that receives an incrementing sequence `n`
 *  (use it for unique fields). Each `make()` advances the sequence. */
export function defineFactory<T extends Record<string, any>>(builder: (n: number) => T): Factory<T> {
  let seq = 0;
  const factory: Factory<T> = {
    make(overrides) {
      return { ...builder(seq++), ...overrides };
    },
    makeMany(count, overrides) {
      return Array.from({ length: count }, (_, i) => ({
        ...builder(seq++),
        ...(typeof overrides === "function" ? overrides(i) : overrides),
      }));
    },
    state(transform) {
      return defineFactory((n) => {
        const attrs = builder(n);
        return { ...attrs, ...transform(attrs, n) };
      });
    },
    reset() {
      seq = 0;
    },
  };
  return factory;
}

/** Cycle through values by sequence index — `role: cycle("admin", "member")(n)`. */
export function cycle<T>(...values: T[]): (n: number) => T {
  return (n) => values[((n % values.length) + values.length) % values.length];
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

/** Build a `FormData` from a plain object (arrays → repeated fields). */
export function formData(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const key of Object.keys(fields)) {
    const v = fields[key];
    for (const item of Array.isArray(v) ? v : [v]) fd.append(key, item);
  }
  return fd;
}

/** A `POST` `Request` with a form-encoded body. */
export function formRequest(url: string, fields: Record<string, string | string[]>, method: "POST" | "PUT" | "PATCH" = "POST"): Request {
  const body = new URLSearchParams();
  for (const key of Object.keys(fields)) {
    const v = fields[key];
    for (const item of Array.isArray(v) ? v : [v]) body.append(key, item);
  }
  return new Request(url, { method, headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
}

/** A `Request` with a JSON body. */
export function jsonRequest(url: string, body: unknown, method: "POST" | "PUT" | "PATCH" = "POST"): Request {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// Route test client
// ---------------------------------------------------------------------------

export interface RouteModule<L = any, A = any> {
  loader?: (args: { request: Request }) => L | Promise<L>;
  action?: (args: { request: Request }) => A | Promise<A>;
}

export interface RouteTester<L, A> {
  /** Call the route's `loader` with a `GET` request (+ optional query). */
  get(query?: Record<string, string>): Promise<L>;
  /** Call the route's `action` with a form-encoded `POST`. */
  post(fields?: Record<string, string | string[]>): Promise<A>;
  /** Call the route's `action` with a JSON `POST`. */
  postJson(body: unknown): Promise<A>;
  /** Call the route with an explicit `Request` (custom headers, cookies, …). */
  request(request: Request): Promise<A | L>;
}

/** Wrap a route module (its `loader`/`action` exports) for testing. */
export function testRoute<L = any, A = any>(mod: RouteModule<L, A>, opts?: { url?: string }): RouteTester<L, A> {
  const base = opts?.url ?? "https://test.local/";
  return {
    async get(query) {
      if (!mod.loader) throw new Error("testRoute.get: the route has no `loader` export");
      const url = new URL(base);
      if (query) for (const key of Object.keys(query)) url.searchParams.set(key, query[key]);
      return mod.loader({ request: new Request(url.toString()) });
    },
    async post(fields) {
      if (!mod.action) throw new Error("testRoute.post: the route has no `action` export");
      return mod.action({ request: formRequest(base, fields ?? {}) });
    },
    async postJson(body) {
      if (!mod.action) throw new Error("testRoute.postJson: the route has no `action` export");
      return mod.action({ request: jsonRequest(base, body) });
    },
    async request(request) {
      const handler = request.method === "GET" ? mod.loader : mod.action;
      if (!handler) throw new Error(`testRoute.request: the route has no ${request.method === "GET" ? "loader" : "action"} export`);
      return handler({ request });
    },
  };
}
