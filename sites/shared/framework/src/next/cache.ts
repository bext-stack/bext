/**
 * next/cache compatibility shim for PRISM.
 *
 * Provides revalidatePath() and revalidateTag() for on-demand cache invalidation.
 * In PRISM dev mode, clears in-memory caches.
 * In production (bext-server), triggers ISR tag-based invalidation.
 */

export { revalidatePath, revalidateTag } from "../helpers";

/** unstable_cache — stub that just calls the function directly. */
export function unstable_cache<T>(
  fn: (...args: any[]) => Promise<T>,
  _keyParts?: string[],
  _options?: { revalidate?: number; tags?: string[] },
): (...args: any[]) => Promise<T> {
  return fn;
}

/** unstable_noStore — stub (no-op). */
export function unstable_noStore() {}
