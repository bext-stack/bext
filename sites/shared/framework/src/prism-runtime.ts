// PRISM route lifecycle, expressed as a real TS module rather than a
// Rust string-template. The bext-server wrapper imports `runRoute` and
// hands it the page + layouts + (optional) loader/action + the
// transport envelope; everything that used to live as `format!()`-
// substituted JS in the wrapper template lives here.
//
// Wire contract with the V8 host
//
//   propsJson   →  RouteEnvelope (parsed by the wrapper)
//   return      →  JSON.stringify(RouteResult)
//
// The Rust dispatcher decodes `RouteResult` and produces an actix
// HttpResponse. The two valid shapes:
//
//   { kind: "html", body, hasIslands }        — render the page body as text/html
//   { kind: "response", status, headers, body } — pass through the user's Response
//
// Two execution modes:
//
//   - Buffered (default): `body` is the full HTML, drained from
//     `renderToStream` into a single string. The host returns
//     `Promise<string>` and the dispatcher emits a fixed-length
//     response.
//
//   - Streaming: when `globalThis.__bextPrismChunkSink` is installed
//     by the host wrapper, each chunk yielded by `renderToStream` is
//     handed to the sink immediately. The returned `body` is empty
//     (the bytes already went through the sink). Loader/action that
//     return a `Response` route through `__bextPrismResponseSink` so
//     the host can build a proper HttpResponse instead of opening a
//     chunked stream.

import { renderTree, collectRender, Suspense, SUSPENSE_CLIENT_RUNTIME } from "./streaming";
import { getInspectScript } from "./inspect";
import type { Renderable } from "./jsx";
import { stripSentinel } from "./jsx";

// True when the route envelope carries `?bext_inspect=1`. Detected from
// searchParams so we don't re-parse the URL — the dispatcher already
// pre-parsed it. See ./inspect.ts for the higher-level rationale.
function envelopeIsInspect(envelope: RouteEnvelope): boolean {
  const v = envelope?.searchParams?.bext_inspect;
  if (v === "1") return true;
  if (Array.isArray(v) && v[0] === "1") return true;
  return false;
}

export type RouteEnvelope = {
  params: Record<string, string>;
  searchParams: Record<string, string | string[]>;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  };
};

export type LoaderArgs = {
  request: Request;
  params: Record<string, string>;
};

export type ActionArgs = LoaderArgs;

export type RouteResult =
  | { kind: "html"; body: string; hasIslands: boolean }
  | {
      kind: "response";
      status: number;
      headers: Array<[string, string]>;
      body: string;
      // "base64" when the Response carried BYTES (Uint8Array/ArrayBuffer):
      // a JS string can't cross the V8→Rust boundary with raw bytes, so
      // binary bodies ship base64 and the host decodes right before the
      // HTTP response (ssr_pipeline/prism.rs decode_envelope_body).
      body_encoding?: "base64";
    };

export type Layout = (props: { children?: any }) => Renderable;

/** Arguments handed to every `generateMetadata` (layouts and page). `route`
 *  and `status` are a PRISM extension over Next.js: a layout decides robots
 *  from the path and from a 404/500, which Next.js expresses with separate
 *  segments. `status` is 200 for a normal render, 404 on the not-found.tsx
 *  path, 500 on the error.tsx path. */
export type MetadataArgs = {
  params: Record<string, string>;
  searchParams: Record<string, string | string[]>;
  route: { pathname: string };
  status: number;
};

/** One route level's metadata exports, as the wrapper imported them. */
export type MetadataSource = {
  metadata?: Record<string, unknown>;
  generateMetadata?: (args: MetadataArgs) => Record<string, unknown> | Promise<Record<string, unknown>>;
} | null | undefined;
export type Page = (props: any) => Renderable;
export type Loader = (args: LoaderArgs) => unknown | Promise<unknown>;
export type Action = (args: ActionArgs) => unknown | Promise<unknown>;

export type RunRouteArgs = {
  Page: Page;
  layouts: Layout[];
  loader?: Loader;
  action?: Action;
  /** Co-located error.tsx — wraps the page tree; on render error,
   *  swaps in this component with the thrown error as a prop. */
  errorBoundary?: (props: { error: Error; reset?: () => void; route?: { pathname?: string } }) => Renderable;
  /** Co-located not-found.tsx — substituted for the response body when
   *  loader/action throws a 404 Response. Wrapped in the layouts so
   *  the document shell stays intact. The request `route` (pathname) is
   *  passed alongside `params` so the component can render locale-correct. */
  notFoundComponent?: (props: { params?: Record<string, string>; route?: { pathname?: string } }) => Renderable;
  /** Co-located template.tsx — wraps the page (inside layouts). Same
   *  shape as a layout but semantically remounts on each navigation. */
  templateComponent?: Layout;
  /** Co-located loading.tsx — Suspense fallback for async pages. Receives
   *  the request `route` (pathname) so the fallback can render locale-correct. */
  loadingComponent?: (props?: { route?: { pathname?: string } }) => Renderable;
  /** Static `metadata` export — { title, description, openGraph, ... }.
   *  Spliced into <head> as <title>/<meta>/<link> tags before the
   *  rendered HTML is sent. */
  staticMetadata?: Record<string, unknown>;
  /** Async `generateMetadata({ params, searchParams, route, status })`
   *  export. Called before page render; result spliced into <head> the same
   *  way. (`route`/`status` are additive, see MetadataArgs.) */
  generateMetadata?: (args: MetadataArgs) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Layout-level `metadata` / `generateMetadata` exports, aligned index by
   *  index with `layouts` (index 0 = root layout; a null/undefined entry =
   *  that layout exports neither). Merged root → deepest → page, Next.js
   *  style (see mergeMetadataLevels). The not-found and error paths render
   *  the layout levels alone. Absent = a wrapper that predates this field:
   *  only the page's metadata is used, as before. */
  layoutMetadata?: MetadataSource[];
  /** Auto-discovered Next.js metadata-file URLs (icon, apple-icon,
   *  opengraph-image, twitter-image). When the route's directory
   *  walk found a static metadata file, the dispatcher serves it at
   *  this URL and the runtime injects the appropriate <head> tag. */
  iconUrl?: string;
  appleIconUrl?: string;
  opengraphImageUrl?: string;
  twitterImageUrl?: string;
  /** Parallel-route slots: `<dir>/@<name>/page.tsx` siblings of the
   *  layout chain. Each slot's page is rendered independently and the
   *  resulting HTML string is passed to the deepest layout as a named
   *  prop alongside `children`. Layouts opt in by reading the slot
   *  prop (e.g. `({ children, modal }) => …`); layouts that don't
   *  read the prop just ignore it. */
  slots?: Record<string, Page>;
  envelope: RouteEnvelope;
  /** Loader/action `context` is reserved for future middleware-set
   *  values (auth claims, geo, A/B bucket). Pages don't see this. */
  context?: Record<string, unknown>;
  /** Inline script string the dispatcher injects when the rendered
   *  HTML contains any `<bext-island>` markers. The loader fetches
   *  `/islands/<name>.js` for each unique component referenced. */
  islandLoaderHtml?: string;
  /** Optional per-request streaming chunk sink. When the multiplex
   *  driver invokes `__bextPrismRender(envelope, sink)`, the wrapper
   *  threads `sink` through here so streaming chunks route via the
   *  closure (correct under shared cached contexts) instead of the
   *  process-global `__bextPrismChunkSink` (which races between
   *  concurrent streaming requests on the same isolate).
   *
   *  When `undefined`, the runtime falls back to the global — the
   *  legacy path used by non-multiplex callers and by the subprocess
   *  wire `STREAM_CHUNK` machinery. See
   *  `plan/v8-architecture-cleanup/08-streaming-multiplex.md`. */
  chunkSink?: (s: string) => void;
  /** The route's `export const dynamic`, as the wrapper's build-time analysis
   *  read it (`"force-dynamic" | "force-static" | "auto"`). Undefined when the
   *  route declares none or the wrapper predates this field. */
  dynamic?: string;
  /** The route's `export const revalidate` (`false` or seconds). Undefined when
   *  absent. */
  revalidate?: number | false;
};

/** Escape a string for use inside an HTML attribute. */
function escapeAttr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One `openGraph` / `twitter` image after normalisation. */
type MetaImage = {
  url: string;
  secureUrl?: string;
  type?: string;
  width?: string;
  height?: string;
  alt?: string;
};

/** Normalise the Next.js image shapes into a flat list, in declaration order.
 *  Accepts, for each of `image` and `images`: a URL string, a `URL`, an object
 *  `{ url, secureUrl?, type?, width?, height?, alt? }`, or an array of those.
 *  PRISM's historical singular `image: "…"` key is passed first so the
 *  single-string form renders exactly as before; `images` (Next.js) follows.
 *  Items without a URL are skipped, and an exact URL repeat is emitted
 *  once (a page setting both `image` and `images` to the same file). */
function normalizeMetaImages(image: unknown, images: unknown): MetaImage[] {
  const out: MetaImage[] = [];
  const seen = new Set<string>();
  const str = (v: unknown): string | undefined => {
    // A string is taken verbatim (even "": the singular form always emitted
    // whatever string it was given, and that output must not change).
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    if (typeof URL !== "undefined" && v instanceof URL) return v.toString();
    return undefined;
  };
  const add = (v: unknown): void => {
    if (v == null) return;
    let img: MetaImage | null = null;
    const direct = typeof v === "number" ? undefined : str(v);
    if (direct !== undefined) {
      img = { url: direct };
    } else if (typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const url = str(o.url);
      if (url !== undefined) {
        img = { url };
        const opt = (x: unknown): string | undefined => {
          const r = str(x);
          return r === "" ? undefined : r;
        };
        const secureUrl = opt(o.secureUrl);
        const type = opt(o.type);
        const width = opt(o.width);
        const height = opt(o.height);
        const alt = typeof o.alt === "string" ? o.alt : undefined;
        if (secureUrl !== undefined) img.secureUrl = secureUrl;
        if (type !== undefined) img.type = type;
        if (width !== undefined) img.width = width;
        if (height !== undefined) img.height = height;
        if (alt !== undefined) img.alt = alt;
      }
    }
    if (!img || seen.has(img.url)) return;
    seen.add(img.url);
    out.push(img);
  };
  const values = [image, images];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Array.isArray(v)) {
      for (let j = 0; j < v.length; j++) {
        add(v[j]);
      }
    } else {
      add(v);
    }
  }
  return out;
}

/** Emit one `<meta … base>` tag per image plus its structured properties, in the
 *  order Next.js uses (url, secure_url, type, width, height, alt). The
 *  structured tags follow their own image so crawlers attach them to it. */
function renderMetaImages(
  out: string[],
  attr: "property" | "name",
  base: string,
  images: MetaImage[],
  esc: (s: string) => string,
): void {
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    out.push(`<meta ${attr}="${base}" content="${esc(img.url)}">`);
    if (img.secureUrl !== undefined) out.push(`<meta ${attr}="${base}:secure_url" content="${esc(img.secureUrl)}">`);
    if (img.type !== undefined) out.push(`<meta ${attr}="${base}:type" content="${esc(img.type)}">`);
    if (img.width !== undefined) out.push(`<meta ${attr}="${base}:width" content="${esc(img.width)}">`);
    if (img.height !== undefined) out.push(`<meta ${attr}="${base}:height" content="${esc(img.height)}">`);
    if (img.alt !== undefined) out.push(`<meta ${attr}="${base}:alt" content="${esc(img.alt)}">`);
  }
}

