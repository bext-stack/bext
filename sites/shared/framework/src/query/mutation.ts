// Reactive mutation. Mirrors createQuery's shape: signals for state,
// imperative `mutate` / `mutateAsync` to fire. Mutations don't share
// state across observers (each call site has its own); for cache
// updates, use the QueryClient passed in via callbacks.

import { signal, computed, type Signal } from "../signals";
import type { QueryClient } from "./client";

export type MutationStatus = "idle" | "pending" | "success" | "error";

export interface MutationOptions<TVars, TData, TError = Error> {
  mutationFn: (vars: TVars) => Promise<TData> | TData;
  onMutate?: (vars: TVars) => Promise<unknown> | unknown;
  onSuccess?: (data: TData, vars: TVars, context: unknown) => Promise<unknown> | unknown;
  onError?: (error: TError, vars: TVars, context: unknown) => Promise<unknown> | unknown;
  onSettled?: (
    data: TData | undefined,
    error: TError | undefined,
    vars: TVars,
    context: unknown,
  ) => Promise<unknown> | unknown;
}

export interface MutationResult<TVars, TData, TError = Error> {
  data: Signal<TData | undefined>;
  error: Signal<TError | undefined>;
  status: Signal<MutationStatus>;
  isIdle: Signal<boolean>;
  isPending: Signal<boolean>;
  isSuccess: Signal<boolean>;
  isError: Signal<boolean>;
  /** Fire-and-forget; result lives on the signals. Errors are swallowed. */
  mutate: (vars: TVars) => void;
  /** Promise variant — caller handles the result. */
  mutateAsync: (vars: TVars) => Promise<TData>;
  reset: () => void;
}

export function createMutation<TVars, TData, TError = Error>(
  _client: QueryClient,
  opts: MutationOptions<TVars, TData, TError>,
): MutationResult<TVars, TData, TError> {
  const data = signal<TData | undefined>(undefined);
  const error = signal<TError | undefined>(undefined);
  const status = signal<MutationStatus>("idle");

  const mutateAsync = async (vars: TVars): Promise<TData> => {
    status.value = "pending";
    error.value = undefined;
    let context: unknown;
    try {
      context = await opts.onMutate?.(vars);
      const out = await Promise.resolve(opts.mutationFn(vars));
      data.value = out;
      status.value = "success";
      await opts.onSuccess?.(out, vars, context);
      await opts.onSettled?.(out, undefined, vars, context);
      return out;
    } catch (err) {
      error.value = err as TError;
      status.value = "error";
      await opts.onError?.(err as TError, vars, context);
      await opts.onSettled?.(undefined, err as TError, vars, context);
      throw err;
    }
  };

  const mutate = (vars: TVars) => {
    void mutateAsync(vars).catch(() => undefined);
  };

  const reset = () => {
    data.value = undefined;
    error.value = undefined;
    status.value = "idle";
  };

  return {
    data,
    error,
    status,
    isIdle: computed(() => status.value === "idle"),
    isPending: computed(() => status.value === "pending"),
    isSuccess: computed(() => status.value === "success"),
    isError: computed(() => status.value === "error"),
    mutate,
    mutateAsync,
    reset,
  };
}
