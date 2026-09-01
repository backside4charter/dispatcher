import { describe, expect, it } from "vitest"
import { runMain } from "./main"
import type { MainHandlers } from "./main"

/** Captured output for assertions. */
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
 * Builds handlers that record how they were invoked instead of doing anything.
 */
function recordingHandlers(calls: string[]): MainHandlers {
  return {
    board: (argv) => {
      calls.push(`board:${argv.join(",")}`)
      return Promise.resolve(0)
    },
    events: (argv) => {
      calls.push(`events:${argv.join(",")}`)
      return Promise.resolve(0)
    },
    pruneWorktrees: (argv) => {
      calls.push(`prune:${argv.join(",")}`)
      return Promise.resolve(0)
    },
    reviewSync: () => {
      calls.push("review-sync")
      return Promise.resolve(0)
    },
    token: (argv) => {
      calls.push(`token:${argv.join(",")}`)
      return Promise.resolve(0)
    },
    identity: (argv) => {
      calls.push(`identity:${argv.join(",")}`)
      return Promise.resolve(0)
    },
    pr: (argv) => {
      calls.push(`pr:${argv.join(",")}`)
      return Promise.resolve(0)
    },
    commit: (argv) => {
      calls.push(`commit:${argv.join(",")}`)
      return Promise.resolve(0)
    },
    init: (argv) => {
      calls.push(`init:${argv.join(",")}`)
      return Promise.resolve(0)
    },
  }
}

describe("runMain", () => {
  it("routes `init`", async () => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain(["init"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual(["init:"])
  })

  it("routes `board` to the board CLI with the remaining arguments", async () => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain(["board", "issue", "ACM-12", "--json"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual(["board:issue,ACM-12,--json"])
  })

  it.each(["listen", "status", "wait", "consume"])("routes `%s` to the event-channel CLI including the command name", async (command) => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain([command, "--dir", "D:/state"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual([`events:${command},--dir,D:/state`])
  })

  it("routes `prune-worktrees` with its flags", async () => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain(["prune-worktrees", "--dry-run"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual(["prune:--dry-run"])
  })

  it("routes `review-sync`", async () => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain(["review-sync"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual(["review-sync"])
  })

  it.each(["token", "identity"])("routes `%s` with its --app selection", async (command) => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain([command, "--app", "reviewer"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual([`${command}:--app,reviewer`])
  })

  it("routes `pr` with its flags", async () => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain(["pr", "--title", "T", "--draft"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual(["pr:--title,T,--draft"])
  })

  it("routes `commit` with its message flags", async () => {
    const calls: string[] = []
    const { io } = captureIo()
    const code = await runMain(["commit", "-m", "msg"], io, recordingHandlers(calls))
    expect(code).toBe(0)
    expect(calls).toEqual(["commit:-m,msg"])
  })

  it("propagates the handler's exit code", async () => {
    const { io } = captureIo()
    const handlers = recordingHandlers([])
    handlers.board = () => Promise.resolve(3)
    const code = await runMain(["board", "poll"], io, handlers)
    expect(code).toBe(3)
  })

  it.each(["version", "--version", "-v"])("prints the version for `%s`", async (flag) => {
    const captured = captureIo()
    const code = await runMain([flag], captured.io, recordingHandlers([]))
    expect(code).toBe(0)
    expect(captured.out).toHaveLength(1)
    expect(captured.out[0]).toMatch(/^dispatcher \S+$/)
  })

  it.each(["help", "--help", "-h"])("prints usage on stdout for `%s`", async (flag) => {
    const captured = captureIo()
    const code = await runMain([flag], captured.io, recordingHandlers([]))
    expect(code).toBe(0)
    expect(captured.out.join("\n")).toContain("board")
    expect(captured.out.join("\n")).toContain("prune-worktrees")
    expect(captured.err).toHaveLength(0)
  })

  it("prints usage on stderr and exits 2 with no command", async () => {
    const captured = captureIo()
    const code = await runMain([], captured.io, recordingHandlers([]))
    expect(code).toBe(2)
    expect(captured.err.join("\n")).toContain("usage:")
    expect(captured.out).toHaveLength(0)
  })

  it("names an unknown command before the usage and exits 2", async () => {
    const captured = captureIo()
    const code = await runMain(["frobnicate"], captured.io, recordingHandlers([]))
    expect(code).toBe(2)
    expect(captured.err[0]).toContain("frobnicate")
    expect(captured.err.join("\n")).toContain("usage:")
  })
})
