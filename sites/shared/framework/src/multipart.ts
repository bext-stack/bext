// Multipart/form-data parser, runnable in V8/JSC without Node/Web APIs.
//
// Pure TS — no Buffer, no Blob, no global FormData. Handles text fields
// and file uploads. Returns a FormData-like object with the same call
// surface so user code (`form.get("email")`, `form.getAll("tags")`) is
// drop-in.
//
// Designed for two callers:
//   1. The bext-server PRISM action wrapper (compiled with the
//      framework as a peer; the wrapper imports `parseMultipart`).
//   2. The build.ts __fetch action handler in the SSR production bundle.
//
// Body input is either a UTF-8 string (when the dispatcher decoded it
// as utf8) or a base64 string (when it didn't). Either way we lift to
// Uint8Array and walk the bytes.
//
// Boundary handling: the boundary comes from the Content-Type header
// (`multipart/form-data; boundary=…`). Every part starts with
// `--<boundary>` on its own line; the final part ends with
// `--<boundary>--`. Headers and body within a part are separated by
// `\r\n\r\n`.

export interface MultipartFile {
  /** The original filename from `Content-Disposition: filename="..."`.
   *  May be empty string if the client sent no filename. */
  name: string;
  /** MIME type from the part's `Content-Type` header.
   *  Defaults to `application/octet-stream` if absent. */
  type: string;
  /** Byte length of the file content. */
  size: number;
  /** Returns a fresh Uint8Array of the file content. Async to mirror
   *  the Web File API and to share the interface with the streaming
   *  parser, which reads bytes lazily on first access. */
  bytes(): Promise<Uint8Array>;
  /** Decode bytes as UTF-8 (lossy for binary content). */
  text(): Promise<string>;
  /** Return an ArrayBuffer copy of the file content. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A subset of the Web FormData interface — enough for typical
 *  server-action use. Iteration yields `[name, value]` tuples; values
 *  are either strings (text fields) or MultipartFile (uploads). */
export class MultipartFormData {
  private _entries: Array<[string, string | MultipartFile]> = [];