/** Boolean robots directives, in the order Next.js emits them. */
const ROBOTS_FLAGS = ["noarchive", "nosnippet", "noimageindex", "nocache", "notranslate", "indexifembedded", "nositelinkssearchbox"];
/** Robots directives that carry a value (`key:value`), in Next.js order. */
const ROBOTS_VALUES = ["unavailable_after", "max-video-preview", "max-image-preview", "max-snippet"];

/** The `content` of a robots / googlebot meta, or null when no tag should be
 *  emitted. A string passes through verbatim; an object follows Next.js: only
 *  the keys that are set become directives (`index: false` → `noindex`, a
 *  true flag → its name, a value key → `key:value`), so `{}` emits nothing. */
function renderRobotsContent(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const d: string[] = [];
  if (typeof r.index === "boolean") d.push(r.index ? "index" : "noindex");
  if (typeof r.follow === "boolean") d.push(r.follow ? "follow" : "nofollow");
  for (let i = 0; i < ROBOTS_FLAGS.length; i++) {
    if (r[ROBOTS_FLAGS[i]] === true) d.push(ROBOTS_FLAGS[i]);
  }
  for (let i = 0; i < ROBOTS_VALUES.length; i++) {
    const x = r[ROBOTS_VALUES[i]];
    if (typeof x === "string" || (typeof x === "number" && Number.isFinite(x))) d.push(`${ROBOTS_VALUES[i]}:${x}`);
  }
  return d.length ? d.join(", ") : null;
}

/** Render a metadata object into <title>/<meta>/<link> HTML. Mirrors
 *  Next.js's metadata mapping for the common keys; everything else
 *  is silently ignored. The output is spliced into <head> by
 *  injectMetadata, which removes the layout's tags with the same keys. */
export function renderMetadataHtml(meta: Record<string, unknown>): string {
  if (!meta || typeof meta !== "object") return "";
  const esc = (s: string) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const out: string[] = [];
  if (typeof meta.title === "string") {
    out.push(`<title>${esc(meta.title)}</title>`);
  }
  if (typeof meta.description === "string") {
    out.push(`<meta name="description" content="${esc(meta.description)}">`);
  }
  if (Array.isArray(meta.keywords)) {
    out.push(`<meta name="keywords" content="${esc((meta.keywords as string[]).join(","))}">`);
  } else if (typeof meta.keywords === "string") {
    out.push(`<meta name="keywords" content="${esc(meta.keywords)}">`);
  }
  if (typeof meta.referrer === "string") {
    out.push(`<meta name="referrer" content="${esc(meta.referrer)}">`);
  }
  // robots: "noindex, follow" verbatim, or Next-style { index, follow, …,
  // googleBot } — only the directives actually set are emitted, and an object
  // that sets none emits no tag. `googleBot` becomes its own <meta name="googlebot">.
  const robots = meta.robots as unknown;
  const robotsContent = renderRobotsContent(robots);
  if (robotsContent !== null) out.push(`<meta name="robots" content="${esc(robotsContent)}">`);
  if (robots && typeof robots === "object") {
    const gb = renderRobotsContent((robots as Record<string, unknown>).googleBot);
    if (gb !== null) out.push(`<meta name="googlebot" content="${esc(gb)}">`);
  }
  const og = meta.openGraph as Record<string, unknown> | undefined;
  if (og && typeof og === "object") {
    if (typeof og.title === "string") out.push(`<meta property="og:title" content="${esc(og.title)}">`);
    if (typeof og.description === "string") out.push(`<meta property="og:description" content="${esc(og.description)}">`);
    if (typeof og.url === "string") out.push(`<meta property="og:url" content="${esc(og.url)}">`);
    if (typeof og.type === "string") out.push(`<meta property="og:type" content="${esc(og.type)}">`);
    if (typeof og.siteName === "string") out.push(`<meta property="og:site_name" content="${esc(og.siteName)}">`);
    if (typeof og.locale === "string") out.push(`<meta property="og:locale" content="${esc(og.locale)}">`);
    renderMetaImages(out, "property", "og:image", normalizeMetaImages(og.image, og.images), esc);
  }
  const tw = meta.twitter as Record<string, unknown> | undefined;
  if (tw && typeof tw === "object") {
    if (typeof tw.card === "string") out.push(`<meta name="twitter:card" content="${esc(tw.card)}">`);
    if (typeof tw.site === "string") out.push(`<meta name="twitter:site" content="${esc(tw.site)}">`);
    if (typeof tw.creator === "string") out.push(`<meta name="twitter:creator" content="${esc(tw.creator)}">`);
    if (typeof tw.title === "string") out.push(`<meta name="twitter:title" content="${esc(tw.title)}">`);
    if (typeof tw.description === "string") out.push(`<meta name="twitter:description" content="${esc(tw.description)}">`);
    renderMetaImages(out, "name", "twitter:image", normalizeMetaImages(tw.image, tw.images), esc);
  }
  // alternates: { canonical, languages } — Next.js-compatible. Emits a server-
  // side <link rel="canonical"> and per-hreflang <link rel="alternate">. Only
  // fires when a page sets `alternates`, so existing sites are unaffected.
  const alt = meta.alternates as Record<string, unknown> | undefined;
  if (alt && typeof alt === "object") {
    if (typeof alt.canonical === "string") out.push(`<link rel="canonical" href="${esc(alt.canonical)}">`);
    const langs = alt.languages as Record<string, unknown> | undefined;
    if (langs && typeof langs === "object") {
      for (const [hreflang, href] of Object.entries(langs)) {
        if (typeof href === "string") out.push(`<link rel="alternate" hreflang="${esc(hreflang)}" href="${esc(href)}">`);
      }
    }
  }
  return out.join("");
}

/** generateMetadata functions that already threw once — logged a single time
 *  so a broken export on a busy route doesn't flood the log. */
const __metaWarned = new WeakSet<object>();

/** One level's metadata: its static `metadata` object when present (static
 *  wins, as before, when a module exports both), else the awaited
 *  `generateMetadata(args)`. A throwing generateMetadata never 5xxes the
 *  page: the level is skipped and the failure logged once. */
async function resolveMetadataLevel(
  staticMeta: unknown,
  gen: unknown,
  args: MetadataArgs,
  label: string,
): Promise<Record<string, unknown> | null> {
  if (staticMeta && typeof staticMeta === "object") return staticMeta as Record<string, unknown>;
  if (typeof gen !== "function") return null;
  try {
    const r = await gen(args);
    return r && typeof r === "object" ? (r as Record<string, unknown>) : null;
  } catch (e: unknown) {
    if (!__metaWarned.has(gen)) {
      __metaWarned.add(gen);
      try {
        console.warn(`[prism] ${label} generateMetadata threw, its metadata is skipped: ${e instanceof Error ? e.message : String(e)}`);
      } catch { /* no console */ }
    }
    return null;
  }
}

function applyTitleTemplate(template: string | null, title: string): string {
  return template ? template.replace(/%s/g, () => title) : title;
}

/** Merge resolved metadata levels, root layout first and the page last, the
 *  way Next.js does: top-level keys, the deeper level wins, and object values
 *  (openGraph, twitter, alternates, robots, …) are replaced whole, never
 *  deep-merged. An `undefined` value leaves the inherited one; `null` clears it.
 *
 *  `title` may be a string or `{ default?, template?, absolute? }`. A string
 *  (or a `default`) is formatted with the template in force for that level,
 *  `absolute` bypasses it, and a level's own `template` applies to the levels
 *  below it only. As in Next.js, the template in force is the one set by the
 *  nearest level that set a title: a string title in between drops it. When
 *  no deeper level sets a title, the nearest layout's `default` stands. The
 *  merged `title` is the final string (absent when none resolved).
 *
 *  Returns null when every level is empty, so no metadata is injected. */
export function mergeMetadataLevels(levels: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> | null {
  let out: Record<string, unknown> | null = null;
  let template: string | null = null;
  let title: string | undefined;
  for (let i = 0; i < levels.length; i++) {
    const lvl = levels[i];
    if (!lvl || typeof lvl !== "object") continue;
    if (!out) out = {};
    for (const k in lvl) {
      if (k === "title") continue;
      const v = lvl[k];
      if (v !== undefined) out[k] = v;
    }
    const t = lvl.title;
    if (t === undefined) continue;
    let nextTemplate: string | null = null;
    if (typeof t === "string") {
      title = applyTitleTemplate(template, t);
    } else if (t && typeof t === "object") {
      const o = t as { default?: unknown; template?: unknown; absolute?: unknown };
      let resolved: string | undefined;
      if (typeof o.default === "string") resolved = applyTitleTemplate(template, o.default);
      if (typeof o.absolute === "string" && o.absolute) resolved = o.absolute;
      title = resolved;
      if (typeof o.template === "string") nextTemplate = o.template;
    } else {
      title = undefined;
    }
    template = nextTemplate;
  }
  if (out) {
    if (title !== undefined) out.title = title;
    else delete out.title;
  }
  return out;
}

/** Resolve and merge the layout chain's metadata, plus the page's when given
 *  (`page` null = layout levels only, for the not-found / error paths).
 *  Layout levels resolve concurrently; the merge order stays root → page. */
async function resolveRouteMetadata(
  layoutMetadata: MetadataSource[] | undefined,
  page: { metadata?: unknown; generateMetadata?: unknown } | null,
  margs: MetadataArgs,
): Promise<Record<string, unknown> | null> {
  const jobs: Array<Promise<Record<string, unknown> | null>> = [];
  if (Array.isArray(layoutMetadata)) {
    for (let i = 0; i < layoutMetadata.length; i++) {
      const src = layoutMetadata[i];
      jobs.push(
        src && typeof src === "object"
          ? resolveMetadataLevel(src.metadata, src.generateMetadata, margs, `layout #${i}`)
          : Promise.resolve(null),
      );
    }
  }
  if (page) jobs.push(resolveMetadataLevel(page.metadata, page.generateMetadata, margs, "page"));
  if (!jobs.length) return null;
  return mergeMetadataLevels(await Promise.all(jobs));
}

/** Metadata HTML for the not-found / error renders: the layouts' merged
 *  metadata only (the page never rendered), resolved with that status. "" when
 *  the wrapper passed no layout metadata — the old behaviour. */
async function layoutOnlyMetaHtml(args: RunRouteArgs, pathname: string, status: number): Promise<string> {
  if (!Array.isArray(args.layoutMetadata) || !args.layoutMetadata.length) return "";
  const envelope = args.envelope;
  const meta = await resolveRouteMetadata(args.layoutMetadata, null, {
    params: envelope?.params ?? {},
    searchParams: envelope?.searchParams ?? {},
    route: { pathname },
    status,
  });
  return meta ? renderMetadataHtml(meta) : "";
}

/** Index of the `>` closing the tag whose attributes start at `from`, skipping
 *  quoted attribute values; -1 when the tag does not close before `to`. As in
 *  the HTML attribute-value states, a quote opens a quoted value only right
 *  after `=` (whitespace allowed between): a stray quote inside an unquoted
 *  value (`content=it's`) is part of that value and must not swallow the rest
 *  of the head. */
function findTagEnd(s: string, from: number, to: number): number {
  let q = 0;
  // Last non-whitespace character seen outside a quoted value.
  let prev = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (q) {
      if (c === q) {
        q = 0;
        prev = c;
      }
    } else if ((c === 34 || c === 39) && prev === 61) {
      q = c;
    } else if (c === 62) {
      return i;
    } else if (c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) {
      prev = c;
    }
  }
  return -1;
}

