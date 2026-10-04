// Inspect-mode hook.
//
// When a request carries `?bext_inspect=1`, the framework inlines a
// small runtime script before </body> that postMessages to the parent
// window ("bext:inspect-ready"). This is the iframe-side half of the
// designer-prism builder's visual-editing bridge.
//
// No auth on the flag in this phase — the runtime is a no-op without a
// parent listener that speaks the bridge protocol, so appending the flag
// to a public URL just delivers a few inert KB of JS. A follow-up PR
// gates this behind an HMAC token (and a per-site capability flag in
// bext.config.toml) once the compiled bundle itself starts to vary
// (data-bext-loc attribute injection via tsc-rs react-jsxdev).

/** True when `?bext_inspect=1` is on the URL. */
export function isInspectRequest(req: Request): boolean {
  try {
    const u = new URL(req.url);
    return u.searchParams.get("bext_inspect") === "1";
  } catch {
    return false;
  }
}

// Bumped when the inline runtime below changes. Surfaced on the response
// in `x-bext-inspect-bundle` so the builder can fail loud if it loads a
// stale shared-framework that doesn't speak the current handshake.
const INSPECT_RUNTIME_VERSION = "1";

/**
 * Inline runtime injected before </body> in inspect mode. Kept small +
 * dependency-free: announces "ready" to the parent, then idles. The
 * hover/click/select machinery lands in a follow-up PR.
 *
 * Target origin "*" is intentional for the unauthenticated phase — the
 * runtime carries no sensitive state. PR 2 will lock the target to the
 * caller-supplied parent origin embedded in the inspect grant.
 */
export function getInspectScript(): string {
  return (
    '<script data-bext-inspect="' + INSPECT_RUNTIME_VERSION + '">(function(){' +
    "try{" +
    // Avoid double-init if a layout/nested doc somehow injects twice
    "if(window.__bextInspectReady)return;" +
    "window.__bextInspectReady=true;" +
    "function send(){" +
    "try{" +
    "var msg={type:'bext:inspect-ready',v:" + INSPECT_RUNTIME_VERSION + ",ts:Date.now()," +
    "href:String(location.href||''),phase:'phase-1-noop'};" +
    "if(window.parent&&window.parent!==window)window.parent.postMessage(msg,'*');" +
    "}catch(_){}" +
    "}" +
    "if(document.readyState==='loading'){" +
    "document.addEventListener('DOMContentLoaded',send,{once:true});" +
    "}else{send();}" +
    "}catch(_){}" +
    "})();</script>"
  );
}

/** Header name used to surface the inspect-runtime version + presence
 *  to the builder. Read by PreviewPane to detect when the iframe is
 *  served by a framework version that predates this PR. */
export const INSPECT_HEADER = "x-bext-inspect-bundle";

export function inspectHeaderValue(): string {
  return INSPECT_RUNTIME_VERSION;
}
