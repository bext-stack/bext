// auth.ts — authentication primitives for PRISM apps (cookies, signed sessions, PKCE).
//
// The counterpart to authz (authorization): this is the *authentication* half —
// the reusable core that ~31 sites currently copy-paste into their own
// `oidc.ts` (a `parseCookies`, an HMAC-signed session cookie, a `readSession`,
// PKCE bits). It's the app-developer facade over the Rust Auth / Session
// capabilities, but self-contained: HMAC-SHA256 is implemented in pure JS so it
// runs identically on V8 and QuickJS with no `node:crypto` / WebCrypto
// dependency (unlike the copies, which mix both).
//
//   const session = createSession<{ userId: string }>({ secret: process.env.SECRET, maxAgeSecs: 86400 });
//
//   // loader — read + verify (tampered / expired → null):
//   const s = session.read(request);          // { userId } | null
//
//   // action — issue a signed cookie:
//   return new Response(null, { status: 303, headers: { location: "/", "set-cookie": session.cookie({ userId }) } });
//   // …or clear it: session.clearCookie()

// ===========================================================================
// Pure-JS SHA-256 + HMAC (no node:crypto, no WebCrypto — isolate-safe)
// ===========================================================================

// prettier-ignore
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;
  const bitLen = len * 8;
  const withOne = len + 1;
  const pad = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + pad + 8;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 4, bitLen >>> 0, false);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false); odv.setUint32(4, h1, false); odv.setUint32(8, h2, false); odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false); odv.setUint32(20, h5, false); odv.setUint32(24, h6, false); odv.setUint32(28, h7, false);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}

function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const block = 64;
  let k = key.length > block ? sha256(key) : key;
  if (k.length < block) {
    const kk = new Uint8Array(block);
    kk.set(k);
    k = kk;
  }
  const ipad = new Uint8Array(block);
  const opad = new Uint8Array(block);
  for (let i = 0; i < block; i++) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  return sha256(concat(opad, sha256(concat(ipad, msg))));
}

// --- base64url + utf8 ------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64INV: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64INV[B64[i]] = i;

function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64[b2 & 63];
  }
  return out;
}

function b64urlDecode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i += 4) {
    const c0 = B64INV[str[i]];
    const c1 = B64INV[str[i + 1]];
    if (c0 === undefined || c1 === undefined) break;
    out.push((c0 << 2) | (c1 >> 4));
    const ch2 = str[i + 2];
    if (ch2 !== undefined && B64INV[ch2] !== undefined) {
      const c2 = B64INV[ch2];
      out.push(((c1 & 15) << 4) | (c2 >> 2));
      const ch3 = str[i + 3];
      if (ch3 !== undefined && B64INV[ch3] !== undefined) {
        out.push(((c2 & 3) << 6) | B64INV[ch3]);
      }
    }
  }
  return new Uint8Array(out);
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** Hex HMAC-SHA256 — the format Stripe / GitHub / most webhook signatures use. */
export function hmacSha256Hex(secret: string, message: string): string {
  return bytesToHex(hmacSha256(ENC.encode(secret), ENC.encode(message)));
}

/** Raw HMAC-SHA256 bytes (pure JS). The building block behind `hmacSha256Hex`,
 *  `createSigner`, and the OIDC session/flow envelopes in `./oidc`. */
export function hmacSha256Bytes(secret: string, message: string): Uint8Array {
  return hmacSha256(ENC.encode(secret), ENC.encode(message));
}

/** Raw SHA-256 bytes of a UTF-8 string (pure JS, isolate-safe). */
export function sha256Bytes(message: string): Uint8Array {
  return sha256(ENC.encode(message));
}

/** Constant-time string equality (avoids leaking the secret via timing). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ===========================================================================
// Signer
// ===========================================================================

export interface Signer {
  /** HMAC-SHA256 of `payload`, base64url. */
  sign(payload: string): string;
  /** Constant-time signature check. */
  verify(payload: string, signature: string): boolean;
}

export function createSigner(secret: string): Signer {
  const key = ENC.encode(secret);
  return {
    sign(payload) {
      return b64urlEncode(hmacSha256(key, ENC.encode(payload)));
    },
    verify(payload, signature) {
      return timingSafeEqual(this.sign(payload), signature);
    },
  };
}

// ===========================================================================
// Cookie helpers
// ===========================================================================

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface CookieOptions {
  path?: string;
  maxAge?: number;
  domain?: string;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  httpOnly?: boolean;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  let s = `${name}=${encodeURIComponent(value)}`;
  s += `; Path=${opts.path ?? "/"}`;
  if (opts.maxAge !== undefined) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  s += `; SameSite=${opts.sameSite ?? "Lax"}`;
  if (opts.httpOnly !== false) s += "; HttpOnly";
  if (opts.secure !== false) s += "; Secure";
  return s;
}

