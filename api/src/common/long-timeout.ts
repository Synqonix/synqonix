/** Node runs a setTimeout longer than this (~24.8 days) after 1 ms instead of waiting. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Runs `fn` at `at` (epoch ms) however far away that is, by re-arming in chunks Node can hold.
 * Returns a function that cancels it.
 */
export function runAt(at: number, fn: () => void, now: () => number = Date.now): () => void {
  let handle: ReturnType<typeof setTimeout>;
  const arm = () => {
    const left = at - now();
    if (left <= 0) return fn();
    handle = setTimeout(arm, Math.min(left, MAX_TIMEOUT_MS));
  };
  arm();
  return () => clearTimeout(handle);
}