function decodeAttr(v: string): string {
  if (v.indexOf("&") < 0) return v;
  return v.replace(/&(amp|quot|apos|lt|gt|#39|#x27);/gi, (_m, e: string) => {
    switch (e.toLowerCase()) {
      case "amp": return "&";
      case "quot": return '"';
      case "lt": return "<";
      case "gt": return ">";
      default: return "'";
    }
  });
}

/** Attributes of a tag (the text between its name and `>`), lowercased names,
 *  entity-decoded values; the first occurrence of a name wins, like a browser. */
function parseAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'=<>\/`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeAttr(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

/** One metadata-managed tag found in a head: its span, the keys it claims
 *  (`title`, `meta:<name|property>`, `link:canonical`,
 *  `link:alternate:<hreflang>`) and, for a meta, its `content`. */
type HeadTag = { start: number; end: number; keys: string[]; content?: string };

/** Elements whose content is raw text — tag-like text inside them is not
 *  markup (and a `<meta>` inside `<noscript>`/`<template>` is not the page's). */
const HEAD_OPAQUE = new Set(["script", "style", "template", "noscript", "textarea"]);

/** One markup token found by `walkMarkup`: a start tag (`close` false), an end
 *  tag (`close` true) or a comment / doctype / bogus comment (`name` "!").
 *  `lt` is the `<`, `nameEnd` just past the tag name, `gt` the closing `>` of
 *  the tag itself, and `end` just past the whole token: for `<title>`,
 *  `<textarea>` and the HEAD_OPAQUE elements, past their closing tag, so
 *  their raw-text content is never read as markup. */
type MarkupToken = { lt: number; name: string; close: boolean; nameEnd: number; gt: number; end: number };

/** Walk the markup of `[from, to)` of `lower` (a lowercased html string) in
 *  document order, calling `visit` for each token (see MarkupToken); a visit
 *  returning true stops the walk. Comments (an abruptly closed `<!-->` /
 *  `<!--->` included), doctype, and raw-text element content are skipped the
 *  way an HTML tokenizer skips them. Returns "stopped", "done" (reached
 *  `to`), or "partial" when a comment, tag or raw-text element is still open
 *  at `to` — i.e. the rest of the input is inside it. */
function walkMarkup(lower: string, from: number, to: number, visit: (t: MarkupToken) => boolean | void): "stopped" | "done" | "partial" {
  let i = from;
  while (i < to) {
    const lt = lower.indexOf("<", i);
    if (lt < 0 || lt >= to) return "done";
    const c1 = lower.charCodeAt(lt + 1);
    if (c1 === 33 || c1 === 63) {
      // `<!--` comment, `<!doctype …>`, `<!…>` / `<?…>` bogus comment.
      let end: number;
      if (lower.startsWith("<!--", lt)) {
        if (lower.startsWith(">", lt + 4)) end = lt + 5;
        else if (lower.startsWith("->", lt + 4)) end = lt + 6;
        else {
          const e = lower.indexOf("-->", lt + 4);
          end = e < 0 || e + 3 > to ? -1 : e + 3;
        }
      } else {
        const e = lower.indexOf(">", lt + 2);
        end = e < 0 || e >= to ? -1 : e + 1;
      }
      if (end < 0) return "partial";
      if (visit({ lt, name: "!", close: false, nameEnd: lt + 2, gt: end - 1, end })) return "stopped";
      i = end;
      continue;
    }
    const close = c1 === 47;
    const ns = close ? lt + 2 : lt + 1;
    let n = ns;
    while (n < to) {
      const c = lower.charCodeAt(n);
      // [a-z][a-z0-9-:]*
      if ((c >= 97 && c <= 122) || (n > ns && ((c >= 48 && c <= 57) || c === 45 || c === 58))) n++;
      else break;
    }
    if (n === ns) {
      // Not a tag (`<` in text, `</` + non-letter): plain text.
      i = lt + 1;
      continue;
    }
    if (n >= to) return "partial";
    const name = lower.slice(ns, n);
    const gt = findTagEnd(lower, n, to);
    if (gt < 0) return "partial";
    let end = gt + 1;
    if (!close && (name === "title" || HEAD_OPAQUE.has(name))) {
      let at = gt + 1;
      end = -1;
      for (;;) {
        const c = lower.indexOf("</" + name, at);
        if (c < 0 || c >= to) break;
        const b = lower.charCodeAt(c + 2 + name.length);
        if (b === 62 || b === 32 || b === 9 || b === 10 || b === 13 || b === 12 || b === 47) {
          const ce = lower.indexOf(">", c);
          if (ce >= 0 && ce < to) end = ce + 1;
          break;
        }
        at = c + 2;
      }
      if (end < 0) return "partial";
    }
    if (visit({ lt, name, close, nameEnd: n, gt, end })) return "stopped";
    i = end;
  }
  return "done";
}

/** Where the document head ends in `[from, to)` of `lower`: the first real
 *  `</head>` end tag or `<body` start tag (never one inside a comment, script,
 *  style, template or noscript). `at` is that tag's `<`, `gt` its `>`;
 *  `partial` when neither was found and the input ends inside an open
 *  construct (so more input may still close it). */
function headBoundary(lower: string, from: number, to: number): { kind: "close" | "body" | null; at: number; gt: number; partial: boolean } {
  let kind: "close" | "body" | null = null;
  let at = -1;
  let gt = -1;
  const r = walkMarkup(lower, from, to, (t) => {
    if (t.close ? t.name === "head" : t.name === "body") {
      kind = t.close ? "close" : "body";
      at = t.lt;
      gt = t.gt;
      return true;
    }
  });
  return { kind, at, gt, partial: r === "partial" };
}

/** The document head opener at the start of a document: the `<head …>` start
 *  tag when it is the first element after the doctype, comments, whitespace
 *  and `<html …>`. Returns its offset; -1 when nothing decisive has been seen
 *  yet (only the prologue so far); -2 when content started without a head —
 *  any other element or text, so a `<head>` later is not the document head
 *  (a string in a script, say). */
function leadingHeadOpen(lower: string): number {
  let res = -1;
  let prev = 0;
  walkMarkup(lower, 0, lower.length, (t) => {
    if (lower.slice(prev, t.lt).trim()) {
      res = -2;
      return true;
    }
    prev = t.end;
    if (t.name === "!" || (t.name === "html" && !t.close)) return;
    res = t.name === "head" && !t.close ? t.lt : -2;
    return true;
  });
  if (res === -1 && lower.slice(prev).replace(/<[^>]*$/, "").trim()) res = -2;
  return res;
}

/** Offset of the first author CSS element — an inline `<style>` or a
 *  stylesheet `<link>` — within `[from, end)` of `lower` (a pre-lowercased
 *  copy of the html), or -1 if none. A `<link>` counts only when it carries
 *  `rel` stylesheet; icon/canonical/preload-font links don't, so metadata may
 *  safely follow them. One inside a comment (an IE conditional comment),
 *  `<noscript>`, `<script>` or `<template>` is not the document's CSS. */
function firstAuthorCssPos(lower: string, from: number, end: number): number {
  let best = -1;
  walkMarkup(lower, from, end, (t) => {
    if (t.close) return;
    if (t.name === "style") {
      best = t.lt;
      return true;
    }
    if (t.name === "link") {
      const rel = (parseAttrs(lower.slice(t.nameEnd, t.gt)).get("rel") ?? "").split(/\s+/);
      if (rel.indexOf("stylesheet") >= 0) {
        best = t.lt;
        return true;
      }
    }
  });
  return best;
}

/** Scan `[from, to)` of `html` for metadata-managed tags. Comments and the
 *  content of script/style/template/noscript are skipped. `lower` is a
 *  pre-lowercased copy of `html`. */
function scanManagedTags(html: string, lower: string, from: number, to: number): HeadTag[] {
  const out: HeadTag[] = [];
  walkMarkup(lower, from, to, (t) => {
    if (t.close) return;
    if (t.name === "title") {
      out.push({ start: t.lt, end: t.end, keys: ["title"] });
      return;
    }
    if (t.name !== "meta" && t.name !== "link") return;
    const attrs = parseAttrs(html.slice(t.nameEnd, t.gt));
    const keys: string[] = [];
    if (t.name === "meta") {
      const nm = attrs.get("name");
      const pr = attrs.get("property");
      if (nm) keys.push("meta:" + nm.trim().toLowerCase());
      if (pr && pr.trim().toLowerCase() !== (nm ?? "").trim().toLowerCase()) keys.push("meta:" + pr.trim().toLowerCase());
    } else {
      const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.indexOf("canonical") >= 0) keys.push("link:canonical");
      const hl = attrs.get("hreflang");
      if (rel.indexOf("alternate") >= 0 && hl) keys.push("link:alternate:" + hl.trim().toLowerCase());
    }
    if (keys.length) {
      const tag: HeadTag = { start: t.lt, end: t.end, keys };
      const content = attrs.get("content");
      if (content !== undefined) tag.content = content;
      out.push(tag);
    }
  });
  return out;
}

/** Restrictive merge of robots directive lists, for a layout that still
 *  computes robots itself while a page's metadata sets it too: noindex beats
 *  index, nofollow beats follow (`none` = both, `all` = index + follow), other
 *  flags are unioned, and for `key:value` directives the LAST list wins —
 *  callers pass the metadata's content last. A metadata `index` can never
 *  re-enable a layout `noindex`. */
export function mergeRobotsDirectives(contents: string[]): string {
  let index = "";
  let follow = "";
  const flags: string[] = [];
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (let c = 0; c < contents.length; c++) {
    // An RFC 850 / 822 `unavailable_after` date carries commas ("Friday,
    // 25-Jun-2010 15:00:00 PST"): a piece that does not start a directive
    // (a word, optionally `word:`) continues the previous date.
    const raw = contents[c].split(",");
    const parts: string[] = [];
    for (let p = 0; p < raw.length; p++) {
      const last = parts.length - 1;
      if (
        last >= 0 &&
        /^\s*unavailable_after\s*:/i.test(parts[last]) &&
        raw[p].trim() &&
        !/^[a-z][a-z0-9_-]*(\s*:.*)?$/i.test(raw[p].trim())
      ) {
        parts[last] += "," + raw[p];
      } else parts.push(raw[p]);
    }
    for (let p = 0; p < parts.length; p++) {
      const d = parts[p].trim();
      if (!d) continue;
      const l = d.toLowerCase();
      const colon = d.indexOf(":");
      if (colon > 0) {
        values.set(l.slice(0, colon).trim(), d.slice(0, colon).trim() + ":" + d.slice(colon + 1).trim());
        continue;
      }
      if (l === "noindex" || l === "none") index = "noindex";
      else if ((l === "index" || l === "all") && !index) index = "index";
      if (l === "nofollow" || l === "none") follow = "nofollow";
      else if ((l === "follow" || l === "all") && !follow) follow = "follow";
      if (l === "noindex" || l === "none" || l === "index" || l === "all" || l === "nofollow" || l === "follow") continue;
      if (!seen.has(l)) {
        seen.add(l);
        flags.push(l);
      }
    }
  }
  const out: string[] = [];
  if (index) out.push(index);
  if (follow) out.push(follow);
  for (let i = 0; i < flags.length; i++) out.push(flags[i]);
  values.forEach((v) => out.push(v));
  return out.join(", ");
}

/** Span of the document head: `start` just past `<head …>`, `close` at its
 *  real `</head>` (see headBoundary); null when the html has no complete
 *  head. */
function headSpan(lower: string): { start: number; close: number } | null {
  const h = leadingHeadOpen(lower);
  if (h < 0) return null;
  const gt = findTagEnd(lower, h + 5, lower.length);
  if (gt < 0) return null;
  const b = headBoundary(lower, gt + 1, lower.length);
  return b.kind === "close" ? { start: gt + 1, close: b.at } : null;
}

