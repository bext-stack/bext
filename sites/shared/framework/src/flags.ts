// flags.ts — feature flags & experiments for PRISM apps (a Pennant-style client).
//
// bext has a Rust feature-flag engine behind /__bext/sdk/flags/evaluate, but it
// is server-file configured and returned 503 until set, and there was no typed
// client — apps hand-rolled `fetch()`. This module gives you both:
//
//   1. LOCAL, code-defined flags — the Pennant headline: define a flag as a
//      boolean or a function of the request context, with deterministic,
//      sticky percentage rollouts. Pure, no server, unit-testable.
//   2. REMOTE flags — fall through to the Rust engine's SDK endpoint for keys
//      you didn't define locally (when a provider is configured).
//
//   const flags = defineFlags({
//     flags: {
//       "new-checkout": percentage(25),                    // 25% sticky rollout
//       "beta-banner":  forUsers("u_1", "u_2"),
//       "holiday-theme": (ctx) => ctx.attributes?.country === "FR",
//     },
//     remote: { appId: "my-site" },                        // optional server fallback
//   });
//
//   if (await flags.isEnabled("new-checkout", { userId: user.id })) { ... }
//   const arm = flags.variant("home-hero", ["control", "b", "c"], { userId: user.id });

import { sdkWireHeaders } from "./sdk";

export interface FlagContext {
  userId?: string;
  sessionId?: string;
  attributes?: Record<string, unknown>;
}

/** A local flag: a constant, or a predicate over the request context. */
export type FlagRule = boolean | ((ctx: FlagContext, key: string) => boolean);

// --- deterministic, sticky bucketing --------------------------------------

/** FNV-1a 32-bit — stable across runtimes, good enough for bucketing. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function subject(ctx: FlagContext): string {
  return ctx.userId ?? ctx.sessionId ?? "";
}

/** A rule enabling a deterministic, sticky `pct`% of subjects. The same subject
 *  always gets the same answer for a given flag key (salted by the key, so two
 *  50% flags don't enable the same half). */
export function percentage(pct: number): FlagRule {
  const p = Math.max(0, Math.min(100, pct));
  return (ctx, key) => {
    const subj = subject(ctx);
    if (!subj) return false; // no subject → can't be sticky; stay off
    return hash32(`${key}:${subj}`) % 100 < p;
  };
}

/** A rule enabling only the listed user ids. */
export function forUsers(...ids: string[]): FlagRule {
  const set = new Set(ids);
  return (ctx) => (ctx.userId != null ? set.has(ctx.userId) : false);
}

/** A rule matching an attribute value. */
export function forAttribute(key: string, value: unknown): FlagRule {
  return (ctx) => ctx.attributes?.[key] === value;
}

function evalRule(rule: FlagRule, ctx: FlagContext, key: string): boolean {
  return typeof rule === "function" ? rule(ctx, key) === true : rule === true;
}

// --- config & client -------------------------------------------------------

export interface RemoteConfig {
  appId: string;
  /** SDK base. Default `http://127.0.0.1/__bext/sdk`. */
  endpoint?: string;
}

export interface FlagsConfig {
  flags?: Record<string, FlagRule>;
  /** Fall through to the Rust flag engine for undefined keys. */
  remote?: RemoteConfig | false;
  /** Value when a key is neither defined locally nor resolvable remotely. */
  default?: boolean;
}

export interface Flags {
  /** Evaluate a flag. Local definition wins; otherwise remote (if configured); otherwise default. */
  isEnabled(key: string, ctx?: FlagContext): Promise<boolean>;
  /** Local-only synchronous evaluation (remote keys resolve to `default`). */
  isEnabledSync(key: string, ctx?: FlagContext): boolean;
  /** Deterministic, sticky A/B/n assignment from `variants`. */
  variant(experiment: string, variants: string[], ctx?: FlagContext): string;
  /** Evaluate every LOCALLY-defined flag for a context (for bootstrapping UI). */
  all(ctx?: FlagContext): Record<string, boolean>;
  /** Names of the locally-defined flags. */
  readonly defined: string[];
}

async function evaluateRemote(remote: RemoteConfig, key: string, ctx: FlagContext, fallback: boolean): Promise<boolean> {
  const base = remote.endpoint ?? "http://127.0.0.1/__bext/sdk";
  try {
    const r = await fetch(`${base}/flags/evaluate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Bext-App-Id": remote.appId,
        ...sdkWireHeaders(remote.appId),
      },
      body: JSON.stringify({ key, user_id: ctx.userId, attributes: ctx.attributes ?? {} }),
    });
    if (!r.ok) return fallback;
    const j: any = await r.json();
    return !!(j.enabled ?? j.value ?? j.on ?? false);
  } catch {
    return fallback;
  }
}

export function defineFlags(config: FlagsConfig): Flags {
  const local = config.flags ?? {};
  const fallback = config.default ?? false;

  return {
    defined: Object.keys(local),
    async isEnabled(key, ctx = {}) {
      if (key in local) return evalRule(local[key], ctx, key);
      if (config.remote) return evaluateRemote(config.remote, key, ctx, fallback);
      return fallback;
    },
    isEnabledSync(key, ctx = {}) {
      if (key in local) return evalRule(local[key], ctx, key);
      return fallback;
    },
    variant(experiment, variants, ctx = {}) {
      if (!variants.length) throw new Error("flags.variant: need at least one variant");
      const subj = subject(ctx) || "anon";
      return variants[hash32(`${experiment}:${subj}`) % variants.length];
    },
    all(ctx = {}) {
      const out: Record<string, boolean> = {};
      for (const key of Object.keys(local)) out[key] = evalRule(local[key], ctx, key);
      return out;
    },
  };
}
