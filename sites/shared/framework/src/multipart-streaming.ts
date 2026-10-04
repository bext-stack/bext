// Streaming multipart parser. Walks an on-disk multipart body in
// fixed-size chunks via a `readChunk` callback (V8 binds this to the
// `__bextReadChunk` native that reads from a confined spool path on
// disk). Memory footprint is parser state + one chunk + header
// buffers — independent of total upload size.
//
// Output is a `MultipartFormData` with the same shape as the
// in-memory parser. Files are produced as `MultipartFile` objects
// whose `bytes()`/`text()`/`arrayBuffer()` lazy-read from the same
// source file via the chunk-reader closure. Headers and boundary
// scanning are CPU-bound but stream through; only when the user
// calls `file.bytes()` do we materialize a single file's worth of
// bytes in memory.

import { type MultipartFile } from "./multipart";

// Local FormData implementation. We can't `import { MultipartFormData
// } from "./multipart"` because the prism-action-wrapper bundler
// inlines per-module IIFEs but doesn't wire cross-module `require()`
// calls between them — the streaming module would see
// `multipart_1.MultipartFormData` as undefined at runtime. The
// upstream `MultipartFormData` class has identical shape; this
// duplication is structural and intentional. Kept as a single source
// only at the public-API level (both expose the same type contract).
class StreamingFormData {
  private _entries: Array<[string, string | MultipartFile]> = [];
  append(name: string, value: string | MultipartFile): void { this._entries.push([name, value]); }
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
    this._entries = this._entries.filter(([k]) => k !== name);
    this._entries.push([name, value]);
  }
  delete(name: string): void { this._entries = this._entries.filter(([k]) => k !== name); }
  *entries(): IterableIterator<[string, string | MultipartFile]> {
    for (const e of this._entries) yield [e[0], e[1]];
  }
  *keys(): IterableIterator<string> { for (const [k] of this._entries) yield k; }
  *values(): IterableIterator<string | MultipartFile> { for (const [, v] of this._entries) yield v; }
  [Symbol.iterator]() { return this.entries(); }
  get size(): number { return this._entries.length; }
}

/** Shape of the V8-side chunk reader. Matches the native bridge's
 *  return type: a Uint8Array of up to `length` bytes, or `null` at
 *  EOF (offset >= file size). */
export type ReadChunkFn = (
  path: string,
  offset: number,
  length: number,
) => Uint8Array | null;

/** Default chunk size — 64 KiB. Boundary scans peek across two
 *  consecutive chunks so a needle straddling a chunk border still
 *  matches; the maximum needle length we ever scan for is
 *  `--<boundary>` (~70 bytes). */
const DEFAULT_CHUNK = 64 * 1024;

/** Parse a multipart body that lives on disk at `path`. The reader
 *  callback is wired by the host (V8) to a sandboxed file-read API.
 *
 *  Throws on malformed input; callers should wrap in try/catch and
 *  surface a 400. The parser is permissive about line endings (CRLF
 *  or LF) but expects standard `--<boundary>` opening and
 *  `--<boundary>--` closing.
 *
 *  @param path        spool-file path the host gave us; passed
 *                     verbatim to readChunk
 *  @param contentType original `Content-Type` header (boundary lives here)
 *  @param fileSize    total byte length — used to terminate scans cleanly
 *  @param readChunk   callback that returns bytes for a (path, offset, length) range
 *  @param chunkSize   tunable; defaults to 64 KiB
 */
