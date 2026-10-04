// Fine-grained reactivity primitives.
//
// Three building blocks that compose into a reactive graph:
//
//   signal(initial)   — a writable cell. Reading .value during an
//                       effect/computed run subscribes that consumer.
//                       Writing .value notifies all subscribers.
//   computed(fn)      — a lazy, cached derived value. Re-runs only
//                       when one of its inputs changes AND something
//                       reads its .value.
//   effect(fn)        — a side-effect that re-runs whenever any of
//                       the signals/computeds it read change. Returns
//                       a dispose function.
//   batch(fn)         — defers all subscriber notifications until fn
//                       returns. Dependent effects each run at most
//                       once per batch.
//
// Subscription cleanup
//
// Each Observer maintains a Set of Sources it subscribed to during its
// last run. After every run, we diff: subscribe to any new sources we
// haven't seen before, unsubscribe from sources we no longer read. This
// keeps branchy code (`s.value > 0 ? a.value : b.value`) from leaking
// stale subscriptions or over-firing.
//
// No DOM. Pure data flow. The DOM bindings live in `./dom.ts`.

// ── Internals ──────────────────────────────────────────────────────────

let _currentObserver: ObserverImpl | null = null;
let _batchDepth = 0;
let _batchedEffects: Set<EffectImpl> = new Set();

interface Source {
  _subscribe(o: ObserverImpl): void;
  _unsubscribe(o: ObserverImpl): void;
}

abstract class ObserverImpl {
  /** Sources we subscribed to on the last run. */
  protected _sources: Set<Source> = new Set();
  /** Sources accumulated during the in-progress run (set by Sources
   *  via `_track`). After the run, we diff against `_sources`. */
  protected _newSources: Set<Source> = new Set();
  protected _disposed = false;
  protected _running = false;

  /** Called by a Source when its value changes. Subclasses decide
   *  whether to schedule a re-run (effect) or just mark stale (computed). */
  abstract _markDirty(): void;

  /** Called by Sources during a tracked run. Records the dep so we can
   *  finalize subscriptions after the run. */
  _track(s: Source): void {
    this._newSources.add(s);
  }

  /** Run `body` with this observer active, then commit subscription
   *  changes — subscribe to new sources, unsubscribe from gone ones. */
  protected _runWith<T>(body: () => T): T {
    const prev = _currentObserver;
    _currentObserver = this;
    this._newSources = new Set();
    this._running = true;
    try {
      return body();
    } finally {
      this._running = false;
      _currentObserver = prev;
      // Diff: subscribe to new, unsubscribe from gone.
      for (const s of this._newSources) {
        if (!this._sources.has(s)) s._subscribe(this);
      }
      for (const s of this._sources) {
        if (!this._newSources.has(s)) s._unsubscribe(this);
      }
      this._sources = this._newSources;
      this._newSources = new Set();
    }
  }

  protected _unsubAll(): void {
    for (const s of this._sources) s._unsubscribe(this);
    this._sources = new Set();
  }
}

// ── Signal ─────────────────────────────────────────────────────────────

export interface Signal<T> {
  /** Read or write the value. Reading inside an effect/computed
   *  subscribes that consumer; writing notifies all subscribers. */
  value: T;
  /** Read without subscribing. */
  peek(): T;
}

class SignalImpl<T> implements Signal<T>, Source {
  // Brand for `isSignal`. A property check (not `instanceof`) so detection
  // survives the PRISM island bundler producing TWO copies of this module
  // (entry inlines core via the index; non-entry deps require the leaf
  // `/core`). A signal made by one copy must still be recognized by the
  // other — `instanceof` fails across copies → reactive children render as
  // "[object Object]" and conditions don't track.
  readonly __bextSignal = true;
  private _subs: Set<ObserverImpl> = new Set();
  constructor(private _v: T) {}

  get value(): T {
    if (_currentObserver) {
      _currentObserver._track(this);
    }
    return this._v;
  }

  set value(next: T) {
    if (Object.is(next, this._v)) return;
    this._v = next;
    this._notify();
  }

  peek(): T {
    return this._v;
  }

  _subscribe(o: ObserverImpl): void { this._subs.add(o); }
  _unsubscribe(o: ObserverImpl): void { this._subs.delete(o); }

  private _notify(): void {
    const subs = Array.from(this._subs);
    for (const o of subs) o._markDirty();
  }
}

/** Create a writable reactive cell. */
export function signal<T>(initial: T): Signal<T> {
  return new SignalImpl(initial);
}

// ── Computed ───────────────────────────────────────────────────────────