  append(name: string, value: string | MultipartFile): void {
    this._entries.push([name, value]);
  }
  get(name: string): string | MultipartFile | null {
    for (const [k, v] of this._entries) if (k === name) return v;
    return null;
  }
  getAll(name: string): Array<string | MultipartFile> {
    const out: Array<string | MultipartFile> = [];
    for (const [k, v] of this._entries) if (k === name) out.push(v);
    return out;
  }
  has(name: string): boolean {
    for (const [k] of this._entries) if (k === name) return true;
    return false;
  }
  set(name: string, value: string | MultipartFile): void {
    // Web FormData semantics: replace all existing with this single value.
    this._entries = this._entries.filter(([k]) => k !== name);
    this._entries.push([name, value]);
  }
  delete(name: string): void {
    this._entries = this._entries.filter(([k]) => k !== name);
  }
  *entries(): IterableIterator<[string, string | MultipartFile]> {
    for (const e of this._entries) yield [e[0], e[1]];
  }
  *keys(): IterableIterator<string> {
    for (const [k] of this._entries) yield k;
  }
  *values(): IterableIterator<string | MultipartFile> {
    for (const [, v] of this._entries) yield v;
  }
  [Symbol.iterator](): IterableIterator<[string, string | MultipartFile]> {
    return this.entries();
  }
  /** Number of entries (Web FormData has no `.size` but it's useful here). */
  get size(): number { return this._entries.length; }
  /** Plain-object snapshot for debugging / JSON-friendly logging. */
  toObject(): Record<string, string | MultipartFile | Array<string | MultipartFile>> {
    const out: Record<string, string | MultipartFile | Array<string | MultipartFile>> = {};
    for (const [k, v] of this._entries) {
      const cur = out[k];
      if (cur === undefined) out[k] = v;
      else if (Array.isArray(cur)) cur.push(v);
      else out[k] = [cur, v];
    }
    return out;
  }
}

/** Parse a multipart/form-data body.
 *
 *  Throws on malformed input — caller should wrap in try/catch and
 *  fall back to a 400 response. The parser is permissive about line
 *  endings (accepts CRLF or LF) but expects the canonical boundary
 *  syntax: `--<boundary>` opening and `--<boundary>--` closing.
 *
 *  @param body         body string (UTF-8 or base64) or already-decoded Uint8Array
 *  @param contentType  full `Content-Type` header value
 *  @param encoding     "utf8" (default) or "base64" — only honored if `body` is a string
 */
export function parseMultipart(
  body: string | Uint8Array,
  contentType: string,
  encoding: "utf8" | "base64" = "utf8",
): MultipartFormData {
  const boundary = extractBoundary(contentType);
  if (!boundary) {
    throw new Error("multipart: missing or invalid `boundary` in Content-Type");
  }

  const bytes = body instanceof Uint8Array ? body : stringToBytes(body, encoding);
  const result = new MultipartFormData();

  const dashBoundary = utf8Encode("--" + boundary);
  const headerSep = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]); // \r\n\r\n
  const headerSepLF = new Uint8Array([0x0a, 0x0a]); // \n\n (lenient fallback)

  // Find every boundary position. Each part lives between consecutive
  // boundaries; the last one (`--BOUNDARY--`) has no part after it.
  const boundaries: number[] = [];
  let p = indexOf(bytes, dashBoundary, 0);
  while (p >= 0) {
    boundaries.push(p);
    p = indexOf(bytes, dashBoundary, p + dashBoundary.length);
  }
  if (boundaries.length < 2) return result; // no complete parts

  for (let i = 0; i < boundaries.length - 1; i++) {
    const startMarker = boundaries[i];
    const endMarker = boundaries[i + 1];
    // Skip the boundary line. After `--BOUNDARY` we expect either
    // `\r\n` (continue) or `--\r\n` (terminator → handled by the loop
    // ending). Advance past the trailing \r\n if present.
    let s = startMarker + dashBoundary.length;
    if (s < bytes.length && bytes[s] === 0x0d && bytes[s + 1] === 0x0a) s += 2;
    else if (s < bytes.length && bytes[s] === 0x0a) s += 1; // lenient \n
    // The end marker is `\r\n--BOUNDARY` — strip the CRLF before it.
    let e = endMarker;
    if (e >= 2 && bytes[e - 2] === 0x0d && bytes[e - 1] === 0x0a) e -= 2;
    else if (e >= 1 && bytes[e - 1] === 0x0a) e -= 1;
    if (s >= e) continue; // empty / malformed part

    // Find the headers/body separator within the part bounds.
    let headerEndPos = indexOfWithin(bytes, headerSep, s, e);
    let separatorLen = 4;
    if (headerEndPos < 0) {
      headerEndPos = indexOfWithin(bytes, headerSepLF, s, e);
      separatorLen = 2;
    }
    if (headerEndPos < 0) {
      // Pure-headers part with no body — possible but unusual; accept
      // empty body.
      const headerStr = bytesToUtf8(bytes.subarray(s, e));
      const headers = parseHeaders(headerStr);
      const cd = headers["content-disposition"] || "";
      const { name, filename } = parseDisposition(cd);
      if (name) {
        if (filename != null) {
          result.append(
            name,
            makeMultipartFile(filename, headers["content-type"] || "application/octet-stream", new Uint8Array(0)),
          );
        } else {
          result.append(name, "");
        }
      }
      continue;
    }

    const headerStr = bytesToUtf8(bytes.subarray(s, headerEndPos));
    const bodyStart = headerEndPos + separatorLen;
    const partBody = bytes.subarray(bodyStart, e);

    const headers = parseHeaders(headerStr);
    const cd = headers["content-disposition"] || "";
    const { name, filename } = parseDisposition(cd);
    if (!name) continue; // unnamed part — skip

    if (filename != null) {
      const type = headers["content-type"] || "application/octet-stream";
      result.append(name, makeMultipartFile(filename, type, partBody));
    } else {
      // Text field — decode as UTF-8. Scrub the reserved \x01 safe-HTML
      // sentinel: it has no legitimate place in a form value and would
      // otherwise let an attacker forge the sentinel and bypass child
      // escaping when the field is later rendered. (File parts above keep
      // their raw bytes — binary-safe.)
      const text = bytesToUtf8(partBody);
      result.append(name, text.indexOf("\x01") === -1 ? text : text.replace(/\x01/g, ""));
    }
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────

function extractBoundary(contentType: string): string | null {
  // RFC 2046: `boundary` parameter, optionally quoted.
  const m = /boundary=("([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  return m[2] || m[3] || null;
}

function parseHeaders(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on \r\n or \n.
  const lines = s.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

interface Disposition { name: string | null; filename: string | null; }
function parseDisposition(value: string): Disposition {
  // Format: form-data; name="email"
  //         form-data; name="avatar"; filename="cat.jpg"
  // Quotes optional. Param values may contain spaces inside quotes.
  let name: string | null = null;
  let filename: string | null = null;
  const params = value.split(";");
  for (const p of params) {
    const trimmed = p.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim().toLowerCase();
    let v = trimmed.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    // Per RFC 7578 §4.3 use filename* if filename* present (RFC 5987
    // encoded). Most clients still send filename=. Accept both.
    if (k === "name") name = v;
    else if (k === "filename" || k === "filename*") filename = v;
  }
  return { name, filename };
}

function makeMultipartFile(
  name: string,
  type: string,
  bodyBytes: Uint8Array,
): MultipartFile {
  // Defensive copy so callers can't accidentally mutate the parser's
  // internal buffer (Uint8Array.subarray returns a view).
  const owned = new Uint8Array(bodyBytes.length);
  owned.set(bodyBytes);
  return {
    name,
    type,
    size: owned.length,
    async bytes(): Promise<Uint8Array> {
      const out = new Uint8Array(owned.length);
      out.set(owned);
      return out;
    },
    async text(): Promise<string> { return bytesToUtf8(owned); },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const out = new Uint8Array(owned.length);
      out.set(owned);
      return out.buffer;
    },
  };
}

// ── Byte-level utilities ───────────────────────────────────────────────

/** `Uint8Array.indexOf` for byte sequences. Returns -1 if not found. */
function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  return indexOfWithin(haystack, needle, from, haystack.length);
}

/** Constrained `indexOf` — only searches `[from, end)`. */
function indexOfWithin(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number,
  end: number,
): number {
  if (needle.length === 0) return from;
  const last = end - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Encode a JS string to UTF-8 bytes. Self-contained (no TextEncoder). */
function utf8Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 4);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      out[n++] = c;
    } else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3f);
    } else if (c < 0xd800 || c >= 0xe000) {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    } else {
      // Surrogate pair → 4-byte UTF-8.
      i++;
      const c2 = s.charCodeAt(i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out[n++] = 0xf0 | (cp >> 18);
      out[n++] = 0x80 | ((cp >> 12) & 0x3f);
      out[n++] = 0x80 | ((cp >> 6) & 0x3f);
      out[n++] = 0x80 | (cp & 0x3f);
    }
  }
  return out.subarray(0, n);
}

