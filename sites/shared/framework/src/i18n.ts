// i18n.ts — localization for PRISM apps (message catalogs + request locale).
//
// The app-developer counterpart to the Rust I18n capability (see docs
// /capabilities/i18n), and the shared replacement for the per-site `i18n.ts`
// copies. Message catalogs per locale, `t(key, params)` with `{placeholder}`
// interpolation, pluralization, a fallback locale, and locale detection from a
// request (path prefix → cookie → Accept-Language → default). Pure TypeScript.
//
//   const i18n = createI18n({
//     default: "en",
//     locales: {
//       en: { greeting: "Hello, {name}!", items: "{count} item | {count} items" },
//       fr: { greeting: "Bonjour, {name} !", items: "{count} article | {count} articles" },
//     },
//   });
//
//   const t = i18n.for(i18n.detect(request));   // a Translator for the request's locale
//   t.t("greeting", { name: "Ada" });            // "Hello, Ada!"
//   t.n("items", 3);                             // "3 items"

export type Messages = Record<string, string>;

export interface I18nConfig {
  /** locale code → message catalog. */
  locales: Record<string, Messages>;
  /** Locale used when none is detected. */
  default: string;
  /** Locale consulted when a key is missing in the active locale (default: `default`). */
  fallback?: string;
  /** Cookie name that carries a locale override. Default `"locale"`. */
  cookie?: string;
}

export interface Translator {
  readonly locale: string;
  /** Translate a key, interpolating `{placeholder}` from `params`. Missing keys
   *  fall back to the fallback locale, then to the key itself. */
  t(key: string, params?: Record<string, unknown>): string;
  /** Pluralized translation. The catalog value is `"one form | other form"`
   *  (optionally `"zero | one | other"`); `{count}` interpolates. */
  n(key: string, count: number, params?: Record<string, unknown>): string;
  /** Is the key present in this locale (or the fallback)? */
  has(key: string): boolean;
}

export interface I18n {
  /** A Translator bound to a locale (falls back to default for unknown locales). */
  for(locale: string): Translator;
  /** Detect the locale for a request: path prefix → cookie → Accept-Language → default. */
  detect(request: Request): string;
  /** The configured locale codes. */
  readonly locales: string[];
}

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

function parseCookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return undefined;
}

export function createI18n(config: I18nConfig): I18n {
  const codes = Object.keys(config.locales);
  const fallback = config.fallback ?? config.default;
  const cookieName = config.cookie ?? "locale";

  const lookup = (locale: string, key: string): string | undefined => {
    const cat = config.locales[locale];
    if (cat && key in cat) return cat[key];
    const fb = config.locales[fallback];
    if (fb && key in fb) return fb[key];
    return undefined;
  };

  const makeTranslator = (locale: string): Translator => {
    const active = config.locales[locale] ? locale : config.default;
    return {
      locale: active,
      t(key, params) {
        const raw = lookup(active, key);
        return raw === undefined ? key : interpolate(raw, params);
      },
      n(key, count, params) {
        const raw = lookup(active, key);
        if (raw === undefined) return key;
        const forms = raw.split("|").map((s) => s.trim());
        // forms: [other] | [one, other] | [zero, one, other]
        let form: string;
        if (forms.length >= 3) form = count === 0 ? forms[0] : count === 1 ? forms[1] : forms[2];
        else if (forms.length === 2) form = count === 1 ? forms[0] : forms[1];
        else form = forms[0];
        return interpolate(form, { count, ...params });
      },
      has(key) {
        return lookup(active, key) !== undefined;
      },
    };
  };

  return {
    locales: codes,
    for: makeTranslator,
    detect(request) {
      const url = new URL(request.url);
      // 1. path prefix: /<locale>/...
      const seg = url.pathname.split("/")[1];
      if (seg && config.locales[seg]) return seg;
      // 2. cookie override
      const c = parseCookieValue(request.headers.get("cookie"), cookieName);
      if (c && config.locales[c]) return c;
      // 3. Accept-Language (respecting q-weights, matching base language)
      const al = request.headers.get("accept-language");
      if (al) {
        const ranked = al
          .split(",")
          .map((part) => {
            const [tag, q] = part.trim().split(";q=");
            return { tag: tag.trim().toLowerCase(), q: q ? parseFloat(q) : 1 };
          })
          .sort((a, b) => b.q - a.q);
        for (const { tag } of ranked) {
          if (config.locales[tag]) return tag;
          const base = tag.split("-")[0];
          if (config.locales[base]) return base;
        }
      }
      // 4. default
      return config.default;
    },
  };
}
