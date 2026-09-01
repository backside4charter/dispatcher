import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { BoardEvent } from "./board-events"
import { parseListenOptions, resolveListenSettings, resolveStateDir, runCli } from "./cli"
import { appendEvent, readPendingEvents, writeListenerHeartbeat } from "./event-log"
import { DEFAULT_LINEAR_POLL_MS, DEFAULT_LISTENER_PORT } from "./listener"
import { TEST_CONFIG } from "./testing/board-fixtures"

/** Captured CLI output for assertions. */
interface CapturedIo {
  out: string[]
  err: string[]
  io: { out: (line: string) => void; err: (line: string) => void }
}

/**
 * Builds an io sink that captures output lines.
 */
function captureIo(): CapturedIo {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (line: string) => { out.push(line) },
      err: (line: string) => { err.push(line) },
    },
  }
}

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
    port: 47831,
    startedAt: now,
    updatedAt: now,
    eventsAccepted: 2,
    eventsIgnored: 3,
    forward: { enabled: true, running: true, restarts: 1, lastError: null },
  })
}

/**
 * Polls until the condition returns true or the timeout elapses.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

describe("resolveStateDir", () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "dispatcher-state-"))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  /** Creates a directory tree and drops a dispatcher.config.json at `configAt`. */
  function makeRepo(configAt: string, ...deeper: string[]): { repo: string; cwd: string } {
    const repo = path.join(tempRoot, configAt)
    const cwd = path.join(repo, ...deeper)
    mkdirSync(cwd, { recursive: true })
    writeFileSync(path.join(repo, "dispatcher.config.json"), "{}")
    return { repo, cwd }
  }

  it("prefers an explicit --dir value over everything else", () => {
    const dir = resolveStateDir("D:/explicit/state", { DISPATCHER_STATE_DIR: "D:/env/state" })
    expect(dir).toBe(path.resolve("D:/explicit/state"))
  })

  it("falls back to the DISPATCHER_STATE_DIR environment variable", () => {
    const dir = resolveStateDir(undefined, { DISPATCHER_STATE_DIR: "D:/env/state" })
    expect(dir).toBe(path.resolve("D:/env/state"))
  })

  it("walks up from the working directory to the nearest dispatcher.config.json", () => {
    const { repo, cwd } = makeRepo("repo", "packages", "deep")
    const dir = resolveStateDir(undefined, {}, cwd)
    expect(dir).toBe(path.join(repo, ".claude", "dispatcher"))
  })

  it("resolves in the config's own directory too, not just below it", () => {
    const { repo } = makeRepo("repo")
    const dir = resolveStateDir(undefined, {}, repo)
    expect(dir).toBe(path.join(repo, ".claude", "dispatcher"))
  })

  it("stops at the nearest config, so a nested checkout never shares an enclosing one's state", () => {
    // A git worktree nests under the main checkout's .claude/worktrees/ and
    // carries its own committed dispatcher.config.json, so the walk must stop
    // there instead of climbing out into the main checkout's state directory.
    const { repo: outer } = makeRepo("outer")
    const { repo: inner, cwd } = makeRepo(path.join("outer", ".claude", "worktrees", "wt"), "packages")
    expect(inner.startsWith(outer)).toBe(true)
    const dir = resolveStateDir(undefined, {}, cwd)
    expect(dir).toBe(path.join(inner, ".claude", "dispatcher"))
  })

  it("throws when no dispatcher.config.json exists above the working directory", () => {
    const bare = path.join(tempRoot, "bare")
    mkdirSync(bare, { recursive: true })
    expect(() => resolveStateDir(undefined, {}, bare)).toThrow(/dispatcher\.config\.json/)
  })
})

