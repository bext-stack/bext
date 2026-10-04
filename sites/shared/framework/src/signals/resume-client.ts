// resume-client.ts — the MINIMAL client-only resumability runtime.
//
// This is everything a resumed island needs on the client: the reactive core
// (signal/computed/effect) + `resumeIsland`. It deliberately imports NOTHING
// render-related (no jsx `h()`, no server.ts, no hydrate.ts, no
// renderResumableToString) so a lazy island can ship a tiny bundle — the
// ~30%-of-bundle hydrate machinery and the JSX adapter are pure dead weight on
// the resume path. The compiler's `__resume` factories are self-contained (they
// only read from `scope`), so the only runtime they need is this file.

import { signal, computed, effect, type Signal } from "./core";

/** Scope visible to every lifted factory: reconstructed plain signals +
 *  re-derived computeds, keyed by their stable id. */
export type Scope = Record<string, Signal<unknown>>;

export interface ResumeState {
  /** plain-signalId → serialized value (computeds are NOT serialized). */
  signals: Record<string, unknown>;
  /** ids of computeds to re-derive on resume from `ccomp`. */
  computeds: string[];
  /** markerId → read symbol, indexing `rexpr`. */
  markers: Record<string, string>;
  /** props passed to the component (for reference/debug). */
  props: unknown;
}

/** The component's combined lifted-factory object (compiler emits
 *  `export const __resume = { rh, rexpr, ccomp }`). All optional. */
export interface ResumeModule {
  rh?: Record<string, (scope: Scope) => (e: Event) => void>;
  rexpr?: Record<string, (scope: Scope) => unknown>;
  ccomp?: Record<string, (scope: Scope) => unknown>;
}

/** Resume an island WITHOUT re-running its component: reconstruct plain signals
 *  from serialized values, re-derive computeds from their formulas, wire markers
 *  with real effects, and lazily resolve handlers on event. */
export function resumeIsland(root: HTMLElement, mod: ResumeModule, state: ResumeState): void {
  // 0. HMR: if a snapshot of this island's LIVE state was taken before a dev
  //    reload, override the SSR values with it so the user's state survives the
  //    edit. No-op in prod (nothing snapshots → store empty → fresh state).
  hmrRestore(root, state);

  // 1. reconstruct plain signals from serialized values.
  const scope: Scope = {};
  for (const id in state.signals) scope[id] = signal(state.signals[id]);

  // 2. re-derive computeds from their formulas. Lazy — ordering doesn't matter.
  const ccomp = mod.ccomp;
  for (const id of state.computeds ?? []) {
    const formula = ccomp?.[id];
    if (formula) scope[id] = computed(() => formula(scope)) as Signal<unknown>;
  }

  // Expose the live scope + plain-signal ids so an HMR snapshot can read the
  // current (interacted) values before a reload.
  (root as unknown as { __bsScope?: Scope; __bsPlain?: string[] }).__bsScope = scope;
  (root as unknown as { __bsPlain?: string[] }).__bsPlain = Object.keys(state.signals);

  // 3. wire DOM markers with real effects that re-evaluate the read formula.
  const rexpr = mod.rexpr;
  for (const markerId in state.markers) {
    const readSym = state.markers[markerId];
    const read = rexpr?.[readSym];
    if (!read) continue;

    const range = findTextRange(root, markerId);
    if (range) {
      let n: Node | null = range.open.nextSibling;
      while (n && n !== range.close) {
        const next: Node | null = n.nextSibling;
        n.parentNode?.removeChild(n);
        n = next;
      }
      const tn = document.createTextNode("");
      range.close.parentNode?.insertBefore(tn, range.close);
      effect(() => {
        const v = read(scope);
        tn.data = v == null ? "" : String(v);
      });
      continue;
    }

    const el = root.querySelector(`[data-bs-attr${markerId}]`) as HTMLElement | null;
    if (el) {
      const name = el.getAttribute(`data-bs-attr${markerId}`) || "";
      el.removeAttribute(`data-bs-attr${markerId}`);
      effect(() => {
        const v = read(scope);
        if (v == null || v === false) el.removeAttribute(name);
        else if (v === true) el.setAttribute(name, "");
        else el.setAttribute(name, String(v));
      });
    }
  }

  // 4. install handlers by symbol — only the clicked handler ever runs.
  for (const el of Array.from(root.getElementsByTagName("*")) as HTMLElement[]) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith("data-bs-on")) continue;
      const event = attr.name.slice("data-bs-on".length);
      const sym = attr.value;
      el.removeAttribute(attr.name);
      const factory = mod.rh?.[sym];
      if (factory) {
        const handler = factory(scope);
        el.addEventListener(event, (e) => {
          try {
            handler(e);
          } catch (err) {
            console.error("[resumable] handler", sym, err);
          }
        });
      }
    }
  }
}

/** Minimal `<!--bsN-->…<!--/bsN-->` range finder (flat text markers). */
function findTextRange(root: Node, markerId: string): { open: Comment; close: Comment } | null {
  const openText = `bs${markerId}`;
  const closeText = `/bs${markerId}`;
  let open: Comment | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const c = node as Comment;
    if (c.data === openText) open = c;
    else if (c.data === closeText && open) return { open, close: c };
  }
  return null;
}

