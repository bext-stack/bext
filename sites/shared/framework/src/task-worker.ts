// Warm task-worker harness — the TS half of the bext task executor.
//
// A site declares background jobs with `defineTask(name, handler)` and calls
// `startTaskWorker()` once at the bottom of its worker entry (e.g.
// `tools/task-worker.ts`). The Rust supervisor (`bext-server/src/task_pool.rs`)
// spawns this entry with `bun run`, waits for the `BEXT_TASK_READY <port>` line,
// then dispatches jobs to `POST /run`. The work runs here — in a real Bun event
// loop with no render deadline and full I/O concurrency — instead of on the
// shared V8 render pool (where a long job risks the slot-wide SIGKILL).
//
// Protocol (kept deliberately tiny):
//   GET  /health                          → { ok: true }
//   POST /run  { id, task, payload }       → { ok: true, result } | { ok: false, error }
//        + header X-Bext-Task-Token (must match $BEXT_TASK_WORKER_TOKEN)
//
// Progress flows back out-of-band via `ctx.progress(data)` →
// POST /__bext/sdk/tasks/progress, so the supervisor's /run response only
// carries the final result.
//
// Delivery is at-least-once across supervisor death: an expired durable lease
// replays the same job id. Handlers with external side effects must use
// `ctx.jobId` as an idempotency key (or persist an equivalent dedupe record)
// before performing the effect.

import { createSdk, sdkWireHeaders, type BextSdk } from "./sdk";

const SDK_BASE = "http://127.0.0.1/__bext/sdk";

/** What a task handler receives. `payload` is whatever the caller passed to
 *  `tasks/run`. */
export interface TaskContext extends BextSdk {
  /** This app's id (`$BEXT_APP_ID`). */
  appId: string;
  /** Stable across crash replay; use as the idempotency key for side effects. */
  jobId: string;
  /** Aborts when the supervisor drops the connection (per-job timeout or
   *  explicit cancel). Long handlers should pass it to `fetch`/loops. */
  signal: AbortSignal;
  /** Report intermediate progress (any JSON value). Best-effort, non-throwing. */
  progress(data: unknown): Promise<void>;
  /** Log a line (goes to the supervisor's debug log via stdout). */
  log(...args: unknown[]): void;
  /** The raw SDK client, also spread onto the context (kv/db/queue/...). */
  sdk: BextSdk;
}

export type TaskHandler = (ctx: TaskContext, payload: any) => unknown | Promise<unknown>;

const REGISTRY = new Map<string, TaskHandler>();

/** Register a task handler by name. Call at module top level, before
 *  `startTaskWorker()`. */
export function defineTask(name: string, handler: TaskHandler): void {
  if (REGISTRY.has(name)) {
    // A duplicate name is almost always a copy-paste bug; last one wins but warn.
    console.warn(`[task-worker] task "${name}" redefined`);
  }
  REGISTRY.set(name, handler);
}

/** Names of all registered tasks (for diagnostics). */
export function registeredTasks(): string[] {
  return [...REGISTRY.keys()];
}

async function sendProgress(appId: string, jobId: string, data: unknown): Promise<void> {
  try {
    await fetch(`${SDK_BASE}/tasks/progress`, {
      method: "POST",
      headers: {
        "X-Bext-App-Id": appId,
        ...sdkWireHeaders(appId),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: jobId, data }),
    });
  } catch {
    // Progress is advisory — never let a reporting failure sink the job.
  }
}

export interface StartOptions {
  /** Override the bind port (default `$BEXT_TASK_WORKER_PORT`, else ephemeral). */
  port?: number;
  /** Override the auth token (default `$BEXT_TASK_WORKER_TOKEN`). */
  token?: string;
  /** Override the app id (default `$BEXT_APP_ID`). */
  appId?: string;
}

/** Bind the worker, announce readiness, and serve `/run` until killed. */
export function startTaskWorker(opts: StartOptions = {}): void {
  const appId = opts.appId ?? process.env.BEXT_APP_ID ?? "default";
  const token = opts.token ?? process.env.BEXT_TASK_WORKER_TOKEN ?? "";
  const port = opts.port ?? Number(process.env.BEXT_TASK_WORKER_PORT ?? 0);
  const sdk = createSdk(appId);

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    // No idle timeout cap from Bun — the supervisor owns the per-job deadline.
    idleTimeout: 255,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, tasks: registeredTasks() });
      }

      if (req.method === "POST" && url.pathname === "/run") {
        if (token && req.headers.get("x-bext-task-token") !== token) {
          return Response.json({ ok: false, error: "bad token" }, { status: 401 });
        }
        let body: { id?: string; task?: string; payload?: unknown };
        try {
          body = await req.json();
        } catch {
          return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
        }
        const jobId = body.id ?? "";
        const taskName = body.task ?? "";
        const handler = REGISTRY.get(taskName);
        if (!handler) {
          return Response.json(
            { ok: false, error: `unknown task "${taskName}"` },
            { status: 404 },
          );
        }

        const ctx: TaskContext = {
          ...sdk,
          appId,
          jobId,
          signal: req.signal,
          sdk,
          progress: (data: unknown) => sendProgress(appId, jobId, data),
          log: (...args: unknown[]) =>
            console.log(`[task ${taskName} ${jobId}]`, ...args),
        };

        try {
          const result = await handler(ctx, body.payload);
          return Response.json({ ok: true, result: result ?? null });
        } catch (err: any) {
          const message =
            err?.name === "AbortError"
              ? "aborted (timeout or cancel)"
              : String(err?.message ?? err);
          return Response.json({ ok: false, error: message });
        }
      }

      return new Response("not found", { status: 404 });
    },
    error(err): Response {
      return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
    },
  });

  // Hand the real (possibly ephemeral) port back to the supervisor. This line
  // is the spawn handshake — `task_pool.rs` blocks on it.
  process.stdout.write(`BEXT_TASK_READY ${server.port}\n`);
  console.log(
    `[task-worker] app=${appId} listening on 127.0.0.1:${server.port} tasks=[${registeredTasks().join(", ")}]`,
  );

  const stop = () => {
    void server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
