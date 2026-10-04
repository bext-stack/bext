// jobs.ts — typed background jobs / dispatch for PRISM apps.
//
// The ergonomic layer over bext's SDK queue: declare jobs (name → payload type +
// handler), `dispatch("name", payload)` from anywhere (a render, an action), and
// a worker `process()`es queued envelopes — routing to the right handler with
// retry accounting. Laravel's ShouldQueue jobs + `Job::dispatch()`, in TS.
//
//   const jobs = createJobs({
//     appId: "my-site",
//     jobs: {
//       sendInvoice: { handler: async (p: { orderId: string }) => { … } },
//       resizeImage: { handler: async (p: { key: string }) => { … }, maxAttempts: 5 },
//     },
//   });
//
//   await jobs.dispatch("sendInvoice", { orderId: "o1" });   // enqueue (typed payload)
//   // …in a task worker: for each pulled envelope → await jobs.process(envelope)
//
// The transport is a pluggable Dispatcher — the default pushes to the SDK queue
// over loopback; inject `memoryDispatcher()` for tests / a self-contained demo.

import { sdkWireHeaders } from "./sdk";

export interface JobContext {
  attempt: number;
  jobName: string;
}
export type JobHandler<P> = (payload: P, ctx: JobContext) => void | Promise<void>;

export interface JobDef<P = any> {
  handler: JobHandler<P>;
  /** Queue to enqueue on. Default = the registry's `defaultQueue` (`"default"`). */
  queue?: string;
  /** Total attempts before the job is given up on. Default 1. */
  maxAttempts?: number;
}

type PayloadOf<J> = J extends JobDef<infer P> ? P : never;

/** Envelope enqueued on the SDK queue: identifies the job + carries the attempt. */
interface Envelope {
  job: string;
  payload: unknown;
  attempt: number;
}

export interface Dispatcher {
  /** Enqueue a serialized envelope; returns a job id. */
  push(queue: string, envelope: string, delaySecs?: number): Promise<string>;
}

export interface JobResult {
  job: string;
  ok: boolean;
  attempt: number;
  /** True when a failure was re-queued for another attempt. */
  retried?: boolean;
  error?: string;
}

export interface JobsConfig<M extends Record<string, JobDef>> {
  jobs: M;
  /** App id for the default loopback-SDK dispatcher. */
  appId?: string;
  /** SDK base for the default dispatcher. Default `http://127.0.0.1/__bext/sdk`. */
  endpoint?: string;
  /** Override the transport (tests / in-memory / a custom queue). */
  dispatcher?: Dispatcher;
  /** Default queue name. Default `"default"`. */
  defaultQueue?: string;
}

export interface Jobs<M extends Record<string, JobDef>> {
  /** Enqueue a job by name with its typed payload. Returns the queue job id. */
  dispatch<K extends keyof M>(name: K, payload: PayloadOf<M[K]>, opts?: { delaySecs?: number; queue?: string }): Promise<string>;
  /** Process one raw envelope: route to the handler, and on failure re-enqueue
   *  (attempt+1) while attempts remain. Never throws — returns a {@link JobResult}. */
  process(envelope: string): Promise<JobResult>;
  readonly names: string[];
}

/** The default dispatcher: push to the SDK queue over loopback. */
export function loopbackDispatcher(appId: string, endpoint = "http://127.0.0.1/__bext/sdk"): Dispatcher {
  return {
    async push(queue, envelope, delaySecs) {
      const r = await fetch(`${endpoint}/queue/push`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Bext-App-Id": appId,
          ...sdkWireHeaders(appId),
        },
        body: JSON.stringify({ queue, payload: envelope, delay_secs: delaySecs ?? 0 }),
      });
      if (!r.ok) throw new Error(`jobs.dispatch: SDK queue push failed (HTTP ${r.status})`);
      const j: any = await r.json().catch(() => ({}));
      return String(j.id ?? j.job_id ?? "");
    },
  };
}

/** An in-memory dispatcher — for tests and self-contained demos. Its `drain()`
 *  runs every queued envelope through `jobs.process()`. */
export function memoryDispatcher(): Dispatcher & { readonly pending: string[]; bind(jobs: Jobs<any>): void; drain(): Promise<JobResult[]> } {
  const queue: string[] = [];
  let bound: Jobs<any> | null = null;
  let seq = 0;
  return {
    async push(_queue, envelope) {
      queue.push(envelope);
      return `mem-${++seq}`;
    },
    get pending() {
      return [...queue];
    },
    bind(jobs) {
      bound = jobs;
    },
    async drain() {
      const results: JobResult[] = [];
      while (queue.length) {
        const env = queue.shift()!;
        if (bound) results.push(await bound.process(env));
      }
      return results;
    },
  };
}

export function createJobs<M extends Record<string, JobDef>>(config: JobsConfig<M>): Jobs<M> {
  const defaultQueue = config.defaultQueue ?? "default";
  const dispatcher =
    config.dispatcher ??
    (() => {
      if (!config.appId) throw new Error("jobs: provide `appId` (for the SDK dispatcher) or a `dispatcher`");
      return loopbackDispatcher(config.appId, config.endpoint);
    })();

  const jobs: Jobs<M> = {
    names: Object.keys(config.jobs),
    async dispatch(name, payload, opts) {
      const def = config.jobs[name];
      const queue = opts?.queue ?? def.queue ?? defaultQueue;
      const env: Envelope = { job: String(name), payload, attempt: 1 };
      return dispatcher.push(queue, JSON.stringify(env), opts?.delaySecs);
    },
    async process(envelope) {
      let env: Envelope;
      try {
        env = JSON.parse(envelope);
      } catch {
        return { job: "?", ok: false, attempt: 0, error: "malformed envelope" };
      }
      const def = config.jobs[env.job];
      if (!def) return { job: env.job, ok: false, attempt: env.attempt, error: "no such job" };
      try {
        await def.handler(env.payload, { attempt: env.attempt, jobName: env.job });
        return { job: env.job, ok: true, attempt: env.attempt };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const max = def.maxAttempts ?? 1;
        if (env.attempt < max) {
          const queue = def.queue ?? defaultQueue;
          await dispatcher.push(queue, JSON.stringify({ ...env, attempt: env.attempt + 1 }));
          return { job: env.job, ok: false, attempt: env.attempt, retried: true, error };
        }
        return { job: env.job, ok: false, attempt: env.attempt, error };
      }
    },
  };
  return jobs;
}