describe("parseListenOptions", () => {
  it("applies the documented defaults", () => {
    const options = parseListenOptions([])
    // Undefined port and org mean "resolve from the config at listen time".
    expect(options.port).toBeUndefined()
    expect(options.org).toBeUndefined()
    expect(options.forward).toBe(true)
    // Undefined means "the configured platform's event set", decided at listen time.
    expect(options.events).toBeUndefined()
    expect(options.linear).toBe(true)
    expect(options.linearPollMs).toBe(DEFAULT_LINEAR_POLL_MS)
    expect(options.platform).toBeUndefined()
  })

  it("honours explicit flags", () => {
    const options = parseListenOptions([
      "--port", "1234", "--no-forward", "--org", "acme", "--events", "pull_request",
      "--no-linear", "--linear-poll-ms", "5000", "--platform", "github", "--config", "x.json",
    ])
    expect(options.port).toBe(1234)
    expect(options.forward).toBe(false)
    expect(options.org).toBe("acme")
    expect(options.events).toEqual(["pull_request"])
    expect(options.linear).toBe(false)
    expect(options.linearPollMs).toBe(5000)
    expect(options.platform).toBe("github")
    expect(options.config).toBe("x.json")
  })

  it("refuses a Linear poll interval that would burn the API budget", () => {
    expect(() => parseListenOptions(["--linear-poll-ms", "100"])).toThrow("minimum 1000")
  })
})

describe("resolveListenSettings", () => {
  it("prefers explicit flags over the config", () => {
    const settings = resolveListenSettings({ port: 1234, org: "acme" }, { ...TEST_CONFIG, listener: { port: 48901 } })
    expect(settings).toEqual({ port: 1234, org: "acme" })
  })

  it("falls back to the config's listener port, then the default", () => {
    expect(resolveListenSettings({}, { ...TEST_CONFIG, listener: { port: 48901 } }).port).toBe(48901)
    expect(resolveListenSettings({}, TEST_CONFIG).port).toBe(DEFAULT_LISTENER_PORT)
  })

  it("derives the forward org from the configured repository", () => {
    expect(resolveListenSettings({}, TEST_CONFIG).org).toBe("acme")
    expect(resolveListenSettings({}, { ...TEST_CONFIG, repository: "acme/widgets" }).org).toBe("acme")
  })
})