// ── HMR: state-preserving reload ────────────────────────────────────────────
// The hard half of HMR is keeping STATE across an edit. Resumable islands expose
// their live `scope`, so we can snapshot the current (interacted) signal values
// before a reload and restore them after — combined with live-reload, that's the
// HMR experience (edit → reload-with-new-code → state survives) without a risky
// module swap. Entirely client-side. No-op in prod: nothing calls snapshot(), so
// the store stays empty and restore is a no-op (a fresh refresh → fresh state).

const HMR_KEY = "__bextHmr";

function islandIndex(root: HTMLElement): number {
  try {
    return Array.prototype.indexOf.call(
      document.querySelectorAll('bext-island[data-runtime="resumable"]'),
      root,
    );
  } catch {
    return -1;
  }
}

function hmrRestore(root: HTMLElement, state: ResumeState): void {
  try {
    const raw = sessionStorage.getItem(HMR_KEY);
    if (!raw) return;
    const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    const saved = store[String(islandIndex(root))];
    if (saved) Object.assign(state.signals, saved);
    // One-shot: drop the snapshot after the synchronous restores so a later
    // manual refresh gets fresh state.
    setTimeout(() => {
      try {
        sessionStorage.removeItem(HMR_KEY);
      } catch {}
    }, 0);
  } catch {}
}

/** Snapshot every resumable island's live plain-signal values to sessionStorage,
 *  keyed by DOM order, so the next load restores them. Call before a reload. */
function hmrSnapshot(): void {
  try {
    const store: Record<string, Record<string, unknown>> = {};
    const islands = document.querySelectorAll('bext-island[data-runtime="resumable"]');
    for (let i = 0; i < islands.length; i++) {
      const el = islands[i] as unknown as { __bsScope?: Scope; __bsPlain?: string[] };
      if (!el.__bsScope || !el.__bsPlain) continue;
      const vals: Record<string, unknown> = {};
      for (const id of el.__bsPlain) {
        const sig = el.__bsScope[id];
        if (sig) vals[id] = sig.value;
      }
      store[String(i)] = vals;
    }
    sessionStorage.setItem(HMR_KEY, JSON.stringify(store));
  } catch {}
}

/** PROPER HMR: hot-swap a changed island's CODE in place — no full reload, state
 *  preserved. Snapshots live state, replaces the island element(s) with freshly
 *  re-rendered markup (new code → new SSR), loads the recompiled bundle
 *  (cache-busted), and the bundle's auto-mount resumes the new element while
 *  hmrRestore writes the snapshotted state back. The old element is discarded, so
 *  its effects/listeners go with it — no double-wiring, no disposer bookkeeping. */
async function swapIsland(name: string): Promise<void> {
  // 1. snapshot current (interacted) state of every island.
  hmrSnapshot();
  // 2. re-fetch the page (re-rendered with the new code) for fresh island markup.
  let doc: Document;
  try {
    const res = await fetch(location.href, { headers: { "X-Bext-Nav": "1" }, cache: "no-store" });
    doc = new DOMParser().parseFromString(await res.text(), "text/html");
  } catch {
    return;
  }
  // 3. replace each old island element of `name` with its fresh markup.
  const sel = `bext-island[data-component="${name}"]`;
  const fresh = doc.querySelectorAll(sel);
  const olds = document.querySelectorAll(sel);
  for (let i = 0; i < olds.length; i++) {
    const f = fresh[i];
    if (f) (olds[i] as HTMLElement).replaceWith(document.importNode(f, true));
  }
  // 4. load the recompiled bundle (cache-busted). Its auto-mount finds the new
  //    element(s), resumes them, and hmrRestore restores the snapshotted state.
  await new Promise<void>((resolve) => {
    const s = document.createElement("script");
    s.src = `/islands/${name}.js?hmr=` + Date.now();
    s.addEventListener("load", () => resolve());
    s.addEventListener("error", () => resolve());
    document.head.appendChild(s);
  });
}

/** Re-mount every resumable island currently in the DOM from its (cache-busted)
 *  bundle, restoring snapshotted state via hmrRestore. Used after a live-reload
 *  CONTENT SWAP (markup already replaced) so islands pick up new code without a
 *  full reload. Call hmrSnapshot() before the swap. */
async function remountIslands(): Promise<void> {
  const names = new Set<string>();
  document.querySelectorAll('bext-island[data-runtime="resumable"][data-component]').forEach((el) => {
    const c = (el as HTMLElement).getAttribute("data-component");
    if (c) names.add(c);
  });
  await Promise.all(
    [...names].map(
      (name) =>
        new Promise<void>((resolve) => {
          const s = document.createElement("script");
          s.src = `/islands/${name}.js?hmr=` + Date.now();
          s.addEventListener("load", () => resolve());
          s.addEventListener("error", () => resolve());
          document.head.appendChild(s);
        }),
    ),
  );
}

/** Install the shared resume runtime on `globalThis.__bextResume` so a lazy
 *  island's tiny bundle can call it without bundling the framework. Also exposes
 *  `globalThis.__bextHmr`: snapshot (state-preserving reload), swapIsland (in-place
 *  hot-swap of one island), remountIslands (re-mount all after a content swap). */
const g = globalThis as unknown as {
  __bextResume?: { resumeIsland: typeof resumeIsland };
  __bextHmr?: {
    snapshot: () => void;
    swapIsland: (name: string) => Promise<void>;
    remountIslands: () => Promise<void>;
  };
};
if (!g.__bextResume) g.__bextResume = { resumeIsland };
if (!g.__bextHmr) g.__bextHmr = { snapshot: hmrSnapshot, swapIsland, remountIslands };
