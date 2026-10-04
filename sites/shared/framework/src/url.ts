// Safe redirect-target handling.
//
// A `?next=` / `?return=` parameter that reaches a `Location` header must be
// proven same-origin first, or the route is an open redirect: an attacker sends
// the victim a link to *your* logout/SSO endpoint and the browser lands them on
// a phishing origin with the trust of your domain behind the hop.
//
// The tempting guard is a prefix denylist:
//
//     if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
//
// It does not hold. Before a browser resolves a `Location`, it normalises `\`
// to `/` (WHATWG URL, special schemes) and strips raw tab/CR/LF. So every one
// of these passes the denylist and then leaves the origin:
//
//     /\evil.com        ->  //evil.com
//     /<TAB>/evil.com   ->  //evil.com
//     /\/evil.com       ->  //evil.com
//     /\\evil.com       ->  //evil.com
//
// The fix is to stop pattern-matching the string and instead resolve it with
// the same parser the browser uses, against a base whose origin we control,
// then keep only the path components. Anything that escaped the origin during
// parsing shows up in `origin` and is rejected.

const OPAQUE_BASE = "https://bext.invalid";

/**
 * Reduce an untrusted redirect target to a same-origin absolute path.
 *
 * Returns `fallback` unless `raw` resolves, against an opaque base, to a URL on
 * that same base. The result is the normalised `pathname + search + hash`, so
 * it is always safe to place in a `Location` header.
 *
 * @param raw      the untrusted value (e.g. `url.searchParams.get("next")`)
 * @param fallback where to send the user when `raw` is absent or off-origin
 */
export function safeLocalPath(
  raw: string | null | undefined,
  fallback = "/",
): string {
  if (!raw) return fallback;

  let target: URL;
  try {
    target = new URL(raw, OPAQUE_BASE);
  } catch {
    return fallback;
  }
  if (target.origin !== OPAQUE_BASE) return fallback;

  const path = target.pathname + target.search + target.hash;
  // `/..//evil.com` normalises to a *same-origin* pathname of `//evil.com`,
  // which turns protocol-relative the moment it lands in the header.
  if (!path.startsWith("/") || path.startsWith("//")) return fallback;

  return path;
}