describe("runCli", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dispatcher-cli-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("rejects an unknown command with usage on stderr", async () => {
    const captured = captureIo()
    const code = await runCli(["frobnicate"], captured.io)
    expect(code).toBe(2)
    expect(captured.err.join("\n")).toContain("usage")
  })

  describe("status", () => {
    it("reports an up listener with forward and event counts, exiting 0", async () => {
      writeLiveHeartbeat(dir)
      appendEvent(dir, makeEvent("pending one"))
      const captured = captureIo()
      const code = await runCli(["status", "--dir", dir], captured.io)
      expect(code).toBe(0)
      const text = captured.out.join("\n")
      expect(text).toContain(`listener: up (pid ${process.pid}, port 47831)`)
      expect(text).toContain("forward: running (restarts 1)")
      // A heartbeat written before the Linear poller existed still reads.
      expect(text).toContain("linear: off")
      expect(text).toContain("events: 2 accepted, 3 ignored")
      expect(text).toContain("pending: 1 unconsumed event(s)")
    })

    it("reports the Linear poller's health next to the forward channel's", async () => {
      const now = new Date().toISOString()
      writeListenerHeartbeat(dir, {
        pid: process.pid,
        port: 47831,
        startedAt: now,
        updatedAt: now,
        eventsAccepted: 0,
        eventsIgnored: 0,
        forward: { enabled: false, running: false, restarts: 0, lastError: null },
        linear: { enabled: true, running: true, polls: 12, errors: 1, lastPollAt: now, lastError: "Linear responded 502" },
      })
      const captured = captureIo()
      expect(await runCli(["status", "--dir", dir], captured.io)).toBe(0)
      const text = captured.out.join("\n")
      expect(text).toContain(`linear: polling (12 polls, 1 errors, last ${now})`)
      expect(text).toContain("linear error: Linear responded 502")
    })

    it("reports a down listener with the reason, exiting 1", async () => {
      const captured = captureIo()
      const code = await runCli(["status", "--dir", dir], captured.io)
      expect(code).toBe(1)
      const text = captured.out.join("\n")
      expect(text).toContain("listener: down - no listener heartbeat")
      expect(text).toContain("pending: 0 unconsumed event(s)")
    })

    it("reports a broken forward channel distinctly from a down listener", async () => {
      const now = new Date().toISOString()
      writeListenerHeartbeat(dir, {
        pid: process.pid,
        port: 47831,
        startedAt: now,
        updatedAt: now,
        eventsAccepted: 0,
        eventsIgnored: 0,
        forward: {
          enabled: true, running: false, restarts: 4, lastError: "gh exited (code 4)",
        },
      })
      const captured = captureIo()
      const code = await runCli(["status", "--dir", dir], captured.io)
      expect(code).toBe(0)
      const text = captured.out.join("\n")
      expect(text).toContain("forward: NOT running (restarts 4)")
      expect(text).toContain("forward error: gh exited (code 4)")
    })
  })

  describe("consume", () => {
    it("prints and consumes pending events exactly once", async () => {
      appendEvent(dir, makeEvent("row moved to Ready"))
      appendEvent(dir, makeEvent("PR #452 merged"))
      const first = captureIo()
      expect(await runCli(["consume", "--dir", dir], first.io)).toBe(0)
      const text = first.out.join("\n")
      expect(text).toContain("row moved to Ready")
      expect(text).toContain("PR #452 merged")
      expect(text).toContain("consumed 2 event(s)")
      expect(readPendingEvents(dir).events).toHaveLength(0)

      const second = captureIo()
      expect(await runCli(["consume", "--dir", dir], second.io)).toBe(0)
      expect(second.out.join("\n")).toContain("no pending events")
    })
  })

  describe("wait", () => {
    it("wakes immediately on already-pending events without consuming them", async () => {
      appendEvent(dir, makeEvent("pending event"))
      const captured = captureIo()
      const code = await runCli(
        ["wait", "--dir", dir, "--timeout-seconds", "5", "--debounce-ms", "20", "--poll-ms", "10"],
        captured.io,
      )
      expect(code).toBe(0)
      const text = captured.out.join("\n")
      expect(text).toContain("wake: 1 new board event(s)")
      expect(text).toContain("pending event")
      // The wake never consumes - the next consume drains it.
      expect(readPendingEvents(dir).events).toHaveLength(1)
    })

    it("reports channel-down immediately when no listener is running", async () => {
      const captured = captureIo()
      const code = await runCli(
        ["wait", "--dir", dir, "--timeout-seconds", "5", "--debounce-ms", "20", "--poll-ms", "10"],
        captured.io,
      )
      expect(code).toBe(0)
      expect(captured.out.join("\n")).toContain("channel-down: no listener heartbeat")
    })

    it("times out cleanly when the listener is up but nothing arrives", async () => {
      writeLiveHeartbeat(dir)
      const captured = captureIo()
      const code = await runCli(
        ["wait", "--dir", dir, "--timeout-seconds", "0.2", "--debounce-ms", "20", "--poll-ms", "10"],
        captured.io,
      )
      expect(code).toBe(0)
      expect(captured.out.join("\n")).toContain("timeout: no board events within 0.2s")
    })
  })

  describe("listen", () => {
    it("starts a listener that accepts deliveries and stops gracefully on abort", async () => {
      const configPath = path.join(dir, "dispatcher.config.json")
      writeFileSync(configPath, JSON.stringify(TEST_CONFIG))
      const captured = captureIo()
      const controller = new AbortController()
      // --no-linear: the test must never poll the real Linear API, and on a
      // machine without a key the listener has to come up regardless.
      const running = runCli(
        ["listen", "--dir", dir, "--config", configPath, "--no-forward", "--no-linear", "--port", "0"],
        captured.io,
        { signal: controller.signal },
      )

      // The listener is up once it prints its bound webhook URL.
      await waitUntil(() => captured.out.some((line) => line.includes("/webhook")))
      const urlLine = captured.out.find((line) => line.includes("/webhook"))
      const match = urlLine?.match(/127\.0\.0\.1:(\d+)/)
      if (!match?.[1]) throw new Error(`no port in listen output: ${urlLine}`)
      const port = Number(match[1])

      const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-github-event": "pull_request" },
        body: JSON.stringify({
          action: "opened",
          pull_request: { number: 7, title: "A task", merged: false },
          repository: { full_name: "acme/widgets" },
          sender: { login: "the-owner", type: "User" },
        }),
      })
      expect(response.status).toBe(202)
      expect(readPendingEvents(dir).events).toHaveLength(1)
      const text = captured.out.join("\n")
      expect(text).toContain("board: linear (")
      expect(text).toContain("Linear polling off: disabled (--no-linear)")

      controller.abort()
      expect(await running).toBe(0)
    })
  })
})