class ComputedImpl<T> extends ObserverImpl implements Signal<T>, Source {
  readonly __bextSignal = true; // see SignalImpl.__bextSignal
  private _value!: T;
  private _stale = true;
  private _subs: Set<ObserverImpl> = new Set();

  constructor(private _fn: () => T) { super(); }

  get value(): T {
    if (_currentObserver) {
      _currentObserver._track(this);
    }
    if (this._stale) this._recompute();
    return this._value;
  }

  set value(_v: T) {
    throw new Error("computed values are read-only");
  }

  peek(): T {
    if (this._stale) this._recompute();
    return this._value;
  }

  _subscribe(o: ObserverImpl): void { this._subs.add(o); }
  _unsubscribe(o: ObserverImpl): void { this._subs.delete(o); }

  _markDirty(): void {
    if (this._stale) return;
    this._stale = true;
    const subs = Array.from(this._subs);
    for (const o of subs) o._markDirty();
  }

  private _recompute(): void {
    this._runWith(() => {
      this._value = this._fn();
    });
    this._stale = false;
  }
}

/** Lazy, cached derived signal. Recomputes only on read after a
 *  dependency changed. */
export function computed<T>(fn: () => T): Signal<T> {
  return new ComputedImpl(fn);
}

// ── Effect ─────────────────────────────────────────────────────────────

type Cleanup = () => void;

class EffectImpl extends ObserverImpl {
  private _cleanups: Cleanup[] = [];

  constructor(private _fn: () => void | Cleanup) {
    super();
    this._run();
  }

  _markDirty(): void {
    if (this._disposed) return;
    if (_batchDepth > 0) {
      _batchedEffects.add(this);
      return;
    }
    this._run();
  }

  _run(): void {
    if (this._disposed) return;
    if (this._running) return; // self-trigger inside body — skip
    for (const c of this._cleanups) {
      try { c(); } catch (e) { console.error("[signals] cleanup threw:", e); }
    }
    this._cleanups = [];
    this._runWith(() => {
      try {
        const ret = this._fn();
        if (typeof ret === "function") this._cleanups.push(ret);
      } catch (e) {
        console.error("[signals] effect threw:", e);
      }
    });
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._unsubAll();
    for (const c of this._cleanups) {
      try { c(); } catch {}
    }
    this._cleanups = [];
  }
}

/** Run `fn` and re-run it whenever any signal it read changes.
 *  Returns a dispose function. */
export function effect(fn: () => void | Cleanup): () => void {
  const e = new EffectImpl(fn);
  return () => e.dispose();
}

// ── Batch ──────────────────────────────────────────────────────────────

// ── Read capture (resumability) ────────────────────────────────────────

class CaptureObserver extends ObserverImpl {
  reads: Source[] = [];
  _markDirty(): void {}
  // Override: just record the read, don't accumulate for subscription.
  _track(s: Source): void {
    if (!this.reads.includes(s)) this.reads.push(s);
  }
  runCapture<T>(fn: () => T): T {
    const prev = _currentObserver;
    _currentObserver = this;
    try {
      return fn();
    } finally {
      _currentObserver = prev;
    }
  }
}

/** Run `fn` while recording which signals it reads, WITHOUT subscribing to
 *  them. Returns the value + the signals read. Used by the resumable renderer
 *  to map a DOM marker to its signal's stable id. */
export function captureReads<T>(fn: () => T): { value: T; reads: Array<Signal<unknown>> } {
  const obs = new CaptureObserver();
  const value = obs.runCapture(fn);
  return { value, reads: obs.reads as unknown as Array<Signal<unknown>> };
}

/** Defer all effect updates until `fn` returns. Each affected effect
 *  runs at most once after the batch ends. */
export function batch<T>(fn: () => T): T {
  _batchDepth++;
  try {
    return fn();
  } finally {
    _batchDepth--;
    if (_batchDepth === 0) {
      const queue = _batchedEffects;
      _batchedEffects = new Set();
      for (const e of queue) (e as any)._run();
    }
  }
}

/** Read inside the body without subscribing. */
export function untracked<T>(fn: () => T): T {
  const prev = _currentObserver;
  _currentObserver = null;
  try {
    return fn();
  } finally {
    _currentObserver = prev;
  }
}

/** Tag check — true for `signal()` and `computed()` results. Uses the
 *  `__bextSignal` brand (not `instanceof`) so it works across duplicate core
 *  copies in a bundle (see SignalImpl.__bextSignal). */
export function isSignal(v: unknown): v is Signal<unknown> {
  return !!v && typeof v === "object" && (v as { __bextSignal?: boolean }).__bextSignal === true;
}
