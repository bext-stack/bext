/**
 * next/server compatibility shim for PRISM.
 *
 * Provides NextRequest and NextResponse classes that wrap the
 * standard Web API Request/Response with Next.js-specific helpers.
 */

export class NextRequest extends Request {
  nextUrl: URL;
  cookies: NextCookies;
  geo?: { city?: string; country?: string; region?: string };
  ip?: string;

  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(this.url);
    this.cookies = new NextCookies(this.headers.get("cookie") || "");
  }
}

class NextCookies {
  private _cookies: Map<string, string>;

  constructor(cookieHeader: string) {
    this._cookies = new Map();
    for (const part of cookieHeader.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k) this._cookies.set(k, v.join("="));
    }
  }

  get(name: string) {
    const value = this._cookies.get(name);
    return value !== undefined ? { name, value } : undefined;
  }

  getAll() {
    return [...this._cookies.entries()].map(([name, value]) => ({ name, value }));
  }

  has(name: string) { return this._cookies.has(name); }
  set() { /* noop in read-only context */ }
  delete() { /* noop in read-only context */ }
}

export class NextResponse extends Response {
  static json(data: any, init?: ResponseInit) {
    return new NextResponse(JSON.stringify(data), {
      ...init,
      headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(init?.headers).entries()) },
    });
  }

  static redirect(url: string | URL, status: number = 307) {
    return new NextResponse(null, {
      status,
      headers: { location: typeof url === "string" ? url : url.toString() },
    });
  }

  static rewrite(url: string | URL) {
    // In PRISM, rewrite is handled as an internal redirect
    return NextResponse.redirect(url, 307);
  }

  static next(init?: { headers?: HeadersInit }) {
    // Signal to continue processing (used in middleware)
    const res = new NextResponse(null, { status: 200 });
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => res.headers.set(k, v));
    }
    return res;
  }

  cookies = {
    set: (name: string, value: string, opts?: any) => {
      const parts = [`${name}=${value}`];
      if (opts?.path) parts.push(`Path=${opts.path}`);
      if (opts?.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
      if (opts?.httpOnly) parts.push("HttpOnly");
      if (opts?.secure) parts.push("Secure");
      if (opts?.sameSite) parts.push(`SameSite=${opts.sameSite}`);
      this.headers.append("set-cookie", parts.join("; "));
    },
    delete: (name: string) => {
      this.headers.append("set-cookie", `${name}=; Max-Age=0; Path=/`);
    },
    get: (name: string) => undefined as any,
    getAll: () => [] as any[],
    has: (name: string) => false,
  };
}

// Type exports for compatibility
export type { NextRequest as default };