/** Decode UTF-8 bytes to JS string. Self-contained (no TextDecoder).
 *  Lossy for invalid sequences — replaces with U+FFFD. */
function bytesToUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      out += String.fromCharCode(b1);
    } else if ((b1 & 0xe0) === 0xc0) {
      const b2 = bytes[i++];
      out += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if ((b1 & 0xf0) === 0xe0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      out += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else if ((b1 & 0xf8) === 0xf0) {
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const b4 = bytes[i++];
      const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      // Encode as surrogate pair.
      const offset = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10));
      out += String.fromCharCode(0xdc00 + (offset & 0x3ff));
    } else {
      out += "�"; // replacement char for invalid byte
    }
  }
  return out;
}

/** Decode a body string into bytes. UTF-8 (default) or base64.
 *  Self-contained — no Buffer / atob fallback chain to keep V8 portable. */
function stringToBytes(s: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "base64") return base64Decode(s);
  return utf8Encode(s);
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_MAP = (() => {
  const m = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) m[B64_CHARS.charCodeAt(i)] = i;
  return m;
})();

function base64Decode(s: string): Uint8Array {
  // Strip whitespace + padding.
  let clean = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d /* = */ || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 128 && B64_MAP[c] >= 0) clean += s[i];
  }
  const len = clean.length;
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = i < len ? B64_MAP[clean.charCodeAt(i)] : 0;
    const b = i + 1 < len ? B64_MAP[clean.charCodeAt(i + 1)] : 0;
    const c = i + 2 < len ? B64_MAP[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < len ? B64_MAP[clean.charCodeAt(i + 3)] : 0;
    out[o++] = (a << 2) | (b >> 4);
    if (i + 2 < len) out[o++] = ((b & 0x0f) << 4) | (c >> 2);
    if (i + 3 < len) out[o++] = ((c & 0x03) << 6) | d;
  }
  return out.subarray(0, o);
}
