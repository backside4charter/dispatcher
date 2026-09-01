import type { BoardEvent } from "./board-events"
import { clearWaiterLock, isListenerUp, isPidAlive, logSize, readPendingEvents, readWaiterLock, writeWaiterLock } from "./event-log"

/** The outcome of one wait-for-events run. */
export type WaitOutcome =
  | { kind: "events"; events: BoardEvent[] }
  | { kind: "already-waiting"; pid: number }
  | { kind: "channel-down"; reason: string }
  | { kind: "timeout" }

/** Options for waiting on the event log. */
export interface WaitOptions {
  /** State directory shared with the listener. */
  dir: string
  /** How long to wait before giving up. */
  timeoutMs: number
  /** Quiet period after the last new event before waking, to coalesce bursts. */
  debounceMs?: number
  /** How often the log and heartbeat are checked. */
  pollIntervalMs?: number
}

/**
 * Sleeps for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Blocks until a new board event lands in the log, then resolves - the wake
 * primitive of the dispatcher's event channel. The dispatcher runs this as a
 * background task; the process exiting is what re-invokes the session.
 *
 * Outcomes:
 * - `events`: new events arrived (or were already pending). A short debounce
 *   after the last append coalesces bursts into one wake.
 * - `channel-down`: the listener is not running, went stale, or died - the
 *   dispatcher keeps polling on its normal cadence, losing nothing.
 * - `already-waiting`: another live waiter holds the lock; do not start a
 *   second one.
 * - `timeout`: nothing arrived; benign, the caller just re-arms.
 *
 * The waiter never advances the consume cursor - only an explicit consume
 * does - so no outcome can lose events.
 */
export async function waitForEvents(options: WaitOptions): Promise<WaitOutcome> {
  const {
    dir, timeoutMs, debounceMs = 5_000, pollIntervalMs = 1_000,
  } = options

  /**
   * Reads pending events as an outcome, or null when there are none.
   */
  const pendingOutcome = (): WaitOutcome | null => {
    const pending = readPendingEvents(dir)
    if (pending.events.length === 0) return null
    return { kind: "events", events: pending.events }
  }

  // Events already sitting in the log win over every other check - they are
  // exactly what the caller wants to know about.
  const alreadyPending = pendingOutcome()
  if (alreadyPending !== null) return alreadyPending

  const listener = isListenerUp(dir)
  if (!listener.up) {
    return { kind: "channel-down", reason: listener.reason ?? "listener is down" }
  }

  const existingLock = readWaiterLock(dir)
  if (existingLock !== null && existingLock.pid !== process.pid && isPidAlive(existingLock.pid)) {
    return { kind: "already-waiting", pid: existingLock.pid }
  }
  writeWaiterLock(dir, { pid: process.pid, startedAt: new Date().toISOString() })

  try {
    const startedMs = Date.now()
    const baselineSize = logSize(dir)
    let lastSize = baselineSize
    let lastGrowthMs: number | null = null

    for (;;) {
      await sleep(pollIntervalMs)

      const size = logSize(dir)
      if (size !== lastSize) {
        lastSize = size
        lastGrowthMs = Date.now()
      }

      // Wake once the log grew and has been quiet for the debounce period.
      if (lastGrowthMs !== null && Date.now() - lastGrowthMs >= debounceMs) {
        const outcome = pendingOutcome()
        if (outcome !== null) return outcome
        // The growth produced no complete consumable lines (partial write or
        // already-consumed data) - keep waiting.
        lastGrowthMs = null
      }

      const health = isListenerUp(dir)
      if (!health.up) {
        // Prefer reporting events that arrived just before the channel died.
        const outcome = pendingOutcome()
        if (outcome !== null) return outcome
        return { kind: "channel-down", reason: health.reason ?? "listener is down" }
      }

      if (Date.now() - startedMs >= timeoutMs) {
        const outcome = pendingOutcome()
        if (outcome !== null) return outcome
        return { kind: "timeout" }
      }
    }
  } finally {
    const lock = readWaiterLock(dir)
    if (lock !== null && lock.pid === process.pid) clearWaiterLock(dir)
  }
}