/** Image groups of a tag list: each `key` tag (og:image / twitter:image) with
 *  the `key:*` detail tags that follow it (width, height, alt, type…). */
function imageGroups(tags: HeadTag[], key: string): Array<{ tag: HeadTag; url: string; subs: HeadTag[] }> {
  const groups: Array<{ tag: HeadTag; url: string; subs: HeadTag[] }> = [];
  const sub = key + ":";
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    if (t.keys.indexOf(key) >= 0) groups.push({ tag: t, url: (t.content ?? "").trim(), subs: [] });
    else if (groups.length && t.keys.some((k) => k.startsWith(sub))) groups[groups.length - 1].subs.push(t);
  }
  return groups;
}

/** When the metadata replaces the layout's image with the SAME url but says
 *  nothing more about it, the layout's details for that url (width, height,
 *  alt…) — removed with the layout's image family — follow the metadata's tag
 *  instead of being lost. A different url drops them, as they describe an
 *  image that is gone. */
function carryImageDetails(
  key: string,
  html: string,
  layoutTags: HeadTag[],
  metaTags: HeadTag[],
  edits: Array<{ start: number; end: number; text: string }>,
): void {
  const layout = imageGroups(layoutTags, key).filter((g) => g.subs.length && g.url);
  if (!layout.length) return;
  const used = new Set<number>();
  const frag = imageGroups(metaTags, key);
  for (let i = 0; i < frag.length; i++) {
    const g = frag[i];
    if (g.subs.length || !g.url) continue;
    const j = layout.findIndex((l, idx) => !used.has(idx) && l.url === g.url);
    if (j < 0) continue;
    used.add(j);
    let text = "";
    for (let k = 0; k < layout[j].subs.length; k++) text += html.slice(layout[j].subs[k].start, layout[j].subs[k].end);
    edits.push({ start: g.tag.end, end: g.tag.end, text });
  }
}

/** Splice a metadata HTML fragment into <head>, with the metadata owning
 *  every tag it emits (Next.js semantics). The ONE helper used by both the
 *  buffered and the streaming path, so both produce the same head.
 *
 *  - Ownership: every tag in the layout's head whose key the fragment also
 *    emits is removed — `<title>` (with or without attributes),
 *    `<meta name|property=X>` (keyed by X, lowercased: the same key whichever
 *    attribute the layout used), `<link rel=canonical>` and
 *    `<link rel=alternate hreflang=X>`. Image families go as a block: when the
 *    fragment emits og:image and the layout has its own og:image, the layout's
 *    og:image AND og:image:* go (same for twitter:image), except that the
 *    details of a layout image the metadata repeats by url follow the
 *    metadata's tag when it has none of its own (carryImageDetails). A layout with
 *    og:image:* but no og:image is describing the metadata's image
 *    (dimensions, alt), so those tags stay. Only the head is touched, and never
 *    the inside of a comment, `<script>`, `<style>`, `<template>` or
 *    `<noscript>`.
 *  - `autoHtml` (the file-convention tags: icon, apple-touch-icon,
 *    opengraph-image, twitter-image) is inserted just before the fragment but
 *    claims nothing: a layout's hand-written og:image family is not a
 *    competing default the file convention should delete.
 *  - robots / googlebot are the exception: while layouts still compute
 *    noindex from the path or a 404, a page's metadata must not re-open what
 *    the layout closed. When both emit one, the layout tag goes and the
 *    fragment's tag is rewritten to the restrictive merge
 *    (`mergeRobotsDirectives`).
 *  - Placement: just before the first author stylesheet (inline `<style>` or
 *    stylesheet `<link>`, not one inside a comment, noscript or script) so
 *    the SEO tags precede the (often multi-KB) inlined CSS, else before
 *    `</head>`. With no `<head …>` open but a
 *    `</head>`, the fragment goes before `</head>` without de-duplication;
 *    with no head at all the html is returned unchanged.
 *
 *  Empty fragments return `html` untouched (byte-identical). */
export function injectMetadata(html: string, metaHtml: string, autoHtml = ""): string {
  if (!metaHtml && !autoHtml) return html;
  const lower = html.toLowerCase();
  const span = headSpan(lower);
  if (!span) {
    const b = headBoundary(lower, 0, lower.length);
    if (b.kind === "close") return html.slice(0, b.at) + autoHtml + metaHtml + html.slice(b.at);
    return html;
  }
  const metaTags = scanManagedTags(metaHtml, metaHtml.toLowerCase(), 0, metaHtml.length);
  const owned = new Set<string>();
  for (let i = 0; i < metaTags.length; i++) {
    for (let k = 0; k < metaTags[i].keys.length; k++) owned.add(metaTags[i].keys[k]);
  }
  const layoutTags = scanManagedTags(html, lower, span.start, span.close);
  let layoutOgImage = false;
  let layoutTwImage = false;
  for (let i = 0; i < layoutTags.length; i++) {
    if (layoutTags[i].keys.indexOf("meta:og:image") >= 0) layoutOgImage = true;
    if (layoutTags[i].keys.indexOf("meta:twitter:image") >= 0) layoutTwImage = true;
  }
  const ownsOgImage = layoutOgImage && owned.has("meta:og:image");
  const ownsTwImage = layoutTwImage && owned.has("meta:twitter:image");
  // Layout robots/googlebot contents, keyed like `owned`, for the merge below.
  const layoutRobots = new Map<string, string[]>();
  const removals: HeadTag[] = [];
  for (let i = 0; i < layoutTags.length; i++) {
    const t = layoutTags[i];
    let drop = false;
    for (let k = 0; k < t.keys.length; k++) {
      const key = t.keys[k];
      if (
        owned.has(key) ||
        (ownsOgImage && key.startsWith("meta:og:image:")) ||
        (ownsTwImage && key.startsWith("meta:twitter:image:"))
      ) {
        drop = true;
        if ((key === "meta:robots" || key === "meta:googlebot") && t.content !== undefined) {
          const list = layoutRobots.get(key);
          if (list) list.push(t.content);
          else layoutRobots.set(key, [t.content]);
        }
      }
    }
    if (drop) removals.push(t);
  }
  // Edits to the fragment, applied back to front: robots rewrites, and the
  // layout's image details carried over (see carryImageDetails).
  const edits: Array<{ start: number; end: number; text: string }> = [];
  if (layoutRobots.size) {
    for (let i = 0; i < metaTags.length; i++) {
      const t = metaTags[i];
      const key = t.keys[0];
      const prior = layoutRobots.get(key);
      if (!prior || t.content === undefined) continue;
      const merged = mergeRobotsDirectives(prior.concat([t.content]));
      edits.push({ start: t.start, end: t.end, text: `<meta name="${key.slice(5)}" content="${escapeAttr(merged)}">` });
    }
  }
  if (ownsOgImage) carryImageDetails("meta:og:image", html, layoutTags, metaTags, edits);
  if (ownsTwImage) carryImageDetails("meta:twitter:image", html, layoutTags, metaTags, edits);
  let fragment = metaHtml;
  edits.sort((a, b) => b.start - a.start);
  for (let i = 0; i < edits.length; i++) {
    fragment = fragment.slice(0, edits[i].start) + edits[i].text + fragment.slice(edits[i].end);
  }
  let out = html;
  let outLower = lower;
  let close = span.close;
  if (removals.length) {
    let rebuilt = "";
    let from = 0;
    for (let i = 0; i < removals.length; i++) {
      rebuilt += html.slice(from, removals[i].start);
      close -= removals[i].end - removals[i].start;
      from = removals[i].end;
    }
    out = rebuilt + html.slice(from);
    outLower = out.toLowerCase();
  }
  const cssPos = firstAuthorCssPos(outLower, span.start, close);
  const at = cssPos >= 0 ? cssPos : close;
  return out.slice(0, at) + autoHtml + fragment + out.slice(at);
}

const BODY_BEARING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function deepStripSentinel(v: string | string[]): string | string[] {
  if (typeof v === "string") return stripSentinel(v);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? stripSentinel(x) : x));
  return v;
}

/** Scrub the reserved `\x01` safe-HTML sentinel from every untrusted string in
 *  the request envelope, in place — `params`, `searchParams`, header values,
 *  the URL, and textual request bodies. `\x01` has no legitimate place in user
 *  input; leaving it in would let an attacker forge the sentinel and bypass
 *  child escaping (a `\x01<script>` review/field would render live). Multipart
 *  bodies are NOT touched here (they may carry binary file data) — the
 *  multipart parser scrubs their text fields instead. See jsx `stripSentinel`. */
function sanitizeEnvelope(envelope: RouteEnvelope): void {
  if (!envelope) return;
  const p = envelope.params;
  if (p) for (const k in p) p[k] = stripSentinel(p[k]);
  const sp = envelope.searchParams;
  if (sp) for (const k in sp) sp[k] = deepStripSentinel(sp[k]);
  const req = envelope.request;
  if (req) {
    if (typeof req.url === "string") req.url = stripSentinel(req.url);
    const h = req.headers;
    let ct = "";
    if (h) for (const k in h) { h[k] = stripSentinel(h[k]); if (k.toLowerCase() === "content-type") ct = h[k]; }
    if (typeof req.body === "string" && ct.toLowerCase().indexOf("multipart/") === -1) {
      req.body = stripSentinel(req.body);
    }
  }
}

/** Header-read tracking (vary-set) for the master-side render-result cache.
 *
 *  The Rust dispatcher keys cached renders by a hash of the request props —
 *  historically including EVERY request header, so two anonymous visitors
 *  (different user-agent / referer / accept-language) never shared a cache
 *  key and the render cache sat near-dead. Recording which header names a
 *  render actually READS lets the dispatcher project the key down to just
 *  those names (the "vary set", reported per render via the result
 *  envelope's `varyHdrs` field; the dispatcher unions it per bundle).
 *
 *  Over-reporting is safe (key varies on more than needed → only a lower
 *  hit rate); UNDER-reporting is caught by the dispatcher's byte-identical
 *  determinism-by-observation confirmation. Interleaved renders on the
 *  multiplex share this module state, which can only over-report — the
 *  safe direction. Any full-map access (iteration/forEach) degrades to
 *  `"*"` = vary on everything (legacy key). */
let __varyHdrs: Set<string> | null = null;
let __varyAll = false;
const VARY_MAX_NAMES = 16;

function __varyRecord(name: unknown): void {
  if (__varyHdrs) __varyHdrs.add(String(name).toLowerCase());
}
function __varyMarkAll(): void {
  __varyAll = true;
}
// Hook for Rust-emitted wrapper code (e.g. the Next-style middleware shim)
// that hands raw header collections to user code outside this module.
(globalThis as any).__bextVaryMarkAll = __varyMarkAll;

