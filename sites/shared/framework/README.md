# @bext-stack/framework

**PRISM** — bext's zero-config JSX-to-string SSR engine.

JSX compiles to `h()` string-builder calls (no React, no VDOM).
Components are `(props) => string`. Async components return
`Promise<string>` or `AsyncIterable<string>`. Suspense + streaming
work out of the box.

```tsx
// tsconfig.json
// { "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "@bext-stack/framework" } }

// page.tsx — sync, returns a string
export default function Home() {
  return <h1>Hello {props.name}</h1>;
}

// async page — returns Promise<string>
export default async function User({ id }: { id: string }) {
  const u = await fetch(`/api/u/${id}`).then((r) => r.json());
  return <p>{u.name}</p>;
}

// streaming page with Suspense
import { Suspense } from "@bext-stack/framework/streaming";

export default function Page() {
  return (
    <>
      <h1>Static shell ships first</h1>
      <Suspense fallback={<p>Loading…</p>}>
        <SlowPart />
      </Suspense>
    </>
  );
}
```

## Entry points

| Subpath | Purpose |
|---|---|
| `@bext-stack/framework/jsx-runtime` | JSX automatic runtime — `{ jsx, jsxs, Fragment }` |
| `@bext-stack/framework/streaming` | `Suspense`, `renderToStream`, `SUSPENSE_CLIENT_RUNTIME` |
| `@bext-stack/framework/form` | `Form`, `FORM_CLIENT_RUNTIME` for server-action forms with PE |
| `@bext-stack/framework/multipart` | `parseMultipart`, `MultipartFormData`, `MultipartFile` — V8-runnable parser for `multipart/form-data` |
| `@bext-stack/framework/multipart-streaming` | `parseMultipartFromFile` — chunk-based parser for very-large multipart bodies; reads via V8 bridge natives |
| `@bext-stack/framework/signals` | `signal`, `computed`, `effect`, `batch`, `signalsIsland` |
| `@bext-stack/framework/signals/jsx-runtime` | JSX adapter for `"use signals"` files (with resumability markers) |
| `@bext-stack/framework/signals/hydrate` | `hydrateSignalsIsland` — pick up server DOM + attach reactivity |
| `@bext-stack/framework/island` | `island(name, props, fallback)` for client-hydrated components |
| `@bext-stack/framework/client` | `clientRuntime`, `clientRuntimeBody` (SPA navigation, prefetch, view-transitions) |
| `@bext-stack/framework/serve` | Standalone Bun server (alternative to bext-server's PRISM dispatcher) |
| `@bext-stack/framework/react` | React SSR adapter (peer dep: `react`, `react-dom`) |
| `@bext-stack/framework/solid` | Solid SSR adapter (peer dep: `solid-js`) |
| `@bext-stack/framework/preact` | Preact SSR adapter (peer dep: `preact`, `preact-render-to-string`) |
| `@bext-stack/framework/next/*` | Next.js compat shims (`next/link`, `next/image`, `next/navigation`, …) |

## Source-form distribution

This package ships TypeScript source files (`src/**/*.ts`). The intended
runtime is bext's PRISM dispatcher, which compiles `.ts` per request via
`tsc-rs`. Vite, esbuild, Bun, and Deno (with `npm:` specifiers) all read
the source directly. There is no `dist/` build — the package has no
build step.

For consumers that need pre-compiled JS + `.d.ts`, run `tsc` against
`src/` with your own settings.

## Server-action forms (progressive enhancement)

Define an action — a "use server" file under `src/actions/`:

```ts
// src/actions/subscribe.ts
"use server";
export async function subscribe(formData: FormData) {
  const email = formData.get("email");
  await db.insert({ email });
  return { ok: true };
}
```

Use it in any page. Three escalating ergonomics, same wire format:

```tsx
// 1. Plain HTML — works without JS, no framework imports.
<form action="/_bext/action/subscribe" method="POST">
  <input name="email" type="email" required />
  <button>Subscribe</button>
</form>

// 2. <Form> helper — same HTML, less typing.
import { Form } from "@bext-stack/framework";
<Form name="subscribe">
  <input name="email" type="email" required />
  <button>Subscribe</button>
</Form>

// 3. Add FORM_CLIENT_RUNTIME once in your layout for in-place updates.
import { FORM_CLIENT_RUNTIME } from "@bext-stack/framework";
<body>
  {/* …page… */}
  <div dangerouslySetInnerHTML={{ __html: FORM_CLIENT_RUNTIME }} />
</body>
```

### Wire protocol

- Form submit (no JS) → server detects form-encoded `content-type` and
  redirects 303 to the `Referer`. The action's side effects are visible
  on the next page render.
- With `FORM_CLIENT_RUNTIME` loaded → submit is intercepted, posted via
  `fetch` with header `x-bext-form: 1`. Server skips the 303 and returns
  JSON. The runtime dispatches a `bext:result` `CustomEvent` on the form
  with `detail = { ok, status, result }`. Listeners can update the DOM:

```js
document.querySelector('form[data-bext-form="subscribe"]')
  .addEventListener("bext:result", (e) => {
    if (e.detail.ok) showToast("Subscribed!");
  });
```

A `bext:pending` event fires before the request, useful for spinners.

### Returning Response vs. plain values

- Return a `Response` (e.g. `redirect("/thanks")`) → the framework hands
  it back verbatim. Use this for explicit redirects after success.
- Return a plain object → JSON for the fetch path; 303-back-to-Referer
  for the no-JS path. The same action serves both.

### Action input by content-type

The action receives a parsed input as its first argument. The
dispatcher selects by `Content-Type`:

| Content-Type | Argument shape | Notes |
|---|---|---|
| `application/json` | parsed JS value | one arg |
| `application/x-www-form-urlencoded` | `URLSearchParams` (FormData-compatible) | `.get`, `.getAll`, `.has`, iterable |
| `multipart/form-data` | `MultipartFormData` (FormData-compatible) | files appear as `MultipartFile { name, type, size, bytes(), text(), arrayBuffer() }` |
| `text/*` and others | raw string | best-effort |

Multipart is parsed by `@bext-stack/framework/multipart`. Default
body cap is 10 MB; raise it per-action with a directive comment:

```ts
"use server";
// @bext:max-body 100mb
export async function uploadVideo(form: FormData) { … }
```

Recognized units: bare bytes, `kb`, `mb`, `gb` (case-insensitive,
optional whitespace before unit). Invalid directives are ignored. The
cap is checked during the body drain — oversize requests return 413
without ever reaching the action.

JSON-RPC callers passing `{name, args: [...]}` skip body parsing
entirely (legacy path).

### Status by pipeline

The 303 fallback is wired in three places, one per dispatch path:

| Pipeline | Where | PE 303 | Body forwarding |
|---|---|---|---|
| Dev (`framework/serve.ts` Bun server) | `serve.ts` action branch | ✓ | ✓ FormData |
| Production `__fetch` JSC bundle (`build.ts`) | bundle `__fetch` action branch | ✓ | ✓ parsed by content-type |
| bext-server PRISM-native (Rust) | `prism.rs:handle_action_request` | ✓ | ✓ parsed by content-type |

All three pipelines parse the request body by content-type before
calling the action, so the same action signature serves browser form
posts, fetch/JSON callers, and JSON-RPC `{args}` callers:

- `application/json` → `JSON.parse(body)`, single object arg
- `application/x-www-form-urlencoded` → `URLSearchParams` (FormData-shaped: `.get`, `.getAll`, `.has`, iterable)
- `text/*` or anything else → raw string
- `multipart/form-data` is not yet supported — POST upload endpoints should target a dedicated `/api/*` route until multipart parsing lands.

Body cap is 10 MB (`MAX_BODY_BYTES`); larger requests return 413.

PRISM middleware now also receives the body — the shim exposes
Web-Request-shaped methods on `req`:

```ts
export default async function middleware(req, ctx) {
  if (req.method === "POST" && ctx.path.startsWith("/api/auth/")) {
    const form = await req.formData(); // urlencoded only at this layer
    if (!form.get("token")) {
      return { status: 403, headers: [["content-type", "text/plain"]], body: "missing token" };
    }
  }
}
```

`req.text()`, `req.json()`, `req.arrayBuffer()` work; `req.formData()`
handles `application/x-www-form-urlencoded`. Multipart goes through
the action handler (it has the bigger parser bundled).

## Signals runtime — fine-grained reactivity, resumability, no React

bext ships its own signals runtime alongside the React island path.
A signals island has these properties vs a `"use client"` React island:

- No virtual DOM. The server-rendered HTML stays as-is on the client;
  the hydrator walks markers and attaches per-binding effects.
- No re-render. Click → signal write → only the bound text/attr nodes
  update. Other DOM doesn't move.
- No React in the bundle. The runtime is signals/core (~3KB) +
  signals/hydrate (~2KB) + the component code.
- Resumability. The component runs once on the server (rendering with
  markers), once on the client (rebuilding the reactive graph). The
  client never re-renders; it picks up the existing DOM.

### Authoring a signals island

```tsx
// src/components/SignalCounter.tsx
"use signals";
/** @jsxImportSource @bext-stack/framework/signals */

import { signal, computed } from "@bext-stack/framework/signals";

export default function SignalCounter(props: { initial?: number }) {
  const count = signal(props.initial ?? 0);
  const doubled = computed(() => count.value * 2);
  return (
    <div>
      <p>Count: {count.value} (×2 = {doubled.value})</p>
      <button onClick={() => { count.value++; }}>+1</button>
    </div>
  );
}
```

The `"use signals"` directive opts the file into the signals runtime;
the JSX pragma routes JSX through the signals adapter (so reactive
markers and event-handler indices get embedded). No tsconfig changes.

### Compiler pass — automatic reactive wrapping

The Rust pass at `crates/bext-core/src/transform/prism_signals.rs`
auto-wraps `<sig>.value` reads inside JSX expression containers:

```tsx
<p>Count: {count.value}</p>
// becomes, before tsc-rs sees it:
<p>Count: {(() => count.value)}</p>
```

This is the difference between "value materialized once at render time"
(broken) and "thunk the runtime can re-evaluate on every signal tick"
(reactive). The pass fires only for files using
`@bext-stack/framework/signals` as their jsxImportSource AND starting
with `"use signals"`. Disable with `BEXT_PRISM_COMPILE=0`.

The pass is conservative — it only wraps `<knownSignal>.value` reads in
JSX containers. Anything else (computed expressions, function calls
that depend on signals) the developer wraps manually with `() => …`.

### Resumability protocol

Server emits HTML with paired comment markers around reactive text and
indexed `data-bs-*` attributes on event handlers and reactive attrs:

```html
<bext-island data-component="SignalCounter" data-runtime="signals" data-props='{"initial":5}'>
  <div>
    <p>Count: <!--bs0-->5<!--/bs0--> (×2 = <!--bs1-->10<!--/bs1-->)</p>
    <button data-bs-onclick="0">+1</button>
  </div>
</bext-island>
```

Client `hydrateSignalsIsland(root, Component, props)`:
1. Re-runs `Component(props)` to rebuild signals + handlers + bindings.
   IDs are allocated in the same order the server saw, so they match.
2. For each `data-bs-on<event>="N"` element → adds the captured handler.
3. For each `data-bs-attr<N>` element → installs an effect that updates
   the attribute when the bound signal changes.
4. For each `<!--bsN-->...<!--/bsN-->` pair → swaps in a fresh Text
   node bound via effect to the signal/thunk.

After hydration the DOM is clean — `data-bs-*` attributes and marker
comments are removed during binding.

### Reactive lists

`<List each={signal} render={(item, i) => …}>` (or pass the render
function as a child) emits a paired list-marker range around the
items; the hydrator installs an effect that on each `each` change
patches the DOM and re-attaches per-item handlers/bindings.

Two reconciliation modes:

```tsx
"use signals";
/** @jsxImportSource @bext-stack/framework/signals */
import { signal, List } from "@bext-stack/framework/signals";

// Unkeyed: full rebuild on every change.
<List each={items} render={(text) => <li>{text}</li>} />

// Keyed: only changed items move/render — unchanged items keep their
// DOM (focus, animations, scroll position survive).
<List
  each={items}
  key={(item) => item.id}
  render={(item) => <li>{item.text}</li>}
/>
```

How keyed reconciliation works:
- Server emits per-item open/close markers `<!--bsI{listId}:{key}-->`
  around each item's HTML, and each item renders in its own subcontext
  so handler IDs are local per-item.
- Keys are sanitized to `[A-Za-z0-9_:.]` for HTML-comment safety; `-`,
  `/`, and other chars become `_`. Pick keys mindful of this.
- Hydrator on first run walks markers + re-runs each item's render in
  a fresh client ctx, populating `Map<key, ItemState>`. Per-item
  reactivity is attached scoped to that item's range.
- On `each` change: removed keys → drop DOM + run disposers; new keys
  → render in fresh ctx and `insertBefore` at the right spot;
  unchanged keys → moved (not re-rendered) via `insertBefore`.

Nested `<List>` works — keyed-in-keyed, unkeyed-in-keyed, keyed-in-
unkeyed all supported. Per-item disposers cascade, so disposing the
outer island tears down every nested list inside it.

Keyed reconciliation uses the standard LIS algorithm: items whose old
positions form the longest increasing subsequence of new positions
keep their DOM (no `insertBefore` calls). Same identity, focus,
animations, scroll. Identity-only updates (re-assigning the same
array) cost zero DOM moves. Reverse / random-shuffle workloads fall
back to O(n) moves, which matches Vue 3 / Solid / Inferno.

### Status

| Layer | What it ships |
|---|---|
| `signal`, `computed`, `effect`, `batch`, `untracked` | full reactive graph with branch-pruning |
| JSX adapter (server + client) | resumability markers, handler indexing, dual-target |
| `<List>` component | reactive arrays — unkeyed (full rebuild) or keyed (move + diff with identity preservation) |
| Hydrator | TreeWalker-free DOM walk; works on linkedom/happy-dom/real DOM |
| Build pipeline (prod `build.ts`) | discovers `"use signals"`, emits per-island bundles |
| Build pipeline (dev `serve.ts`) | parallel signals discovery, separate manifest, runtime-aware loader |
| bext-server (Rust) | `discover_signal_islands`, `compile_signal_island`, signals-aware `serve_island` wrapper |
| Compiler pass | `prism_signals.rs` auto-wraps any JSX expression containing a `<sig>.value` read |
| Tests | TS: core 18 / jsx 24 / hydrate 7 / list 8 / list-keyed 9 / list-nested 6 / list-lis 13 / integration 4 / form 9 / streaming 16 / multipart 19 / multipart-streaming 9 — **142 / 142**. Rust: prism_signals 13 / action_fields 12 / bext-server prism 41 / max-body directive 7 — V8 streaming bridge + spool-to-disk + 50 MB e2e + /signals demo route + dev field-mismatch warnings all green. |

## Build-time form/action field cross-check

`bext_core::transform::action_fields::check_action_fields(app_dir)` walks
the site tree and reports actions that read fields not declared in any
matching form. Catches typos before they reach production:

```tsx
// src/app/page.tsx
<Form name="subscribe">
  <input name="email" />
  <input name="newsletter" />
</Form>
```

```ts
// src/actions/subscribe.ts
"use server";
export async function subscribe(form: FormData) {
  return form.get("emial");  // ← caught at build time
}
```

The check is regex-based (no AST), so it tolerates dynamic patterns
without false positives — `form.get(varName)`, `form.get(\`x-${id}\`)`,
and other non-string-literal keys are skipped. Actions with no
matching form (typical for RPC-only actions called via fetch) are
also skipped. Output is a `Vec<FieldMismatch>` with the action name,
the missing field, and the page where the form is declared so an IDE
can jump to either side.

In dev, the bext-server PRISM dispatcher calls the checker on every
action request and emits `tracing::warn` entries — dedup'd per
`(app_root, action, field)` so each unique typo logs at most once per
process. Fix the typo, restart, the warning's gone.

## Streaming uploads

Multipart bodies above ~1 MB (configurable via `BEXT_PRISM_SPOOL_THRESHOLD`)
spool to a tempfile under `/tmp/bext-stream-*` rather than buffering
in memory. The dispatcher passes `body_path` (not `body`) in the V8
envelope; the action wrapper detects this, calls the streaming parser
in `@bext-stack/framework/multipart-streaming`, which walks the file
in 64 KiB chunks via two V8 native callbacks bound from Rust:

- `__bextReadChunk(path, offset, length) → Uint8Array | null` — reads
  bytes on demand. Path-confined to `/tmp/bext-stream-*` (the bridge
  rejects anything else, so V8 cannot read arbitrary files).
- `__bextFileSize(path) → number` — file size, used to terminate
  boundary scans cleanly at EOF.

Memory bound during parse is parser state + one chunk + needle
overlap — independent of upload size. File parts are returned as
`MultipartFile` objects whose `.bytes()` / `.text()` / `.arrayBuffer()`
are async (matches Web File) and read lazily; the parser itself
never materializes a whole file part.

50 MB and 1 GB uploads both go through the same path, with constant
parser memory. The tempfile is auto-deleted via `tempfile::NamedTempFile`'s
`Drop` impl after dispatch returns. A regression test
(`dispatch_streaming_multipart_action_via_v8`) drives a 50 MB upload
end-to-end and asserts the action sees correct file metadata + content.

## Runtime contract

Every component returns a `Renderable`:

```ts
export type Renderable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Promise<Renderable>
  | AsyncIterable<Renderable>
  | Renderable[];
```

The `h()` factory (in `jsx.ts`) returns a `string` when the entire subtree
resolves synchronously, an `AsyncIterable<string>` as soon as anything
async appears in the tree. Hosts iterate the result directly into the
HTTP response body — no buffering for streaming use cases.

## License

MIT