export async function parseMultipartFromFile(
  path: string,
  contentType: string,
  fileSize: number,
  readChunk: ReadChunkFn,
  chunkSize: number = DEFAULT_CHUNK,
): Promise<StreamingFormData> {
  const boundary = extractBoundary(contentType);
  if (!boundary) {
    throw new Error("multipart: missing or invalid `boundary` in Content-Type");
  }
  const dashBoundary = utf8Encode("--" + boundary);
  const result = new StreamingFormData();
  if (fileSize <= 0) return result;

  // Find the first boundary.
  let cursor = await indexOfInFile(
    path, dashBoundary, 0, fileSize, readChunk, chunkSize,
  );
  if (cursor < 0) return result;

  while (cursor < fileSize) {
    // Step over the `--BOUNDARY` we just located.
    let bodyHeaderStart = cursor + dashBoundary.length;
    // Check for terminator (`--BOUNDARY--`).
    const peek = await readRange(path, bodyHeaderStart, 2, fileSize, readChunk);
    if (peek && peek.length === 2 && peek[0] === 0x2d && peek[1] === 0x2d) {
      // `--` follows → final terminator. Done.
      return result;
    }
    // Skip CRLF (or lone LF) after boundary line.
    if (peek && peek.length >= 2 && peek[0] === 0x0d && peek[1] === 0x0a) {
      bodyHeaderStart += 2;
    } else if (peek && peek.length >= 1 && peek[0] === 0x0a) {
      bodyHeaderStart += 1;
    }

    // Find header end (`\r\n\r\n` or `\n\n`).
    const headerEndAbs = await indexOfInFile(
      path, HEADER_SEP_CRLF, bodyHeaderStart, fileSize, readChunk, chunkSize,
    );
    let separatorLen = 4;
    let headerEnd = headerEndAbs;
    if (headerEnd < 0) {
      const lfOnly = await indexOfInFile(
        path, HEADER_SEP_LF, bodyHeaderStart, fileSize, readChunk, chunkSize,
      );
      headerEnd = lfOnly;
      separatorLen = 2;
    }
    if (headerEnd < 0) break;

    const headerBytes = await readRange(
      path, bodyHeaderStart, headerEnd - bodyHeaderStart, fileSize, readChunk,
    );
    const headerStr = headerBytes ? bytesToUtf8(headerBytes) : "";
    const headers = parseHeaders(headerStr);
    const cd = headers["content-disposition"] || "";
    const { name, filename } = parseDisposition(cd);

    const bodyStart = headerEnd + separatorLen;
    const nextBoundary = await indexOfInFile(
      path, dashBoundary, bodyStart, fileSize, readChunk, chunkSize,
    );
    if (nextBoundary < 0) break;
    // Strip the CRLF immediately preceding the next boundary.
    let bodyEnd = nextBoundary;
    const tail = await readRange(path, bodyEnd - 2, 2, fileSize, readChunk);
    if (tail && tail.length >= 2 && tail[0] === 0x0d && tail[1] === 0x0a) {
      bodyEnd -= 2;
    } else {
      const tail1 = await readRange(path, bodyEnd - 1, 1, fileSize, readChunk);
      if (tail1 && tail1.length >= 1 && tail1[0] === 0x0a) bodyEnd -= 1;
    }

    if (name) {
      if (filename != null) {
        const partType = headers["content-type"] || "application/octet-stream";
        const fileObj = makeStreamingFile(
          filename, partType, path, bodyStart, bodyEnd - bodyStart, readChunk,
        );
        result.append(name, fileObj);
      } else {
        // Text field — eager-read since these are small.
        const tb = await readRange(
          path, bodyStart, bodyEnd - bodyStart, fileSize, readChunk,
        );
        result.append(name, tb ? bytesToUtf8(tb) : "");
      }
    }

    cursor = nextBoundary;
  }
  return result;
}

// ── Lazy file-backed MultipartFile ────────────────────────────────────

function makeStreamingFile(
  name: string,
  type: string,
  path: string,
  offset: number,
  size: number,
  readChunk: ReadChunkFn,
): MultipartFile {
  return {
    name,
    type,
    size,
    async bytes(): Promise<Uint8Array> {
      // Reads the WHOLE file part into memory on demand — for very
      // large file parts the user should prefer streaming directly
      // through repeated readRange calls (a future API we haven't
      // surfaced yet; today this is the simplest "give me the bytes"
      // path that matches the in-memory parser's contract).
      return (await readRange(path, offset, size, offset + size, readChunk)) ?? new Uint8Array(0);
    },
    async text(): Promise<string> {
      const b = await readRange(path, offset, size, offset + size, readChunk);
      return b ? bytesToUtf8(b) : "";
    },
    async arrayBuffer(): Promise<ArrayBuffer> {
      const b = await readRange(path, offset, size, offset + size, readChunk);
      const out = new Uint8Array(b ? b.length : 0);
      if (b) out.set(b);
      return out.buffer;
    },
  };
}

