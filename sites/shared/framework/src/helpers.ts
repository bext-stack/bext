/**
 * Lightweight page helpers — can be safely imported from client code.
 * No Node.js builtins, no heavy dependencies.
 */

export class Redirect {
  constructor(public url: string, public status: 301 | 302 | 307 | 308 = 302) {}
}

export class NotFound {}

export function redirect(url: string, status: 301 | 302 | 307 | 308 = 302): never {
  throw new Redirect(url, status);
}

export function notFound(): never {
  throw new NotFound();
}

export function revalidatePath(_path: string) {
  // No-op in client context. Server-side implementation is in serve.ts.
}

export function revalidateTag(_tag: string) {
  // No-op in client context.
}
