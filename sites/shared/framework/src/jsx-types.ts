// Component-authoring type aliases (T1.2 — additive, pure compile-time).
//
// These ship the two types that JSX authoring loses to hand-rolled strings
// without — a `children`-aware props helper and a stable component alias.
// They reuse the framework's existing `Renderable` (from `./jsx`); they do
// NOT redefine or re-export it. Zero runtime footprint.

import type { Renderable } from "./jsx";

/**
 * Props augmented with an optional `children` slot, typed as the framework's
 * `Renderable` (anything `h()` / a component returns: strings, numbers,
 * Promises, AsyncIterables, arrays, nullish/booleans).
 *
 *   function Card(props: PropsWithChildren<{ title: string }>) {
 *     return <section><h2>{props.title}</h2>{props.children}</section>;
 *   }
 */
export type PropsWithChildren<P = {}> = P & { children?: Renderable };

/**
 * A bext component: a function from props to a `Renderable`. Components may be
 * sync (return a string), async (return a Promise), or streaming (return an
 * AsyncIterable) — all three are subsumed by `Renderable`.
 *
 *   const Badge: Component<{ label: string }> = ({ label }) => <span>{label}</span>;
 */
export type Component<P = {}> = (props: P) => Renderable;