/** Auto loader cache — anonymous-GET read-through for route loaders.
 *
 *  Loader I/O dominates dynamic renders (Server-Timing shows loader;dur
 *  40-380ms vs render;dur 6-25ms). `cachedLoader` exists but is opt-in and
 *  under-adopted; this wraps EVERY loader automatically under conditions
 *  that make it provably safe:
 *    - GET renders only, and only when the request carries NO cookie
 *      (anonymous — per-user loaders can't leak);
 *    - an entry is STORED only when the loader read no request headers at
 *      all (verified post-hoc via the vary tracker), so header-dependent
 *      loaders (locale, UA) are never cached under the header-less key;
 *    - key = host + path + route params + sorted query (same shape as
 *      `cachedLoader`); TTL 15s (override:
 *      `globalThis.__bextAutoLoaderCacheTtlMs`); kill switch:
 *      `globalThis.__bextAutoLoaderCache = false` from any site module.
 *  Loaders already wrapped in `cachedLoader` are skipped (double-caching).
 *  Routes that opt out of caching are skipped too — `export const dynamic =
 *  "force-dynamic"`, `revalidate = false` or `revalidate = 0` (the wrapper
 *  passes both exports to runRoute). Without this a token-gated order page
 *  (anonymous GET, no cookie) served its loader data up to 15 s stale, so a
 *  customer back from payment saw the pre-payment status.
 *  Only JSON-lossless results are stored (`__alcJsonSafe`): a loader that
 *  returns a Map/Set/Date/class instance is never cached, since the hit would
 *  hand the page `{}` / a string instead (a Map-returning loader 500'd
 *  gtonline.fr's order page on every second anonymous view within 15 s).
 *  Backed by the same process-wide `__bextCacheGet`/`__bextCacheSet` store,
 *  so entries are shared across all V8 workers.
 *
 *  Purges: every entry is tagged `bext:path:<pathname>` (bext adds a site tag
 *  itself), so the host's `purge-site` / path purges drop it, and the store
 *  passes the loader's start time so bext refuses a result computed before a
 *  purge that landed while the loader ran — otherwise the next render would
 *  rebuild the purged page from pre-purge data and ISR would keep it. */
const AUTO_LOADER_TTL_MS_DEFAULT = 15_000;

/** Read the host's monotonic clock without making timing instrumentation
 *  itself affect render-purity classification. The Performance API is
 *  deliberately purity-tracked for application calls; preserve and restore
 *  the flag around this internal measurement. The render-generation check
 *  still rejects every interleaved render, so restoring the flag is safe. */
function __loaderNow(): number {
  const g = globalThis as any;
  const impure = g.__bextImpure;
  const now = typeof g.performance?.now === "function"
    ? g.performance.now()
    : Date.now();
  g.__bextImpure = impure;
  return now;
}

/** Wall-clock ms for purge-race checks, read without tripping render-purity
 *  tracking (same save/restore as `__loaderNow`). */
function __wallNow(): number {
  const g = globalThis as any;
  const impure = g.__bextImpure;
  const now = Date.now();
  g.__bextImpure = impure;
  return now;
}

/** The site this render belongs to, read synchronously: the store below runs
 *  after the loader's await, when the host's per-site env overlay may be gone
 *  and the id would fall back to "unknown" — a keyspace no read would match
 *  and no purge of the site would reach. */
function __bextSiteId(): string {
  try {
    return (globalThis as any).process?.env?.__BEXT_SITE ?? "";
  } catch {
    return "";
  }
}

/** Tags an auto loader cache entry carries: its request path, normalized the
 *  way bext normalizes purge paths (no query, no trailing slash). */
export function __autoLoaderPathTags(url: string): string[] {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
    return ["bext:path:" + path];
  } catch {
    return [];
  }
}

function __alcHash32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** True when the route's own exports forbid caching its loader result. */
export function routeOptsOutOfLoaderCache(
  dynamic: string | undefined,
  revalidate: number | false | undefined,
): boolean {
  return dynamic === "force-dynamic" || revalidate === false || revalidate === 0;
}

/** Cache key for the auto loader cache, or null when ineligible. */
function __autoLoaderKey(
  envelope: RouteEnvelope,
  method: string,
  loader: unknown,
): [number, number] | null {
  const g = globalThis as any;
  if (method !== "GET") return null;
  if (g.__bextAutoLoaderCache === false) return null;
  if (typeof g.__bextCacheGet !== "function" || typeof g.__bextCacheSet !== "function") return null;
  if (loader && (loader as any).__bextCachedLoader) return null;
  const hdrs = envelope.request?.headers ?? {};
  for (const k in hdrs) {
    if (k.toLowerCase() === "cookie" && hdrs[k]) return null;
  }
  try {
    const u = new URL(envelope.request?.url ?? "");
    const sp = Array.from(u.searchParams.entries()).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    );
    const p = envelope.params ?? {};
    const pp = Object.keys(p).sort().map((k) => [k, p[k]]);
    const keyStr = "alc:" + JSON.stringify([u.host, u.pathname, pp, sp]);
    return [__alcHash32(keyStr, 0x811c9dc5), __alcHash32(keyStr, 0x9e3779b9)];
  } catch {
    return null;
  }
}

function __autoLoaderGet(key: [number, number], site: string): unknown | undefined {
  try {
    const cached = (globalThis as any).__bextCacheGet(key[0], key[1], site);
    if (cached != null) return JSON.parse(cached);
  } catch { /* miss / corrupt entry */ }
  return undefined;
}

/** True when `value` comes back from JSON.parse(JSON.stringify(value)) with the
 *  same shape: plain objects/arrays of strings, finite numbers, booleans and
 *  null. Anything else (Map, Set, Date, class instances, undefined in arrays,
 *  NaN/Infinity, bigint, functions) would be served back mangled on a cache
 *  hit — a Map returns as `{}` and `.get` throws — so such results are simply
 *  not cached. Exported for tests. */
