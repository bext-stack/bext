// oidc.ts — an OIDC authorization-code (public PKCE) client factory for PRISM apps.
//
// ~30 sites currently copy-paste a ~500-line `src/lib/oidc.ts`: the same
// hand-rolled SHA-256/HMAC, the same PKCE + authorize-URL + token-exchange, the
// same HMAC-signed single-cookie session and flow envelopes, the same
// readSession/requireSession gate. They differ only in CONFIG — client id,
// cookie names, session secret, the flow-state carrier (`ret` redirect vs
// `popup` postMessage), and the session payload shape.
//
// `createOidcClient(config)` collapses all of that into one configured object,
// so a site's `lib/oidc.ts` becomes a thin re-export shim (the examples-prism
// pattern) and the hundreds of `import … from "../lib/oidc"` call-sites never
// change. It is BYTE-COMPATIBLE with the hand-rolled copies (same b64url, same
// HMAC-over-base64url-payload envelope, same cookie attributes) — proven in
// oidc.test.ts against an inlined copy of the sites' exact algorithm — so a
// migrated site keeps validating already-issued live cookies.
//
//   const client = createOidcClient<Session>({
//     clientId: "inklura-admin",
//     redirectUri: "https://seo.inklura.fr/auth/callback",
//     sessionSecret: () => readSecret(),        // lazy resolver (see landmine below)
//     sessionCookieName: "inkadmin_session",
//     flowCookieName: "inkadmin_flow",
//     flowCarrier: "ret",
//   });
//   export const { readSession, requireSession, buildAuthorizeUrl, exchangeCode,
//                  decodeIdToken, packSession, sessionCookie /* … */ } = client;
//
// Composes the crypto in ./auth (pure-JS SHA-256/HMAC/base64url), so it runs
// identically on V8 and QuickJS with no node:crypto / WebCrypto dependency —
// which is load-bearing, because PRISM's isolate stubs both.

import {
  base64urlEncode,
  base64urlDecode,
  hmacSha256Bytes,
  sha256Bytes,
  timingSafeEqual,
  parseCookies as parseCookiesImpl,
  randomToken,
} from "./auth";
import { safeLocalPath } from "./url";

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// --- primitives that match the copies' exact byte output ------------------

/** base64url (no padding) of raw bytes — the copies' `b64url`. */
function b64url(buf: ArrayBufferLike | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return base64urlEncode(bytes);
}

/** UTF-8 → base64url of a JSON-ish string payload. */
function b64urlStr(s: string): string {
  return base64urlEncode(ENC.encode(s));
}

/** base64url → UTF-8 string (the copies' `b64urlDecode`). */
function b64urlToStr(s: string): string {
  return DEC.decode(base64urlDecode(s));
}

// =========================================================================

export type FlowCarrier = "ret" | "popup";