// ── File-aware byte ops ───────────────────────────────────────────────

/** Read exactly [start, start+length) from the file, or whatever is
 *  available before EOF. Concatenates as many chunks as needed. */
async function readRange(
  path: string,
  start: number,
  length: number,
  fileEnd: number,
  readChunk: ReadChunkFn,
): Promise<Uint8Array | null> {
  if (length <= 0) return new Uint8Array(0);
  const want = Math.min(length, Math.max(0, fileEnd - start));
  if (want <= 0) return new Uint8Array(0);
  // Keep every native bridge call bounded even when an action explicitly
  // materializes a large file via `bytes()` / `arrayBuffer()`. The assembled
  // result still lives in V8 (and is subject to its heap limit), while Rust
  // never performs one attacker-sized allocation from the requested length.
  const firstWant = Math.min(want, DEFAULT_CHUNK);
  const chunk = readChunk(path, start, firstWant);
  if (!chunk) return null;
  if (chunk.length === want) return chunk;
  // Short read — grow.
  const out = new Uint8Array(want);
  out.set(chunk, 0);
  let filled = chunk.length;
  while (filled < want) {
    const more = readChunk(
      path,
      start + filled,
      Math.min(DEFAULT_CHUNK, want - filled),
    );
    if (!more || more.length === 0) break;
    out.set(more, filled);
    filled += more.length;
  }
  return out.subarray(0, filled);
}

/** Locate `needle` in [start, fileEnd) by scanning chunk-by-chunk.
 *  Returns the absolute file offset, or -1 if not found. The
 *  overlap between consecutive chunks is `needle.length - 1` bytes
 *  so a match straddling a chunk boundary still hits. */
async function indexOfInFile(
  path: string,
  needle: Uint8Array,
  start: number,
  fileEnd: number,
  readChunk: ReadChunkFn,
  chunkSize: number,
): Promise<number> {
  if (needle.length === 0 || start >= fileEnd) return -1;
  const overlap = needle.length - 1;
  let off = start;
  while (off < fileEnd) {
    const want = Math.min(chunkSize + overlap, fileEnd - off);
    const buf = readChunk(path, off, want);
    if (!buf || buf.length === 0) break;
    const idx = indexOf(buf, needle, 0);
    if (idx >= 0) return off + idx;
    if (buf.length < needle.length) break;
    off += buf.length - overlap;
  }
  return -1;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  const last = haystack.length - needle.length;
  outer: for (let i = from; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// ── Shared parsing helpers ────────────────────────────────────────────

const HEADER_SEP_CRLF = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const HEADER_SEP_LF = new Uint8Array([0x0a, 0x0a]);

function extractBoundary(contentType: string): string | null {
  const m = /boundary=("([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!m) return null;
  return m[2] || m[3] || null;
}

function parseHeaders(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split(/\r?\n/)) {
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
  let name: string | null = null;
  let filename: string | null = null;
  for (const p of value.split(";")) {
    const t = p.trim();
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim().toLowerCase();
    let v = t.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k === "name") name = v;
    else if (k === "filename" || k === "filename*") filename = v;
  }
  return { name, filename };
}

function utf8Encode(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 4);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) { out[n++] = c; }
    else if (c < 0x800) { out[n++] = 0xc0 | (c >> 6); out[n++] = 0x80 | (c & 0x3f); }
    else if (c < 0xd800 || c >= 0xe000) {
      out[n++] = 0xe0 | (c >> 12); out[n++] = 0x80 | ((c >> 6) & 0x3f); out[n++] = 0x80 | (c & 0x3f);
    } else {
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

function bytesToUtf8(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) out += String.fromCharCode(b1);
    else if ((b1 & 0xe0) === 0xc0) {
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
      const offset = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (offset >> 10));
      out += String.fromCharCode(0xdc00 + (offset & 0x3ff));
    } else {
      out += "\u{fffd}";
    }
  }
  return out;
}
