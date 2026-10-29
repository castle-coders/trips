// Miniflare's ratelimit simulator uses fixed wall-clock windows:
//   epoch = Math.floor(Date.now() / (period * 1000))   (miniflare ratelimit.worker.js)
// so a counter resets at every minute boundary (period = 60). A test that fires N requests and
// expects the (limit+1)th to be 429 flakes if its loop straddles a boundary. Call this right
// before the loop: if fewer than `budgetMs` remain in the current window, wait for the next one.
const PERIOD_MS = 60_000;

export async function awaitFreshRateWindow(budgetMs: number): Promise<void> {
  const remaining = PERIOD_MS - (Date.now() % PERIOD_MS);
  if (remaining < budgetMs) await new Promise((r) => setTimeout(r, remaining + 50));
}

/** Per-test timeout for limit tests: the loop budget plus a full possible wait. */
export const RATE_LIMIT_TEST_TIMEOUT_MS = 30_000;