// ===========================================================================
// Signed session
// ===========================================================================

export interface SessionOptions {
  secret: string;
  /** Cookie name. Default `"bext_session"`. */
  cookie?: string;
  /** Lifetime in seconds (also the cookie Max-Age). Default 86400 (1 day). */
  maxAgeSecs?: number;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  path?: string;
}

export interface Session<T> {
  /** Read + verify the session cookie on a request. Tampered / expired → null. */
  read(request: Request): T | null;
  /** Verify a raw token string → payload or null. */
  verify(token: string): T | null;
  /** Produce a signed token for `data`. */
  issue(data: T): string;
  /** A `Set-Cookie` header value carrying a signed session for `data`. */
  cookie(data: T): string;
  /** A `Set-Cookie` header value that clears the session. */
  clearCookie(): string;
  readonly cookieName: string;
}

/** A tamper-proof, expiring, HMAC-signed cookie session. */
export function createSession<T extends Record<string, unknown>>(opts: SessionOptions): Session<T> {
  const signer = createSigner(opts.secret);
  const name = opts.cookie ?? "bext_session";
  const maxAge = opts.maxAgeSecs ?? 86400;

  const issue: Session<T>["issue"] = (data) => {
    const now = Math.floor(Date.now() / 1000);
    const body = { ...data, iat: now, exp: now + maxAge };
    const payload = b64urlEncode(ENC.encode(JSON.stringify(body)));
    return `${payload}.${signer.sign(payload)}`;
  };

  const verify: Session<T>["verify"] = (token) => {
    const dot = token.lastIndexOf(".");
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!signer.verify(payload, sig)) return null;
    let body: any;
    try {
      body = JSON.parse(DEC.decode(b64urlDecode(payload)));
    } catch {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (typeof body.exp === "number" && now > body.exp) return null;
    const { iat, exp, ...rest } = body;
    return rest as T;
  };

  return {
    cookieName: name,
    issue,
    verify,
    read(request) {
      const token = parseCookies(request.headers.get("cookie"))[name];
      return token ? verify(token) : null;
    },
    cookie(data) {
      return serializeCookie(name, issue(data), {
        maxAge,
        sameSite: opts.sameSite ?? "Lax",
        secure: opts.secure,
        path: opts.path,
        httpOnly: true,
      });
    },
    clearCookie() {
      return serializeCookie(name, "", {
        maxAge: 0,
        sameSite: opts.sameSite ?? "Lax",
        secure: opts.secure,
        path: opts.path,
        httpOnly: true,
      });
    },
  };
}

// ===========================================================================
// OAuth / OIDC helpers (PKCE + authorization URL) — pure, provider-agnostic
// ===========================================================================

/** Cryptographically-random token if `crypto.getRandomValues` is available,
 *  else a Math.random fallback (documented — inject entropy for hardening). */
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  const c = (globalThis as any).crypto;
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLength; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return b64urlEncode(bytes);
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** The S256 challenge for a given verifier: `base64url(sha256(verifier))`. */
export function pkceChallengeFromVerifier(verifier: string): string {
  return b64urlEncode(sha256(ENC.encode(verifier)));
}

/** A PKCE verifier + S256 challenge. */
export function pkceChallenge(): PkcePair {
  const verifier = randomToken(32);
  return { verifier, challenge: pkceChallengeFromVerifier(verifier), method: "S256" };
}

/** base64url of raw bytes (no padding). */
export function base64urlEncode(bytes: Uint8Array): string {
  return b64urlEncode(bytes);
}
/** Decode base64url to bytes. */
export function base64urlDecode(str: string): Uint8Array {
  return b64urlDecode(str);
}

export interface AuthorizeUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
  codeChallenge?: string;
  responseType?: string;
  extra?: Record<string, string>;
}

/** Build an OAuth2/OIDC authorization URL (adds `code_challenge_method=S256`
 *  when a challenge is given). */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const url = new URL(p.authorizationEndpoint);
  const q = url.searchParams;
  q.set("response_type", p.responseType ?? "code");
  q.set("client_id", p.clientId);
  q.set("redirect_uri", p.redirectUri);
  if (p.scope) q.set("scope", p.scope);
  if (p.state) q.set("state", p.state);
  if (p.codeChallenge) {
    q.set("code_challenge", p.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(p.extra ?? {})) q.set(k, v);
  return url.toString();
}
