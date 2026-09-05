const DEFAULT_SHUTDOWN_DRAIN_MS = 45_000;
const MIN_SHUTDOWN_DRAIN_MS = 5_000;
const MAX_SHUTDOWN_DRAIN_MS = 50_000;

/** Resolve once during startup so a malformed shutdown contract fails early. */
export function resolveShutdownDrainMs(raw = process.env.SHUTDOWN_DRAIN_MS): number {
  if (raw === undefined || raw === '') return DEFAULT_SHUTDOWN_DRAIN_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)
      || parsed < MIN_SHUTDOWN_DRAIN_MS
      || parsed > MAX_SHUTDOWN_DRAIN_MS) {
    throw new Error(
      `SHUTDOWN_DRAIN_MS must be an integer between ${MIN_SHUTDOWN_DRAIN_MS} and ${MAX_SHUTDOWN_DRAIN_MS}`,
    );
  }
  return parsed;
}

/**
 * Wait for accepted work to drain without blocking admission shutdown.
 * Returns false only when the bounded deadline expires.
 */
export async function waitForDrain(
  isBusy: () => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isBusy() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  }
  return !isBusy();
}

export const SHUTDOWN_DB_CLOSE_MS = 5_000;
export const SHUTDOWN_COMPONENT_STOP_MS = 2_000;