export function __alcJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || !__alcJsonSafe(item, depth + 1)) return false;
        }
        return true;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      for (const k in value as Record<string, unknown>) {
        const v = (value as Record<string, unknown>)[k];
        // An own undefined property disappears in JSON but reads back as
        // undefined all the same — harmless.
        if (v !== undefined && !__alcJsonSafe(v, depth + 1)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function __autoLoaderSet(key: [number, number], value: unknown, tags: string[], startedAt: number, site: string): void {
  if (!__alcJsonSafe(value)) return;
  try {
    const g = globalThis as any;
    const ttl = typeof g.__bextAutoLoaderCacheTtlMs === "number"
      ? g.__bextAutoLoaderCacheTtlMs
      : AUTO_LOADER_TTL_MS_DEFAULT;
    if (ttl <= 0) return;
    g.__bextCacheSet(key[0], key[1], JSON.stringify(value), ttl, JSON.stringify(tags), startedAt, site);
  } catch { /* best-effort */ }
}

/** Wrap a `Request` so `.headers` reads are recorded. Methods are bound to
 *  the real target (Proxy receivers fail Web-API brand checks otherwise). */
function trackRequest(req: Request): Request {
  const h = req.headers;
  const trackedHeaders = new Proxy(h, {
    get(t, p) {
      const v = (t as any)[p];
      if (typeof v === "function") {
        if (p === "get" || p === "has") {
          return (name: string, ...rest: unknown[]) => {
            __varyRecord(name);
            return v.call(t, name, ...rest);
          };
        }
        if (
          p === "forEach" || p === "entries" || p === "keys" ||
          p === "values" || p === Symbol.iterator || p === "getSetCookie"
        ) {
          return (...a: unknown[]) => {
            __varyMarkAll();
            return v.apply(t, a);
          };
        }
        return v.bind(t);
      }
      return v;
    },
  });
  return new Proxy(req, {
    get(t, p) {
      if (p === "headers") return trackedHeaders;
      const v = (t as any)[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as Request;
}

/** Build a Web-API `Request` from the transport envelope. The
 *  Web-Request constructor rejects bodies for GET/HEAD, so the body
 *  is omitted for those (also when null). Loaders/actions can call
 *  `.formData()`, `.text()`, `.json()` and read `.headers.get(...)`. */
function buildRequest(envelope: RouteEnvelope): Request {
  const { url, method, headers, body } = envelope.request;
  const m = (method || "GET").toUpperCase();
  const hdrs = new Headers(headers || {});
  const init: RequestInit =
    body != null && m !== "GET" && m !== "HEAD"
      ? { method: m, headers: hdrs, body }
      : { method: m, headers: hdrs };
  return trackRequest(new Request(url, init));
}

/** Walk a Response into a serializable shape. Used when loader/action
 *  returns or throws a Response — the dispatcher converts this into
 *  an actix HttpResponse with the matching status/headers/body. */
async function serializeResponse(r: Response): Promise<
  Extract<RouteResult, { kind: "response" }>
> {
  const headers: Array<[string, string]> = [];
  // Pull Set-Cookie via getSetCookie() first — it preserves multi-value
  // semantics. forEach()'s behavior on duplicate set-cookie is
  // implementation-dependent: native V8 iterates them separately per
  // the WHATWG Fetch spec, but a polyfill (or older V8) may combine
  // them with ", " which destroys cookies containing commas in their
  // Expires=Date attribute. Mirror the __coerceResponse pattern in
  // bext-server/src/ssr_pipeline/prism.rs which already does this for
  // the middleware path.
  const hasGetSetCookie =
    !!r.headers && typeof (r.headers as any).getSetCookie === "function";
  if (hasGetSetCookie) {
    for (const c of (r.headers as any).getSetCookie()) {
      headers.push(["set-cookie", String(c)]);
    }
  }
  if (r.headers && typeof (r.headers as any).forEach === "function") {
    (r.headers as any).forEach((v: string, k: string) => {
      // Skip set-cookie here — we already handled it via getSetCookie().
      // If getSetCookie wasn't available, forEach is our only signal and
      // we keep what it returns (best-effort).
      if (hasGetSetCookie && String(k).toLowerCase() === "set-cookie") return;
      headers.push([k, v]);
    });
  }
  let body = "";
  let bodyEncoding: "base64" | undefined;
  if (r.body != null) {
    const rb: any = r.body;
    const bytes =
      rb instanceof Uint8Array
        ? rb
        : typeof ArrayBuffer !== "undefined" && rb instanceof ArrayBuffer
          ? new Uint8Array(rb)
          : typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(rb)
            ? new Uint8Array(rb.buffer, rb.byteOffset, rb.byteLength)
            : null;
    if (bytes) {
      // Byte body (binary download). A JS string can't carry raw bytes to
      // the host, so ship base64 + body_encoding; the host decodes it back
      // to exact bytes. Chunks of 30 000 (multiple of 3) so per-chunk btoa
      // concatenates without padding seams.
      let out = "";
      for (let i = 0; i < bytes.length; i += 30000) {
        const end = Math.min(i + 30000, bytes.length);
        let s = "";
        for (let j = i; j < end; j++) s += String.fromCharCode(bytes[j]);
        out += btoa(s);
      }
      body = out;
      bodyEncoding = "base64";
    } else if (typeof rb === "string") {
      body = rb;
    } else if (typeof (r as any).text === "function") {
      body = await (r as any).text();
    } else {
      body = String(rb);
    }
  }
  return bodyEncoding
    ? { kind: "response", status: r.status ?? 200, headers, body, body_encoding: bodyEncoding }
    : { kind: "response", status: r.status ?? 200, headers, body };
}

/** Compose a layout chain around a page. `layouts[0]` is outermost.
 *  The composition mirrors what the Rust wrapper used to inline:
 *  `Layout0({ children: Layout1({ children: Page(pageProps) }) })`.
 *
 *  Optional `template` wraps the page (innermost — inside all layouts
 *  but outside the page itself). Same shape as a layout.
 *
 *  Optional `deepestLayoutExtraProps` are extra named props passed to
 *  the innermost layout — used by the parallel-routes feature to
 *  surface slot HTML alongside `children`. The deepest layout reads
 *  them as `({ children, modal, feed }) => …`; non-deepest layouts
 *  receive only `{ children }`. */
function composeTree(
  Page: Page,
  layouts: Layout[],
  pageProps: any,
  template?: Layout,
  deepestLayoutExtraProps?: Record<string, unknown>,
  loading?: () => Renderable,
  // Request-scoped props passed to EVERY layout (not the page) alongside
  // `children` — e.g. `{ route: { pathname } }` so a root layout can render
  // locale-correct chrome + <html lang> server-side. Additive: layouts that
  // destructure only `{ children }` ignore it.
  layoutProps?: Record<string, unknown>,
): Renderable {
  let inner: Renderable = Page(pageProps);
  if (template) {
    inner = template({ children: inner, ...layoutProps });
  }
  // Wrap the page tree in <Suspense fallback={<Loading/>}> when a
  // co-located loading.tsx is provided. Pure sync pages don't trigger
  // the boundary (Suspense's fast path returns the children inline);
  // async pages — `export default async function Page()` or any
  // async child — yield the fallback first, then stream the real
  // content via the out-of-order template+swap protocol.
  if (loading) {
    inner = Suspense({ fallback: loading((layoutProps ?? {}) as any), children: inner });
  }
  for (let i = layouts.length - 1; i >= 0; i--) {
    const L = layouts[i];
    // Only the innermost layout sees the slot props. Outer layouts get
    // the standard `{ children }` shape — same as before this feature.
    const isDeepest = i === layouts.length - 1;
    if (isDeepest && deepestLayoutExtraProps) {
      inner = L({ children: inner, ...layoutProps, ...deepestLayoutExtraProps } as any);
    } else {
      inner = L({ children: inner, ...layoutProps } as any);
    }
  }
  return inner;
}

/** Substitute `Page` for `replacement` while keeping the same layout +
 *  template chain. Used when a loader throws a 404 and a co-located
 *  not-found.tsx is provided — the document shell stays intact, only
 *  the inner content swaps. */
function composeReplacement(
  Replacement: Page,
  layouts: Layout[],
  template: Layout | undefined,
  replacementProps: any,
  layoutProps?: Record<string, unknown>,
): Renderable {
  return composeTree(Replacement, layouts, replacementProps, template, undefined, undefined, layoutProps);
}

function injectEarlyHtml(html: string, snippet: string): string {
  if (!snippet) return html;
  // The real </head> or <body>: never one inside a head script's string.
  const b = headBoundary(html.toLowerCase(), 0, html.length);
  if (b.kind === "close") return html.slice(0, b.at) + snippet + html.slice(b.at);
  if (b.kind === "body") return html.slice(0, b.gt + 1) + snippet + html.slice(b.gt + 1);
  return snippet + html;
}

function injectLateHtml(html: string, snippet: string): string {
  if (!snippet) return html;
  const lower = html.toLowerCase();
  const bodyClose = lower.lastIndexOf("</body>");
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + snippet + html.slice(bodyClose);
  }
  return html + snippet;
}

/** Prepend `<!DOCTYPE html>` when the rendered output is a full HTML
 *  document. Without a doctype the browser parses in quirks mode (breaks
 *  CSS box-sizing/line-height edge cases, fails Lighthouse "Page lacks the
 *  HTML doctype"). Applied to documents ONLY — a layout that renders a
 *  bare fragment / partial (anything not starting with `<html>`) is left
 *  untouched, and an existing doctype (or XML prolog, e.g. an SVG/XSL
 *  route) is never doubled. The leading-window check tolerates ASCII
 *  whitespace before the root element, and ONLY that (same set as the host's
 *  `ensure_html_doctype`, prism.rs): JS `\s` also matches U+FEFF and U+00A0,
 *  and a doctype put in front of a BOM (a loader returning an HTML file read
 *  with its BOM) turns that BOM, which the decoder would otherwise strip,
 *  into body text before `<html>`, so `<head>` is dropped and its tags land
 *  in `<body>`. */
function prependDoctype(html: string): string {
  const lead = html.slice(0, 256).replace(/^[\t\n\f\r ]+/, "").toLowerCase();
  if (lead.startsWith("<!doctype") || lead.startsWith("<?xml")) return html;
  if (lead.startsWith("<html")) return "<!DOCTYPE html>" + html;
  return html;
}

/** True when a response's header list declares an HTML body. */
function responseIsHtml(headers: Array<[string, string]> | undefined): boolean {
  if (!Array.isArray(headers)) return false;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (Array.isArray(h) && String(h[0]).toLowerCase() === "content-type") {
      return String(h[1]).toLowerCase().indexOf("text/html") >= 0;
    }
  }
  return false;
}

/** Run a PRISM route end-to-end. */
export async function runRoute(args: RunRouteArgs): Promise<RouteResult> {
  const {
    Page,
    layouts,
    loader,
    action,
    envelope,
    islandLoaderHtml,
    errorBoundary,
    notFoundComponent,
    templateComponent,
    loadingComponent,
    staticMetadata,
    generateMetadata,
    layoutMetadata,
    iconUrl,
    appleIconUrl,
    opengraphImageUrl,
    twitterImageUrl,
    slots,
    dynamic,
    revalidate,
  } = args;
  // Scrub the reserved \x01 sentinel from all untrusted input before anything
  // reads it — closes the sentinel-forgery XSS path (see sanitizeEnvelope).
  sanitizeEnvelope(envelope);
  // Fresh vary-set for this render (see trackRequest). A route with no
  // loader/action never touches request headers → empty set → the
  // dispatcher can drop ALL headers from its cache key.
  __varyHdrs = new Set();
  __varyAll = false;
  const params = envelope.params ?? {};
  const searchParams = envelope.searchParams ?? {};
  const method = String(envelope.request?.method ?? "GET").toUpperCase();

  // Request path, surfaced to layouts (not the page) so a root layout can
  // render locale-correct chrome + <html lang> server-side. Best-effort.
  let _routePathname = "/";
  try { _routePathname = new URL(envelope.request?.url ?? "").pathname || "/"; } catch { /* keep "/" */ }
  const layoutProps = { route: { pathname: _routePathname } };

  let actionData: unknown = undefined;
  let data: unknown = undefined;
  // Wall-time spent in the route loader — the dominant per-request I/O
  // (trpc / fetch / db). Reported in the result envelope so the Rust dispatcher
  // can split Server-Timing `loader;dur` out of `render;dur`, which otherwise
  // conflates loader I/O with actual V8 render CPU (the two differ by 10-50x).
  let __loaderMs = 0;

  // Action runs first on body-bearing methods. A returned-or-thrown
  // Response short-circuits the page render entirely (Remix-style
  // `redirect()` / `notFound()`). Other throws propagate to the V8
  // host and become 5xx — unless a co-located error.tsx is present,
  // in which case we render it as the body.
  if (action && BODY_BEARING.has(method)) {
    const request = buildRequest(envelope);
    let result: unknown;
    try {
      result = await action({ request, params });
    } catch (e: unknown) {
      if (e instanceof Response) {
        return await renderResponseFallback(e, args);
      }
      if (isThrownBextResponse(e)) {
        return await renderResponseFallback(bextResponseToResponse(e), args);
      }
      return await renderErrorBoundary(e, args);
    }
    if (result instanceof Response) {
      return await renderResponseFallback(result, args);
    }
    actionData = result;
  }

  // Loader runs on every method, after a successful action. Same
  // Response semantics as the action.
  if (loader) {
    const request = buildRequest(envelope);
    let result: unknown;
    const __lt0 = __loaderNow();
    const __alcStartedAt = __wallNow();
    const __alcSite = __bextSiteId();
    // Auto loader cache (see __autoLoaderKey): anonymous GETs serve the
    // loader result from the process-wide cache; a fresh result is stored
    // only when the loader read no request headers during execution.
    // A route that declares itself uncacheable must see fresh loader data on
    // every request, anonymous or not (see the auto loader cache doc comment).
    const __alcKey = routeOptsOutOfLoaderCache(dynamic, revalidate)
      ? null
      : __autoLoaderKey(envelope, method, loader);
    let __alcServed = false;
    if (__alcKey) {
      const hit = __autoLoaderGet(__alcKey, __alcSite);
      if (hit !== undefined && hit !== null) {
        result = hit;
        __alcServed = true;
      }
    }
    if (!__alcServed) {
      const __preVary = __varyHdrs ? new Set(__varyHdrs) : null;
      const __preVaryAll = __varyAll;
      try {
        result = await loader({ request, params });
      } catch (e: unknown) {
        __loaderMs = __loaderNow() - __lt0;
        if (e instanceof Response) {
          return await renderResponseFallback(e, args);
        }
        if (isThrownBextResponse(e)) {
          return await renderResponseFallback(bextResponseToResponse(e), args);
        }
        return await renderErrorBoundary(e, args);
      }
      // Post-hoc proof: store only when every header name recorded during
      // the loader is `cookie` — usually none at all, but a
      // `readSession`-style cookie read on a COOKIE-LESS request (the only
      // kind `__autoLoaderKey` admits) returned nothing, so the result is
      // exactly the anonymous variant every eligible request would get.
      // Any OTHER header read (locale, UA) blocks the store. Interleaved
      // renders can only ADD names — over-counting skips the store, the
      // safe direction.
      let __alcSafe = __alcKey != null && !__varyAll && !__preVaryAll && __preVary != null && __varyHdrs != null;
      if (__alcSafe && __varyHdrs && __preVary) {
        for (const n of __varyHdrs) {
          if (n !== "cookie" && !__preVary.has(n)) { __alcSafe = false; break; }
        }
      }
      if (__alcSafe && __alcKey && result != null && !(result instanceof Response)) {
        __autoLoaderSet(__alcKey, result, __autoLoaderPathTags(envelope.request?.url ?? ""), __alcStartedAt, __alcSite);
      }
    }
    __loaderMs = __loaderNow() - __lt0;
    if (result instanceof Response) {
      return await renderResponseFallback(result, args);
    }
    data = result;
  }

  // Resolve metadata: each layout level (when the wrapper passes them) then
  // the page, merged Next.js-style (mergeMetadataLevels). Per level the static
  // export wins if both are present (Next.js wants only one of `metadata` /
  // `generateMetadata`, but we tolerate both). A throwing generateMetadata
  // skips its level instead of 5xxing the page.
  const resolvedMetadata = await resolveRouteMetadata(
    layoutMetadata,
    { metadata: staticMetadata, generateMetadata },
    { params, searchParams, route: { pathname: _routePathname }, status: 200 },
  );
  // Auto-injected metadata-file head tags. These run alongside any
  // user-supplied static/generated metadata, spliced in the order icon →
  // og → user-metadata. They claim no head tags (see injectMetadata's
  // `autoHtml`): only the user's metadata owns what it emits.
  let autoMetaHtml = "";
  if (typeof iconUrl === "string") {
    autoMetaHtml += `<link rel="icon" href="${escapeAttr(iconUrl)}">`;
  }
  if (typeof appleIconUrl === "string") {
    autoMetaHtml += `<link rel="apple-touch-icon" href="${escapeAttr(appleIconUrl)}">`;
  }
  if (typeof opengraphImageUrl === "string") {
    autoMetaHtml += `<meta property="og:image" content="${escapeAttr(opengraphImageUrl)}">`;
  }
  if (typeof twitterImageUrl === "string") {
    autoMetaHtml += `<meta name="twitter:image" content="${escapeAttr(twitterImageUrl)}">`;
  }
  const userMetaHtml = resolvedMetadata ? renderMetadataHtml(resolvedMetadata) : "";
  const metaHtml = autoMetaHtml + userMetaHtml;

  // Page props are intentionally narrower than the envelope — the page
  // never sees `request` (transport detail). Loader / action read it
  // when they need to.
  const pageProps: any = { params, searchParams };
  if (data !== undefined) pageProps.data = data;
  if (actionData !== undefined) pageProps.actionData = actionData;

  // Render each parallel slot to a string up-front. Slot render
  // failures swallow the slot (renders empty) rather than 5xx the
  // whole page — slots are decorative. The strings are then merged
  // into the layout-prop bundle so the deepest layout sees them as
  // `{ children, modal, feed, ... }`.
  const slotProps: Record<string, string> = {};
  if (slots && typeof slots === "object") {
    for (const [name, SlotPage] of Object.entries(slots)) {
      if (typeof SlotPage !== "function") continue;
      try {
        slotProps[name] = await collectRender(() => SlotPage(pageProps), pageProps);
      } catch (_) {
        slotProps[name] = "";
      }
    }
  }

  // Streaming sink, if installed by the host wrapper. When present,
  // each chunk goes to the sink the moment renderToStream yields it;
  // SUSPENSE_CLIENT_RUNTIME is injected at the first chunk that
  // contains </head> (or <body>) so it's already loaded before the
  // out-of-order template+swap pairs arrive.
  //
  // Phase 6c (closure-capture sink): prefer the per-request `chunkSink`
  // arg threaded by the multiplex streaming runner. The closure is
  // bound to the originating reqId so it survives concurrent streaming
  // on a shared cached context. Falls back to the global when no arg
  // was supplied (non-multiplex callers, subprocess wire path).
  const rawSink = (args.chunkSink ?? (globalThis as any).__bextPrismChunkSink) as
    | ((s: string) => void)
    | undefined;
  // ZEROSTRIP: chunks are already clean. Safe-HTML is carried by the
  // out-of-band `SafeHtml` brand (jsx.ts `safe()` / the compile fold's
  // `__bextSafe`), not an in-band \x01 sentinel — `asAsyncIterable` yields the
  // brand's `.s` and async `Raw` yields verbatim, so no chunk carries a marker.
  // The per-chunk scan + replace is gone; chunks go straight to the wire.
  // Wrap the host sink so the very first emitted chunk gets a `<!DOCTYPE html>`
  // prefix when it opens a full document (same standards-mode fix as the
  // buffered path; prependDoctype no-ops on fragments / existing doctypes).
  let __doctypeEmitted = false;
  const sink = rawSink
    ? (s: string): void => {
        if (!__doctypeEmitted && s) {
          __doctypeEmitted = true;
          rawSink(prependDoctype(s));
          return;
        }
        rawSink(s);
      }
    : undefined;

  if (sink) {
    let injectedRuntime = false;
    let hasIslands = false;
    // Tail buffer: when we see </body> or </html> in a chunk, the
    // closing tags are split off and emitted at the very end. This
    // is critical for browser progressive rendering — content emitted
    // AFTER </html> lands the parser in "after after body" mode where
    // many browsers stop visibly progressive-rendering and inline
    // scripts can run in unpredictable contexts. The standard
    // streaming-SSR pattern (React 19, Next.js, SolidStart) keeps
    // post-shell suspense reveals INSIDE the body so the parser stays
    // in "in body" mode and `<script>` tags execute the same way they
    // would for any other body content.
    let tailBuffer = "";
    // Head buffer: once a chunk opens `<head`, chunks are held here until
    // the one carrying `</head>` arrives, and the joined head goes through
    // injectInto as ONE chunk. The metadata de-duplication needs the whole
    // head in view, and the async pump splits it wherever an async child
    // sits inside <head> (a fonts/settings component). The head precedes
    // every body byte, so holding it back costs no first paint.
    let headBuffer = "";
    // True until the start of the document has shown whether it opens with a
    // real <head> (only then is anything held).
    let headWindow = true;

    const injectInto = (chunk: string): string => {
      if (injectedRuntime) return chunk;
      const out = chunk;
      // The real </head> or <body> (a `"<body>"` string in a head script is
      // neither), found the same way as the buffered path's injectEarlyHtml.
      const b = headBoundary(out.toLowerCase(), 0, out.length);
      if (b.kind === "close") {
        const headClose = b.at;
        injectedRuntime = true;
        // Same steps, same order as the buffered path (runtime at </head>,
        // then the managed metadata splice) so both emit the same head.
        // Browsers read <title>/<meta> from the early head, so the metadata
        // must ride in this chunk. The head buffer in flushChunk guarantees
        // the chunk carrying </head> holds the whole head.
        return injectMetadata(
          out.slice(0, headClose) + SUSPENSE_CLIENT_RUNTIME + out.slice(headClose),
          userMetaHtml,
          autoMetaHtml,
        );
      }
      if (b.kind === "body") {
        const bodyOpenEnd = b.gt;
        injectedRuntime = true;
        return (
          out.slice(0, bodyOpenEnd + 1) +
          metaHtml +
          SUSPENSE_CLIENT_RUNTIME +
          out.slice(bodyOpenEnd + 1)
        );
      }
      return out;
    };

    // Find the first occurrence of </body> or </html> in a chunk
    // (case-insensitive). Returns -1 if neither is present. We split
    // at this point so everything from here onward is held back as
    // tail and post-shell reveals can be emitted before it.
    const findTailStart = (chunk: string): number => {
      const lower = chunk.toLowerCase();
      const a = lower.indexOf("</body>");
      const b = lower.indexOf("</html>");
      if (a < 0) return b;
      if (b < 0) return a;
      return Math.min(a, b);
    };

    // Post-shell suspense reveals carry these literal markers (see
    // streaming.ts:158-160). We detect them on the wire so that — even
    // after we've buffered the first </body>/</html> tail tag — the
    // reveals flush IMMEDIATELY, landing inside <body>. The shell can
    // emit multiple closing tags as separate chunks (e.g., </body>
    // then </html>); both get appended to tailBuffer until the
    // iteration ends and we flush it.
    const isPostShellReveal = (chunk: string): boolean =>
      chunk.indexOf('<template data-suspense-real="') >= 0 ||
      chunk.indexOf("<script>__bextSuspense.swap(") >= 0;

    // Send a chunk on its way: runtime + metadata splice, then the tail split.
    const emit = (chunk: string): void => {
      const injected = injectInto(chunk);
      const tailIdx = findTailStart(injected);
      if (tailIdx < 0) {
        sink(injected);
        return;
      }
      if (tailIdx > 0) sink(injected.slice(0, tailIdx));
      // Shell-content boundary marker for the SPA stream consumer (client.ts streamNav):
      // an HTML comment — ignored by the browser on a full document load — that lets a
      // soft-nav swap the shell the instant it's complete, then resolve each Suspense
      // <template> as it streams in (instead of buffering the whole response). Built from
      // char codes so the literal HTML-comment markers (legacy JS comment tokens) never
      // appear in the bundle source, which would break V8's parse of the compiled bundle.
      sink(String.fromCharCode(60, 33, 45, 45) + "bext-shell-end" + String.fromCharCode(45, 45, 62));
      tailBuffer = injected.slice(tailIdx);
    };

    // Release a held-back head as it is (see headBuffer).
    const releaseHead = (): void => {
      if (!headBuffer) return;
      const held = headBuffer;
      headBuffer = "";
      headWindow = false;
      emit(held);
    };

    const flushChunk = (chunk: string): void => {
      if (isPostShellReveal(chunk)) {
        // Always flush reveals straight to the wire — they belong
        // inside the body, before the deferred </body></html>. Anything
        // held back goes first: it holds the placeholders they swap.
        releaseHead();
        sink(chunk);
        return;
      }
      if (tailBuffer) {
        // We've already started buffering the tail. Anything that
        // isn't a reveal joins the tail (covers a shell that emits
        // </body> and </html> as separate chunks).
        tailBuffer += chunk;
        return;
      }
      if (headWindow && !injectedRuntime && metaHtml) {
        // Hold the document prologue and an open head back until the head
        // closes (see headBuffer). Only when metadata is to be spliced:
        // without it the head needs no de-duplication and chunks keep
        // flowing exactly as before. Only the REAL head holds: a
        // `<head>`/`</head>`/`<body>` inside a script string, a comment or
        // after body content has started does not.
        const joined = headBuffer + chunk;
        const lower = joined.toLowerCase();
        const h = leadingHeadOpen(lower);
        if (h === -1 || (h >= 0 && headBoundary(lower, h, lower.length).kind === null)) {
          headBuffer = joined;
          return;
        }
        headWindow = false;
        headBuffer = "";
        chunk = joined;
      }
      emit(chunk);
    };

    try {
      // Sync fast path: when the whole shell renders synchronously (no async
      // child, no suspended boundary), `renderTree` hands back the finished
      // string — flush it as a single chunk and skip the async-generator pump.
      const r = renderTree(
        () => composeTree(Page, layouts, pageProps, templateComponent, slotProps, loadingComponent, layoutProps),
        pageProps,
      );
      if ("html" in r) {
        if (r.html.indexOf("<bext-island") >= 0) hasIslands = true;
        flushChunk(r.html);
      } else {
        for await (const chunk of r.stream) {
          if (chunk.indexOf("<bext-island") >= 0) hasIslands = true;
          flushChunk(chunk);
        }
      }
    } catch (e: unknown) {
      // Render-time error past the loader. If a co-located error.tsx
      // exists, drop the partial chunk buffer and emit the error
      // fallback instead. Otherwise rethrow so the host emits 5xx.
      // A held-back partial head is dropped with it: the error render
      // brings its own document.
      headBuffer = "";
      headWindow = true;
      if (errorBoundary) {
        const errorPage: Page = (props: any) =>
          errorBoundary({ error: props.error, reset: () => {}, ...layoutProps });
        const errProps: any = { ...pageProps, error: e instanceof Error ? e : new Error(String(e)) };
        // Restart the stream — we already may have flushed bytes,
        // but the streaming sink's tailBuffer is meant to defer the
        // closing tags, so post-hoc HTML the error renders into here
        // still lands inside <body>.
        const er = renderTree(
          () => composeTree(errorPage, layouts, errProps, templateComponent, undefined, undefined, layoutProps),
          errProps,
        );
        if ("html" in er) {
          flushChunk(er.html);
        } else {
          for await (const chunk of er.stream) flushChunk(chunk);
        }
      } else {
        throw e;
      }
    }
    // A head that never closed (malformed shell), or a document that is
    // nothing but prologue: send it as it is, through the same tail split
    // (and shell-end marker) as any other chunk.
    releaseHead();
    if (!injectedRuntime) {
      // Document has neither <head> nor <body> — flush the runtime as
      // a final tail chunk so out-of-order swaps still find it.
      sink(SUSPENSE_CLIENT_RUNTIME);
    }
    if (hasIslands && islandLoaderHtml) {
      sink(islandLoaderHtml);
    }
    // Inspect-mode iframe-bridge runtime (no-op handshake in phase 1).
    // Emitted before the tail so it lands inside </body> like the
    // island loader above.
    if (envelopeIsInspect(envelope)) {
      sink(getInspectScript());
    }
    // Now flush the tail (</body></html>). All suspense reveals have
    // landed inside the body before this point.
    if (tailBuffer) sink(tailBuffer);
    // Body intentionally empty: the bytes already went through the
    // sink. The host returns a streaming response; this RouteResult
    // exists only so loader/action Response short-circuits below this
    // point can still surface a kind:"response" envelope.
    return { kind: "html", body: "", hasIslands };
  }

  // Buffered path (default). Drains renderToStream into a string,
  // injects SUSPENSE_CLIENT_RUNTIME, returns. The dispatcher emits a
  // fixed-length response.
  let html = "";
  try {
    // Sync fast path (the common brochure/marketing/WP-replacement page): when
    // the whole tree renders synchronously, `renderTree` returns the finished
    // string directly — no async generators, no per-chunk microtasks. Only an
    // async child or a suspended Suspense boundary falls to the streaming pump.
    const r = renderTree(
      () => composeTree(Page, layouts, pageProps, templateComponent, slotProps, loadingComponent, layoutProps),
      pageProps,
    );
    if ("html" in r) {
      html = r.html;
    } else {
      for await (const chunk of r.stream) html += chunk;
    }
  } catch (e: unknown) {
    if (errorBoundary) {
      const errorPage: Page = (props: any) =>
        errorBoundary({ error: props.error, reset: () => {}, ...layoutProps });
      const errProps: any = { ...pageProps, error: e instanceof Error ? e : new Error(String(e)) };
      html = await collectRender(
        () => composeTree(errorPage, layouts, errProps, templateComponent, undefined, undefined, layoutProps),
        errProps,
      );
    } else {
      throw e;
    }
  }

  const hasIslands = html.indexOf("<bext-island") >= 0;

  // Move post-shell suspense reveals (`<template data-suspense-real>` +
  // `<script>__bextSuspense.swap(N)</script>`) from after `</html>`
  // into the body, before `</body></html>`. Browsers' HTML5 parsers
  // enter "after after body" mode once `</html>` is seen and stop
  // running scripts in the normal "in body" insertion mode; reveals
  // emitted there can fail to swap their placeholders. The fix
  // matches what the streaming sink does on the wire — same protocol,
  // just applied post-hoc on the buffered string.
  const bodyClose = html.toLowerCase().lastIndexOf("</body>");
  if (bodyClose >= 0) {
    const tail = html.slice(bodyClose); // </body>...</html>...templates+swaps...
    const htmlClose = tail.toLowerCase().indexOf("</html>");
    if (htmlClose >= 0) {
      const closeTags = tail.slice(0, htmlClose + "</html>".length);
      const afterHtml = tail.slice(htmlClose + "</html>".length);
      if (afterHtml.length > 0) {
        html = html.slice(0, bodyClose) + afterHtml + closeTags;
      }
    }
  }

  html = injectEarlyHtml(html, SUSPENSE_CLIENT_RUNTIME);
  // Metadata owns the head tags it emits (see injectMetadata); the streaming
  // path runs the same helper after the same runtime splice.
  if (metaHtml) {
    html = injectMetadata(html, userMetaHtml, autoMetaHtml);
  }
  if (hasIslands && islandLoaderHtml) {
    html = injectLateHtml(html, islandLoaderHtml);
  }

  // Inspect-mode iframe-bridge runtime (no-op handshake in phase 1).
  // Late-injected just like the island loader so it lands inside the
  // </body> close.
  if (envelopeIsInspect(envelope)) {
    html = injectLateHtml(html, getInspectScript());
  }

  const __result: RouteResult = { kind: "html", body: prependDoctype(html), hasIslands };
  if (__loaderMs > 0) (__result as any).__loaderMs = __loaderMs;
  // Report the header vary-set (see trackRequest). `"*"` = full-map access
  // observed (or an implausibly wide set) → dispatcher keeps the legacy
  // all-headers key. A sorted list keeps the envelope deterministic.
  if (__varyHdrs) {
    (__result as any).__varyHdrs =
      __varyAll || __varyHdrs.size > VARY_MAX_NAMES
        ? "*"
        : Array.from(__varyHdrs).sort();
  }
  return __result;
}

/** Render the user's not-found.tsx (when a loader/action throws a 404)
 *  or pass through the thrown Response unchanged. */
/** `redirect()` / `json()` / `notFound()` return a plain BextResponse
 *  `{ status, headers: [name, value][], body }`, not a `Response`. A loader or
 *  action that THROWS one (`throw redirect("/login")`) means "answer with this"
 *  exactly like a thrown `Response`; without this it fell to the error
 *  boundary. Returned values are left alone (they are loader data). */
function isThrownBextResponse(e: unknown): e is { status: number; headers: [string, string][]; body?: unknown } {
  if (!e || typeof e !== "object" || e instanceof Error) return false;
  const r = e as any;
  return typeof r.status === "number" && r.status >= 100 && r.status < 600 && Array.isArray(r.headers)
    && r.headers.every((h: unknown) => Array.isArray(h) && h.length === 2);
}

function bextResponseToResponse(r: { status: number; headers: [string, string][]; body?: unknown }): Response {
  const headers = new Headers();
  for (const [name, value] of r.headers) headers.append(name, String(value));
  const body = r.body === undefined || r.body === null || r.body === "" ? null : String(r.body);
  return new Response(body, { status: r.status, headers });
}

async function renderResponseFallback(
  r: Response,
  args: RunRouteArgs,
): Promise<RouteResult> {
  const { layouts, notFoundComponent, templateComponent, envelope } = args;
  // 404 with a not-found.tsx → render it inside the layouts so the
  // shell stays consistent. Other statuses pass through verbatim.
  if (r.status === 404 && notFoundComponent) {
    const params = envelope.params ?? {};
    let _np = "/";
    try { _np = new URL(envelope.request?.url ?? "").pathname || "/"; } catch { /* keep "/" */ }
    // Layouts need the response status to emit head policy that belongs to the
    // document shell (notably a valid <meta name="robots" content="noindex">
    // for a 404). Existing layouts ignore this additive prop.
    const layoutProps = { route: { pathname: _np }, status: 404 };
    const headers: Array<[string, string]> = [["content-type", "text/html; charset=utf-8"]];
    if (r.headers && typeof (r.headers as any).forEach === "function") {
      (r.headers as any).forEach((v: string, k: string) => {
        if (k.toLowerCase() !== "content-type") headers.push([k, v]);
      });
    }
    let html = await collectRender(
      () => composeReplacement(notFoundComponent as Page, layouts, templateComponent, { params, ...layoutProps }, layoutProps),
      { params, ...layoutProps },
    );
    // The layouts' own metadata, resolved with status 404, so a layout can
    // own the 404's robots/title (the page's metadata doesn't apply here).
    html = injectMetadata(html, await layoutOnlyMetaHtml(args, _np, 404));
    // Same document contract as a normal page: a full document starts with
    // `<!DOCTYPE html>` (quirks mode otherwise). encodeResult re-applies this
    // to every text/html response; doing it here too keeps runRoute's own
    // return value a complete document for direct callers.
    return { kind: "response", status: 404, headers, body: prependDoctype(html) };
  }
  return await serializeResponse(r);
}

/** Render the user's error.tsx with the thrown error as a prop. Used
 *  when a loader/action throws something that isn't a Response. Returns
 *  a 500 response on top of the rendered error tree, so the page is
 *  still themed by the layouts. */
async function renderErrorBoundary(
  e: unknown,
  args: RunRouteArgs,
): Promise<RouteResult> {
  const { layouts, errorBoundary, templateComponent, envelope } = args;
  if (!errorBoundary) {
    // No co-located error.tsx — propagate so the host turns it into a
    // generic 5xx.
    throw e;
  }
  let _ep = "/";
  try { _ep = new URL(envelope?.request?.url ?? "").pathname || "/"; } catch { /* keep "/" */ }
  const layoutProps = { route: { pathname: _ep } };
  const err = e instanceof Error ? e : new Error(String(e));
  const errorPage: Page = (_props: any) =>
    errorBoundary({ error: err, reset: () => {}, ...layoutProps });
  let html = await collectRender(
    () => composeTree(errorPage, layouts, { error: err }, templateComponent, undefined, undefined, layoutProps),
    { error: err },
  );
  // Layout-only metadata resolved with status 500 (see renderResponseFallback).
  html = injectMetadata(html, await layoutOnlyMetaHtml(args, _ep, 500));
  return {
    kind: "response",
    status: 500,
    headers: [["content-type", "text/html; charset=utf-8"]],
    body: prependDoctype(html),
  };
}

/** Encode a RouteResult for the V8↔Rust contract.
 *
 *  Wire format (binary-IPC v1):
 *
 *      \x01v1\n{envelope_json}\n{body_raw}
 *
 *  - Sentinel `\x01v1\n` (4 bytes) marks the binary path. JSON values
 *    can't legally start with `\x01`, so the dispatcher distinguishes
 *    binary vs legacy by peeking the first byte.
 *  - `envelope_json` is the small per-route metadata (kind, status,
 *    headers, hasIslands) — small enough that serde_json overhead is
 *    negligible compared to the body it now skips.
 *  - `body_raw` is the rendered HTML / response body, NOT JSON-escaped.
 *    Saves both `JSON.stringify`'s escape pass in V8 AND
 *    `serde_json::from_str`'s unescape pass in the dispatcher
 *    (`skip_to_escape` was 4.20% of master CPU under load).
 *
 *  Falls back to legacy JSON if `globalThis.__bext_skip_binary_resp`
 *  is set (escape hatch — currently unused, but lets us A/B at runtime
 *  if a downstream ever miscounts bytes). */
export function encodeResult(r: RouteResult): string {
  if ((globalThis as any).__bext_skip_binary_resp) {
    return JSON.stringify(r);
  }
  let envelope: any;
  let body: string;
  let htmlDocResponse = false;
  if (r.kind === "response") {
    envelope = { kind: "response", status: r.status, headers: r.headers };
    if (r.body_encoding) envelope.body_encoding = r.body_encoding;
    body = r.body;
    // Every full HTML document PRISM emits starts with `<!DOCTYPE html>`:
    // the not-found / error.tsx renders AND a loader/action-returned HTML
    // `Response` all leave through here, whatever path produced them.
    // prependDoctype never doubles an existing doctype and ignores fragments.
    // (Applied below, once a branded body has been coerced to its string.)
    htmlDocResponse = !r.body_encoding && responseIsHtml(r.headers);
  } else {
    envelope = { kind: "html", hasIslands: r.hasIslands };
    // Auto render-result cache: the __bextPrismRender wrapper sets __bextPure
    // when this render touched no time/randomness/external state and didn't
    // interleave with another render. Only emit when true (absence ⇒ not
    // cacheable). The master reads this off the decoded envelope.
    if ((r as any).__bextPure === true) envelope.pure = true;
    // Loader wall-time (ms) → lets the Rust dispatcher split `loader;dur` out of
    // `render;dur` in Server-Timing. Absent/0 ⇒ no loader (or instant); the
    // dispatcher then keeps the legacy combined `render;dur`.
    const __lm = (r as any).__loaderMs;
    if (typeof __lm === "number" && __lm > 0) envelope.loaderMs = __lm;
    // Header vary-set for the master's render-result cache key projection —
    // `["cookie", ...]` (names the render read) or `"*"` (vary on all).
    const __vh = (r as any).__varyHdrs;
    if (__vh) envelope.varyHdrs = __vh;
    body = r.body;
  }
  // ZEROSTRIP: no sentinel scan. Safe-HTML is carried by the out-of-band
  // `SafeHtml` brand (jsx.ts `safe()` / the compile fold's `__bextSafe`), never
  // by an in-band \x01 marker — so the body is already clean and there is
  // nothing to strip. (The expensive 34µs/70KB `replace(/\x01/g, "")` pass is
  // gone for good.) We still coerce a branded body to its HTML string: a route
  // may return SafeHtml directly (e.g. `html(safe(…))` or a Response wrapping
  // component output); its toString yields the clean HTML. The wire envelope's
  // own \x01v1 framing prefix is added below, on the already-clean body.
  if (typeof body !== "string") body = String(body);
  if (htmlDocResponse) body = prependDoctype(body);
  return "\x01v1\n" + JSON.stringify(envelope) + "\n" + body;
}
