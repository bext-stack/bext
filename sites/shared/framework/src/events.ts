// events.ts — a typed, in-process domain event bus for PRISM apps.
//
// The app-developer counterpart to Laravel's Events + Listeners: decouple "a
// thing happened" from "what should happen in response". You declare an event
// map (event name → payload type), register listeners, and `emit`. Pure
// TypeScript, fully typed, no host call.
//
//   type Events = {
//     "user.registered": { id: string; email: string };
//     "order.paid": { orderId: string; amount: number };
//   };
//   const bus = createEventBus<Events>();
//
//   bus.on("user.registered", (u) => sendWelcome(u.email));   // typed payload
//   bus.on("user.registered", (u) => provisionWorkspace(u.id));
//
//   await bus.emit("user.registered", { id: "u1", email: "a@b.co" }); // fans out
//
// Scope note: a bus is in-process and per-V8-isolate. Register listeners at
// module scope (runs once per isolate, so every isolate has the same set) and
// emit within the same request/render — that's the common, deterministic case.
// For cross-request / cross-process fan-out use the SDK queue or realtime; this
// is the synchronous in-app dispatcher, not a durable bus.

export type Listener<P> = (payload: P) => void | Promise<void>;

export interface EventBus<M extends Record<string, any>> {
  /** Register a listener; returns an unsubscribe function. */
  on<K extends keyof M>(event: K, listener: Listener<M[K]>): () => void;
  /** Register a one-shot listener (auto-removed after the first emit). */
  once<K extends keyof M>(event: K, listener: Listener<M[K]>): () => void;
  /** Remove a specific listener. */
  off<K extends keyof M>(event: K, listener: Listener<M[K]>): void;
  /** Emit an event, awaiting every listener (async listeners included).
   *  Listener errors are collected and thrown as an AggregateError after all
   *  listeners run, so one failing listener never silently swallows the rest. */
  emit<K extends keyof M>(event: K, payload: M[K]): Promise<void>;
  /** Fire-and-forget synchronous emit (ignores async listener completion). */
  emitSync<K extends keyof M>(event: K, payload: M[K]): void;
  /** How many listeners are registered for an event. */
  listenerCount<K extends keyof M>(event: K): number;
  /** Remove all listeners (for one event, or all). */
  removeAll<K extends keyof M>(event?: K): void;
}

export function createEventBus<M extends Record<string, any>>(): EventBus<M> {
  const map = new Map<keyof M, Set<Listener<any>>>();

  const listeners = (event: keyof M): Set<Listener<any>> => {
    let s = map.get(event);
    if (!s) {
      s = new Set();
      map.set(event, s);
    }
    return s;
  };

  const bus: EventBus<M> = {
    on(event, listener) {
      listeners(event).add(listener);
      return () => bus.off(event, listener);
    },
    once(event, listener) {
      const wrapper: Listener<any> = async (payload) => {
        bus.off(event, wrapper);
        await listener(payload);
      };
      listeners(event).add(wrapper);
      return () => bus.off(event, wrapper);
    },
    off(event, listener) {
      map.get(event)?.delete(listener);
    },
    async emit(event, payload) {
      const set = map.get(event);
      if (!set || set.size === 0) return;
      const errors: unknown[] = [];
      // Snapshot so a listener that (un)subscribes mid-emit doesn't mutate the run.
      await Promise.all(
        [...set].map(async (fn) => {
          try {
            await fn(payload);
          } catch (e) {
            errors.push(e);
          }
        }),
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, `${errors.length} listeners for "${String(event)}" failed`);
    },
    emitSync(event, payload) {
      const set = map.get(event);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          void fn(payload);
        } catch {
          /* swallow — emitSync is fire-and-forget by contract */
        }
      }
    },
    listenerCount(event) {
      return map.get(event)?.size ?? 0;
    },
    removeAll(event) {
      if (event === undefined) map.clear();
      else map.delete(event);
    },
  };
  return bus;
}

/** Register many listeners at once (Laravel's EventServiceProvider $listen map).
 *  Returns an unsubscribe function that removes all of them. */
export function subscribe<M extends Record<string, any>>(
  bus: EventBus<M>,
  listeners: { [K in keyof M]?: Listener<M[K]> | Listener<M[K]>[] },
): () => void {
  const offs: (() => void)[] = [];
  for (const key of Object.keys(listeners) as (keyof M)[]) {
    const l = listeners[key];
    if (!l) continue;
    for (const fn of Array.isArray(l) ? l : [l]) offs.push(bus.on(key, fn));
  }
  return () => offs.forEach((off) => off());
}
