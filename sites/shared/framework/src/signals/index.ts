// Public surface of the signals runtime.
//
// Imports
//   import { signal, computed, effect, batch, untracked }
//     from "@bext-stack/framework/signals";
//
// JSX runtime (per-file pragma):
//   /** @jsxImportSource @bext-stack/framework/signals */
//
// SSR — embed a signals island in a PRISM page:
//   import { signalsIsland } from "@bext-stack/framework/signals";
//   import Counter from "../islands/Counter";
//   <div>{signalsIsland("Counter", Counter, { initial: 5 })}</div>
//
// Client hydration is wired automatically by the build pipeline —
// each "use signals" file gets a generated entry that imports
// `hydrateSignalsIsland` and mounts on DOMContentLoaded.

// Value re-exports (NOT `export { x } from "./mod"`).
//
// The bundler turns `export { signal } from "./core"` into a live getter
// (`Object.defineProperty(exports, "signal", { get: () => core.signal })`).
// That getter does NOT survive the browser CJS bundle's cycle-safety stub:
// when a NON-entry module (e.g. a site's `signal-helpers.ts`) does
// `const s = require("@bext-stack/framework/signals")` and reads `s.signal`
// at module-init, the stub it received had the getter copied as a *snapshot
// value* (undefined at copy time) → `signal is not a function`, and the
// signals island never hydrates (blank dashboards). Binding to plain `const`
// values makes the export a real function property that the stub key-copy
// preserves. Safe because none of ./core, ./jsx, ./server, ./hydrate import
// this index, so the bundler always evaluates them before this module.
import * as core from "./core";
import * as jsx from "./jsx";
import * as server from "./server";
import * as hydrate from "./hydrate";

export const signal = core.signal;
export const computed = core.computed;
export const effect = core.effect;
export const batch = core.batch;
export const untracked = core.untracked;
export const isSignal = core.isSignal;
export type { Signal } from "./core";

export const h = jsx.h;
export const Fragment = jsx.Fragment;
export const List = jsx.List;
export const Show = jsx.Show;
export const Switch = jsx.Switch;
export const Match = jsx.Match;
export const createRenderContext = jsx.createRenderContext;
export const setRenderContext = jsx.setRenderContext;
export const getRenderContext = jsx.getRenderContext;
export type { Reactive, Binding, RenderContext, RenderMode } from "./jsx";

export const renderSignalsToString = server.renderSignalsToString;
export const wrapSignalsIsland = server.wrapSignalsIsland;
export type { SignalsRenderResult } from "./server";

export const hydrateSignalsIsland = hydrate.hydrateSignalsIsland;
export type { MountOptions, MountResult } from "./hydrate";

// SSR helper — renders a signals component to HTML at the call site
// and wraps it in a `<bext-island>` host element. Use in PRISM pages
// (which return strings). `renderSignalsToString` / `wrapSignalsIsland`
// are the `const` bindings declared above.
import type { SignalsRenderResult } from "./server";

export function signalsIsland(
  name: string,
  Component: (props: any) => string,
  props: any = {},
  opts?: { lazy?: "visible" | "idle" | "interaction" },
): string {
  const result = renderSignalsToString(Component, props);
  return wrapSignalsIsland(name, result, opts);
}

// ── Resumability ("use resumable") — Qwik-style: the client NEVER re-runs the
//    component. Server serializes signal values + marker map; the resume runtime
//    reconstructs signals + wires markers + lazily resolves handlers. Opt-in.
import * as resumableMod from "./resumable";
export const __rsig = resumableMod.__rsig;
export const __rcomp = resumableMod.__rcomp;
export const __rread = resumableMod.__rread;
export const __rhref = resumableMod.__rhref;
export const renderResumableToString = resumableMod.renderResumableToString;
export const wrapResumableIsland = resumableMod.wrapResumableIsland;
export const resumeIsland = resumableMod.resumeIsland;
export type { ResumeState, ResumableRenderResult, ResumeModule } from "./resumable";

/** SSR a "use resumable" component into a resumable `<bext-island>` host (HTML +
 *  a serialized state container). The component runs ONCE here, on the server.
 *  Pass `{ lazy: true }` to defer the island bundle download to the first
 *  interaction (zero island JS on load; the loader replays the event). */
export function resumableIsland(
  name: string,
  Component: (props: any) => string,
  props: any = {},
  opts: { lazy?: boolean } = {},
): string {
  return wrapResumableIsland(name, renderResumableToString(Component, props), opts.lazy);
}

// Re-export of the hydration entry shape — useful for callers writing
// custom mount loops (e.g. lazy-mount on intersect).
export type SignalsHydrate = (
  root: HTMLElement,
  Component: (props: any) => string,
  props?: any,
) => SignalsRenderResult["html"] extends infer _ ? unknown : never;
