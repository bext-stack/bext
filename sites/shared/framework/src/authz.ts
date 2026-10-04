// authz.ts — authorization (gates & policies) for PRISM apps.
//
// The app-developer TypeScript counterpart to the server-side Rust
// `AuthzPolicy` capability (see docs /capabilities/authz-policy). That trait is
// a policy seam evaluated in Rust at request boundaries; THIS module is what a
// PRISM route uses to answer "can THIS user do THIS thing to THIS resource?" —
// in a loader (gate the page), an action (gate the mutation), or a component
// (show/hide UI). Pure TypeScript, no host call, user-shape-agnostic.
//
// Laravel's Gate / Policy mapped to TypeScript:
//   const gate = defineGate<User>({
//     "post.update": (u, post: Post) => hasRole(u, "admin") || post.authorId === u?.id,
//     "post.delete": (u) => hasRole(u, "admin"),
//   }, { before: (u) => hasRole(u, "superadmin") ? true : undefined });  // god-mode bypass
//
//   gate.allows(user, "post.update", post)   // boolean — for UI
//   gate.authorize(user, "post.update", post) // throws AuthorizationError if denied
//   if (gate.denies(user, "post.delete")) throw forbidden();  // PRISM loader → 403
//
// Abilities receive `user | null` (a guest is null). Use the null-safe role /
// permission helpers so a guest never throws — a bare `u.role` would.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown by `authorize()` when an ability denies. Carries HTTP 403 so callers
 *  can surface it directly; `.toResponse()` gives a ready 403 `Response`. */
export class AuthorizationError extends Error {
  readonly status = 403 as const;
  readonly ability: string;
  constructor(ability: string, message = "This action is unauthorized.") {
    super(message);
    this.name = "AuthorizationError";
    this.ability = ability;
  }
  toResponse(): Response {
    return new Response(this.message, { status: 403 });
  }
}

/** A 403 `Response` — throw it from a PRISM loader/action to render a forbidden
 *  page (the framework catches thrown `Response`s). */
export function forbidden(message = "Forbidden"): Response {
  return new Response(message, { status: 403 });
}

// ---------------------------------------------------------------------------
// Null-safe user predicates (duck-typed — bring your own user shape)
// ---------------------------------------------------------------------------

interface RoleBearer {
  role?: string | null;
  roles?: string[] | null;
}
interface PermBearer {
  permissions?: string[] | null;
}

/** True if the user holds ANY of the given roles. Reads `user.role` and/or
 *  `user.roles`. Null/undefined user → false (never throws). */
export function hasRole(user: RoleBearer | null | undefined, ...roles: string[]): boolean {
  if (!user) return false;
  const set = user.roles ?? (user.role != null ? [user.role] : []);
  return roles.some((r) => set.includes(r));
}

/** True only if the user holds EVERY given role. */
export function hasAllRoles(user: RoleBearer | null | undefined, roles: string[]): boolean {
  if (!user) return false;
  const set = user.roles ?? (user.role != null ? [user.role] : []);
  return roles.every((r) => set.includes(r));
}

/** True if the user holds ANY of the given permissions (`user.permissions`). */
export function hasPermission(user: PermBearer | null | undefined, ...perms: string[]): boolean {
  if (!user || !user.permissions) return false;
  return perms.some((p) => user.permissions!.includes(p));
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type AbilityFn<U> = (user: U | null, ...args: any[]) => boolean;

export interface GateOptions<U> {
  /** Runs before every ability. Return `true`/`false` to short-circuit (e.g. a
   *  super-admin bypass or a global ban); return `undefined` to fall through to
   *  the ability. */
  before?: (user: U | null, ability: string, args: unknown[]) => boolean | undefined;
}

/** A user bound to a gate — convenient for many checks in one render. */
export interface BoundGate {
  can(ability: string, ...args: unknown[]): boolean;
  cannot(ability: string, ...args: unknown[]): boolean;
  authorize(ability: string, ...args: unknown[]): void;
}

export interface Gate<U> {
  /** Register or replace one ability. Chainable. */
  define(ability: string, fn: AbilityFn<U>): Gate<U>;
  /** Register a policy: many abilities for one resource, keyed `resource.action`
   *  (`gate.policy("post", { update, delete })` → `post.update`, `post.delete`). */
  policy(resource: string, actions: Record<string, AbilityFn<U>>): Gate<U>;
  /** Is the user allowed? Unknown abilities deny. Booleans for UI. */
  allows(user: U | null, ability: string, ...args: unknown[]): boolean;
  denies(user: U | null, ability: string, ...args: unknown[]): boolean;
  /** Throw {@link AuthorizationError} (status 403) when denied. */
  authorize(user: U | null, ability: string, ...args: unknown[]): void;
  /** Bind a user for repeated checks: `const acl = gate.for(session)`. */
  for(user: U | null): BoundGate;
  /** Map ability → allowed, for building menus / nav. Defaults to all abilities. */
  abilities(user: U | null, names?: string[]): Record<string, boolean>;
  /** The registered ability names. */
  readonly names: string[];
}

export function defineGate<U>(abilities: Record<string, AbilityFn<U>> = {}, options: GateOptions<U> = {}): Gate<U> {
  const registry: Record<string, AbilityFn<U>> = { ...abilities };

  const allows = (user: U | null, ability: string, ...args: unknown[]): boolean => {
    if (options.before) {
      const decided = options.before(user, ability, args);
      if (typeof decided === "boolean") return decided;
    }
    const fn = registry[ability];
    if (!fn) return false; // deny unknown abilities (fail closed)
    return fn(user, ...args) === true;
  };

  const gate: Gate<U> = {
    define(ability, fn) {
      registry[ability] = fn;
      return gate;
    },
    policy(resource, actions) {
      for (const action of Object.keys(actions)) registry[`${resource}.${action}`] = actions[action];
      return gate;
    },
    allows,
    denies(user, ability, ...args) {
      return !allows(user, ability, ...args);
    },
    authorize(user, ability, ...args) {
      if (!allows(user, ability, ...args)) throw new AuthorizationError(ability);
    },
    for(user) {
      return {
        can: (ability, ...args) => allows(user, ability, ...args),
        cannot: (ability, ...args) => !allows(user, ability, ...args),
        authorize: (ability, ...args) => {
          if (!allows(user, ability, ...args)) throw new AuthorizationError(ability);
        },
      };
    },
    abilities(user, names) {
      const keys = names ?? Object.keys(registry);
      const out: Record<string, boolean> = {};
      for (const k of keys) out[k] = allows(user, k);
      return out;
    },
    get names() {
      return Object.keys(registry);
    },
  };
  return gate;
}