export interface OidcClientConfig {
  /** Authorization server. Default `https://auth.1clic.pro` (the bext IdP). */
  issuer?: string;
  /** OAuth client id (public — no secret is sent, PKCE only). */
  clientId: string;
  /** Space-delimited scopes. Default `openid profile email offline_access`. */
  scopes?: string;
  /** Static redirect URI, or a per-request resolver (multi-host sites). */
  redirectUri: string | ((request: Request) => string);
  authorizePath?: string; // default "/oauth2/authorize"
  tokenPath?: string; // default "/oauth2/token"
  /** HMAC secret for the session + flow cookies. A function is resolved on
   *  every use — REQUIRED for sites whose per-site `[env]` is only available
   *  lazily (a module-eval string would capture undefined on a cold worker). */
  sessionSecret: string | (() => string);
  sessionCookieName?: string; // default "bext_session"
  flowCookieName?: string; // default "bext_flow"
  sessionTtlSecs?: number; // default 86400
  flowCookieTtlSecs?: number; // default 600
  /** How /callback hands control back: `ret` = 303 to a saved path (gated
   *  consoles); `popup` = postMessage to the opener (login popups). Default `ret`. */
  flowCarrier?: FlowCarrier;
  /** Session cookie HttpOnly. Default FALSE — the copies deliberately let the
   *  client decode the display name; the HMAC keeps it tamper-proof. */
  sessionHttpOnly?: boolean;
  /** Where `requireSession` bounces an anonymous visitor. Default `/auth/login`. */
  loginPath?: string;
  /** Injectable fetch (tests / non-global runtimes). Default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  id_token: string;
  scope?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  preferred_username?: string;
  tenant_id?: string;
  [k: string]: unknown;
}

export interface OidcClient<T extends Record<string, unknown>> {
  // config echo (so the shim can re-export the copies' consts)
  readonly ISSUER: string;
  readonly CLIENT_ID: string;
  readonly SCOPES: string;
  readonly SESSION_COOKIE_NAME: string;
  readonly FLOW_COOKIE_NAME: string;
  readonly SESSION_TTL_SECS: number;
  readonly FLOW_COOKIE_TTL_SECS: number;

  // pkce + randomness
  b64url(buf: ArrayBufferLike | Uint8Array): string;
  randomB64(byteLen: number): string;
  generateCodeVerifier(): string;
  generateCodeChallenge(verifier: string): Promise<string>;
  generateState(): string;
  generateNonce(): string;

  // authorize + token
  buildAuthorizeUrl(args: {
    codeChallenge: string;
    state: string;
    nonce: string;
    redirectUri?: string;
    request?: Request;
  }): string;
  exchangeCode(args: {
    code: string;
    codeVerifier: string;
    redirectUri?: string;
    request?: Request;
  }): Promise<TokenResponse>;
  decodeIdToken(token: string): IdTokenClaims;

  // signing (raw + explicit-secret verify for cross-app SSO hand-offs)
  hmacSha256(key: string, message: string): Uint8Array;
  verifyTokenWith<V = Record<string, unknown>>(secret: string, token: string): V | null;

  // session
  packSession(s: T): string;
  unpackSession(token: string): T | null;
  readSession(request: Request): T | null;
  sessionCookie(value: string, maxAge?: number): string;
  clearSessionCookie(): string;

  // flow envelope
  buildFlowState(args: { pkce: string; state: string; nonce: string; ret?: string; popup?: boolean }): FlowState;
  flowEnvelopeCookie(f: FlowState): string;
  clearFlowEnvelope(): string;
  readFlowEnvelope(request: Request): FlowState | null;

  // cookies + gate
  parseCookies(header: string): Record<string, string>;
  requireSession(request: Request): T | Response;
  requireSessionJson(request: Request): T | Response;
  sanitizeReturnPath(raw: string | null): string;
}

export interface FlowState {
  pkce: string;
  state: string;
  nonce: string;
  ts: number;
  ret?: string;
  popup?: boolean;
}

export function createOidcClient<T extends Record<string, unknown> = Record<string, unknown>>(
  config: OidcClientConfig,
): OidcClient<T> {
  const ISSUER = config.issuer ?? "https://auth.1clic.pro";
  const CLIENT_ID = config.clientId;
  const SCOPES = config.scopes ?? "openid profile email offline_access";
  const authorizePath = config.authorizePath ?? "/oauth2/authorize";
  const tokenPath = config.tokenPath ?? "/oauth2/token";
  const SESSION_COOKIE_NAME = config.sessionCookieName ?? "bext_session";
  const FLOW_COOKIE_NAME = config.flowCookieName ?? "bext_flow";
  const SESSION_TTL_SECS = config.sessionTtlSecs ?? 24 * 60 * 60;
  const FLOW_COOKIE_TTL_SECS = config.flowCookieTtlSecs ?? 600;
  const carrier: FlowCarrier = config.flowCarrier ?? "ret";
  const sessionHttpOnly = config.sessionHttpOnly ?? false;
  const loginPath = config.loginPath ?? "/auth/login";

  const secret = (): string =>
    typeof config.sessionSecret === "function" ? config.sessionSecret() : config.sessionSecret;

  const redirectFor = (override?: string, request?: Request): string => {
    if (override) return override;
    if (typeof config.redirectUri === "function") {
      if (!request) throw new Error("oidc: redirectUri is a per-request resolver — pass { request }");
      return config.redirectUri(request);
    }
    return config.redirectUri;
  };

  // sign(payload) = base64url(HMAC-SHA256(secret, payload)) — HMAC over the
  // base64url payload STRING, exactly as the hand-rolled copies do.
  const sign = (payload: string): string => b64url(hmacSha256Bytes(secret(), payload));

  const sigOk = (payload: string, sig: string): boolean => {
    // constant-time compare of the base64url signatures (no-pad, so a string
    // compare is equivalent to the copies' decoded-byte compare).
    try {
      return timingSafeEqual(sig, sign(payload));
    } catch {
      return false;
    }
  };

  const now = (): number => Math.floor(Date.now() / 1000);

  function packWith(obj: Record<string, unknown>): string {
    const payload = b64urlStr(JSON.stringify(obj));
    return payload + "." + sign(payload);
  }

  function unpackWith(token: string): Record<string, unknown> | null {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!sigOk(payload, sig)) return null;
    try {
      return JSON.parse(b64urlToStr(payload)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  const fetchImpl: typeof fetch = config.fetchImpl ?? (globalThis as any).fetch;

  const client: OidcClient<T> = {
    ISSUER,
    CLIENT_ID,
    SCOPES,
    SESSION_COOKIE_NAME,
    FLOW_COOKIE_NAME,
    SESSION_TTL_SECS,
    FLOW_COOKIE_TTL_SECS,

    b64url,
    randomB64(byteLen) {
      const buf = new Uint8Array(byteLen);
      const c = (globalThis as any).crypto;
      if (c && typeof c.getRandomValues === "function") c.getRandomValues(buf);
      else return randomToken(byteLen);
      return b64url(buf);
    },
    generateCodeVerifier() {
      return client.randomB64(32);
    },
    generateCodeChallenge(verifier) {
      return Promise.resolve(b64url(sha256Bytes(verifier)));
    },
    generateState() {
      return client.randomB64(24);
    },
    generateNonce() {
      return client.randomB64(24);
    },

    buildAuthorizeUrl(args) {
      const qs = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: redirectFor(args.redirectUri, args.request),
        scope: SCOPES,
        state: args.state,
        nonce: args.nonce,
        code_challenge: args.codeChallenge,
        code_challenge_method: "S256",
      });
      return ISSUER + authorizePath + "?" + qs.toString();
    },
    async exchangeCode(args) {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: args.code,
        redirect_uri: redirectFor(args.redirectUri, args.request),
        client_id: CLIENT_ID,
        code_verifier: args.codeVerifier,
      });
      const res = await fetchImpl(ISSUER + tokenPath, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error("token_exchange_" + res.status + ":" + text.slice(0, 200));
      }
      return (await res.json()) as TokenResponse;
    },
    decodeIdToken(token) {
      if (!token || typeof token !== "string") throw new Error("empty");
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("parts=" + parts.length);
      let json: string;
      try {
        json = b64urlToStr(parts[1]);
      } catch (e) {
        throw new Error("b64decode:" + (e instanceof Error ? e.message.slice(0, 40) : "x"));
      }
      try {
        return JSON.parse(json) as IdTokenClaims;
      } catch (e) {
        throw new Error("json:" + (e instanceof Error ? e.message.slice(0, 40) : "x"));
      }
    },

    hmacSha256(key, message) {
      return hmacSha256Bytes(key, message);
    },
    verifyTokenWith<V = Record<string, unknown>>(explicitSecret: string, token: string): V | null {
      if (!explicitSecret || explicitSecret.length < 32) return null;
      const dot = token.lastIndexOf(".");
      if (dot < 0) return null;
      const payload = token.slice(0, dot);
      const sig = token.slice(dot + 1);
      try {
        if (!timingSafeEqual(sig, b64url(hmacSha256Bytes(explicitSecret, payload)))) return null;
      } catch {
        return null;
      }
      let obj: any;
      try {
        obj = JSON.parse(b64urlToStr(payload));
      } catch {
        return null;
      }
      if (obj && typeof obj.exp === "number" && obj.exp < now()) return null;
      return obj as V;
    },

    packSession(s) {
      return packWith(s as Record<string, unknown>);
    },
    unpackSession(token) {
      const s = unpackWith(token);
      if (!s) return null;
      if (typeof s.exp !== "number" || (s.exp as number) < now()) return null;
      if (!s.sub) return null;
      return s as T;
    },
    readSession(request) {
      const token = client.parseCookies(request.headers.get("cookie") ?? "")[SESSION_COOKIE_NAME];
      return token ? client.unpackSession(token) : null;
    },
    sessionCookie(value, maxAge) {
      const ma = maxAge ?? SESSION_TTL_SECS;
      return (
        SESSION_COOKIE_NAME +
        "=" +
        encodeURIComponent(value) +
        "; Path=/; SameSite=Lax; Secure; Max-Age=" +
        ma +
        (sessionHttpOnly ? "; HttpOnly" : "")
      );
    },
    clearSessionCookie() {
      return (
        SESSION_COOKIE_NAME +
        "=; Path=/; Max-Age=0; SameSite=Lax; Secure" +
        (sessionHttpOnly ? "; HttpOnly" : "")
      );
    },

    buildFlowState(args) {
      const f: FlowState = { pkce: args.pkce, state: args.state, nonce: args.nonce, ts: now() };
      if (carrier === "ret") f.ret = args.ret ?? "/";
      else f.popup = args.popup ?? true;
      return f;
    },
    flowEnvelopeCookie(f) {
      return (
        FLOW_COOKIE_NAME +
        "=" +
        packWith(f as unknown as Record<string, unknown>) +
        "; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=" +
        FLOW_COOKIE_TTL_SECS
      );
    },
    clearFlowEnvelope() {
      return FLOW_COOKIE_NAME + "=; Path=/; Max-Age=0; SameSite=None; Secure; HttpOnly";
    },
    readFlowEnvelope(request) {
      const raw = client.parseCookies(request.headers.get("cookie") ?? "")[FLOW_COOKIE_NAME];
      if (!raw) return null;
      const f = unpackWith(raw) as FlowState | null;
      if (!f) return null;
      const ageSecs = Date.now() / 1000 - f.ts;
      if (!isFinite(ageSecs) || ageSecs < 0 || ageSecs > FLOW_COOKIE_TTL_SECS) return null;
      if (!f.pkce || !f.state || !f.nonce) return null;
      return f;
    },

    parseCookies(header) {
      return parseCookiesImpl(header);
    },
    requireSession(request) {
      const session = client.readSession(request);
      if (session) return session;
      const url = new URL(request.url);
      const ret = url.pathname + url.search;
      return new Response(null, {
        status: 303,
        headers: { Location: loginPath + "?return=" + encodeURIComponent(ret || "/") },
      });
    },
    requireSessionJson(request) {
      const session = client.readSession(request);
      if (session) return session;
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
    sanitizeReturnPath(raw) {
      return safeLocalPath(raw, "/");
    },
  };

  return client;
}
