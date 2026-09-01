import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BoardEvent } from "./board-events"
import { appendEvent, readWaiterLock, writeListenerHeartbeat, writeWaiterLock } from "./event-log"
import { waitForEvents } from "./waiter"

/**
 * Builds a BoardEvent for tests.
 */
function makeEvent(summary: string): BoardEvent {
  return {
    receivedAt: new Date().toISOString(),
    event: "projects_v2_item",
    action: "edited",
    summary,
  }
}

/**
 * Writes a heartbeat that reads as a live listener owned by this test process.
 */
function writeLiveHeartbeat(dir: string): void {
  const now = new Date().toISOString()
  writeListenerHeartbeat(dir, {
    pid: process.pid,
    port: 1,
    startedAt: now,
    updatedAt: now,
    eventsAccepted: 0,
    eventsIgnored: 0,
    forward: { enabled: true, running: true, restarts: 0, lastError: null },
  })
}

/**
 * Returns the pid of a process that is guaranteed to be dead.
 */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", ""])
  if (result.pid === undefined) throw new Error("failed to spawn probe process")
  return result.pid
}

describe("waitForEvents", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dispatcher-wait-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns already-pending events immediately, even when the listener is down", async () => {
    appendEvent(dir, makeEvent("pending event"))

    const outcome = await waitForEvents({ dir, timeoutMs: 5000, debounceMs: 20, pollIntervalMs: 10 })
    expect(outcome.kind).toBe("events")
    if (outcome.kind === "events") {
      expect(outcome.events).toHaveLength(1)
      expect(outcome.events[0]?.summary).toBe("pending event")
    }
  })

  it("wakes when a new event is appended, after a debounce quiet period", async () => {
    writeLiveHeartbeat(dir)

    const waiting = waitForEvents({ dir, timeoutMs: 10000, debounceMs: 50, pollIntervalMs: 10 })
    setTimeout(() => { appendEvent(dir, makeEvent("row moved to Ready")) }, 100)

    const outcome = await waiting
    expect(outcome.kind).toBe("events")
    if (outcome.kind === "events") {
      expect(outcome.events).toHaveLength(1)
      expect(outcome.events[0]?.summary).toBe("row moved to Ready")
    }
    expect(readWaiterLock(dir)).toBeNull()
  })

  it("coalesces a burst of events into a single wake", async () => {
    writeLiveHeartbeat(dir)

    const waiting = waitForEvents({ dir, timeoutMs: 10000, debounceMs: 300, pollIntervalMs: 10 })
    setTimeout(() => { appendEvent(dir, makeEvent("first")) }, 50)
    setTimeout(() => { appendEvent(dir, makeEvent("second")) }, 150)

    const outcome = await waiting
    expect(outcome.kind).toBe("events")
    if (outcome.kind === "events") {
      expect(outcome.events.map((event) => event.summary)).toEqual(["first", "second"])
    }
  })

  it("reports channel-down when no listener heartbeat exists", async () => {
    const outcome = await waitForEvents({ dir, timeoutMs: 1000, debounceMs: 20, pollIntervalMs: 10 })
    expect(outcome.kind).toBe("channel-down")
    if (outcome.kind === "channel-down") {
      expect(outcome.reason).toContain("no listener heartbeat")
    }
  })

  it("reports channel-down when the heartbeat is stale", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    writeListenerHeartbeat(dir, {
      pid: process.pid,
      port: 1,
      startedAt: stale,
      updatedAt: stale,
      eventsAccepted: 0,
      eventsIgnored: 0,
      forward: { enabled: true, running: true, restarts: 0, lastError: null },
    })

    const outcome = await waitForEvents({ dir, timeoutMs: 1000, debounceMs: 20, pollIntervalMs: 10 })
    expect(outcome.kind).toBe("channel-down")
    if (outcome.kind === "channel-down") {
      expect(outcome.reason).toContain("stale")
    }
  })

  it("reports channel-down when the listener process is dead", async () => {
    const now = new Date().toISOString()
    writeListenerHeartbeat(dir, {
      pid: deadPid(),
      port: 1,
      startedAt: now,
      updatedAt: now,
      eventsAccepted: 0,
      eventsIgnored: 0,
      forward: { enabled: true, running: true, restarts: 0, lastError: null },
    })

    const outcome = await waitForEvents({ dir, timeoutMs: 1000, debounceMs: 20, pollIntervalMs: 10 })
    expect(outcome.kind).toBe("channel-down")
    if (outcome.kind === "channel-down") {
      expect(outcome.reason).toContain("not running")
    }
  })

  it("reports already-waiting when another live process holds the waiter lock", async () => {
    writeLiveHeartbeat(dir)
    writeWaiterLock(dir, { pid: process.ppid, startedAt: new Date().toISOString() })

    const outcome = await waitForEvents({ dir, timeoutMs: 1000, debounceMs: 20, pollIntervalMs: 10 })
    expect(outcome.kind).toBe("already-waiting")
    if (outcome.kind === "already-waiting") {
      expect(outcome.pid).toBe(process.ppid)
    }
    // The other waiter's lock must be left in place.
    expect(readWaiterLock(dir)?.pid).toBe(process.ppid)
  })

  it("steals a stale waiter lock left by a dead process", async () => {
    writeLiveHeartbeat(dir)
    writeWaiterLock(dir, { pid: deadPid(), startedAt: new Date().toISOString() })

    const outcome = await waitForEvents({ dir, timeoutMs: 200, debounceMs: 20, pollIntervalMs: 10 })
    expect(outcome.kind).toBe("timeout")
    expect(readWaiterLock(dir)).toBeNull()
  })

  it("times out cleanly when nothing arrives, releasing the lock", async () => {
    writeLiveHeartbeat(dir)

    const outcome = await waitForEvents({ dir, timeoutMs: 150, debounceMs: 20, pollIntervalMs: 10 })
    expect(outcome.kind).toBe("timeout")
    expect(readWaiterLock(dir)).toBeNull()
  })
})
