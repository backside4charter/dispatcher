import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runBoardCli, stateArgument } from "./board-cli"
import type { BoardCliDeps } from "./board-cli"
import { MemoryBoard, TEST_CONFIG } from "./testing/board-fixtures"

/** Captured CLI output for assertions. */
interface Captured {
  out: string[]
  err: string[]
  io: { out: (line: string) => void; err: (line: string) => void }
}

/**
 * Builds an io sink that captures output lines.
 */
function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => { out.push(line) }, err: (line) => { err.push(line) } } }
}

const NOW = new Date("2026-08-27T12:00:00Z")

/**
 * Builds the CLI's dependencies around an in-memory board, recording which
 * config path and platform override the CLI asked for.
 */
function deps(board: MemoryBoard, overrides: Partial<BoardCliDeps> = {}): BoardCliDeps & { loads: { path?: string; platform?: string }[] } {
  const loads: { path?: string; platform?: string }[] = []
  return {
    loads,
    backend: () => board,
    loadConfig: (explicitPath, platformOverride) => {
      loads.push({ path: explicitPath, platform: platformOverride })
      return { config: TEST_CONFIG, path: "/repo/dispatcher.config.json" }
    },
    env: { CLAUDE_CODE_SESSION_ID: "sess-me" },
    now: () => NOW,
    gh: () => { throw new Error("gh not stubbed") },
    ...overrides,
  }
}

describe("stateArgument", () => {
  it("turns role spellings into roles and leaves display names alone", () => {
    expect(stateArgument(["in-progress"])).toBe("inProgress")
    expect(stateArgument(["In", "Progress"])).toBe("inProgress")
    expect(stateArgument(["human-review"])).toBe("humanReview")
    expect(stateArgument(["User", "Review"])).toBe("humanReview")
    expect(stateArgument(["hold"])).toBe("backlog")
    expect(stateArgument(["Some", "Custom", "State"])).toBe("Some Custom State")
  })
})

describe("runBoardCli", () => {
  it("prints usage for a missing or unknown command and the error for a bad reference", async () => {
    const empty = capture()
    expect(await runBoardCli([], empty.io, deps(new MemoryBoard()))).toBe(2)
    expect(empty.err.join("\n")).toContain("usage")

    const bad = capture()
    expect(await runBoardCli(["issue", "480"], bad.io, deps(new MemoryBoard()))).toBe(2)
    expect(bad.err.join("\n")).toContain("expected an issue identifier like ACM-12")
  })

  it("passes --config and --platform through to the config loader", async () => {
    const d = deps(new MemoryBoard())
    const captured = capture()
    expect(await runBoardCli(["--config", "x.json", "--platform", "github", "config"], captured.io, d)).toBe(0)
    expect(d.loads).toEqual([{ path: "x.json", platform: "github" }])
    const text = captured.out.join("\n")
    expect(text).toContain("config: /repo/dispatcher.config.json")
    expect(text).toContain("platform: linear")
    expect(text).toContain("humanReview: Human Review")
    expect(text).toContain('labels: confirmWithUser="Confirm with user" ui="UI"')
    expect(text).toContain("question: Question")
  })

  it("lists states and milestones", async () => {
    const board = new MemoryBoard([{ ref: "ACM-1" }, { ref: "ACM-2", milestone: "v1.2.0" }, { ref: "ACM-3", closed: true }])
    const states = capture()
    expect(await runBoardCli(["states"], states.io, deps(board))).toBe(0)
    expect(states.out[1]).toBe("Backlog\tbacklog\tno\tst-backlog")
    const milestones = capture()
    expect(await runBoardCli(["milestones"], milestones.io, deps(board))).toBe(0)
    expect(milestones.out).toEqual(["milestone\topen", "v1.1.0\t1", "v1.2.0\t1"])
  })

  describe("poll", () => {
    it("requires a milestone and prints the rows in board order", async () => {
      const board = new MemoryBoard([
        { ref: "ACM-2", sortIndex: 20, title: "Second" },
        { ref: "ACM-1", sortIndex: 10, title: "First", labels: ["UI"], assignee: "Lars", openBlockers: ["ACM-9"] },
        { ref: "ACM-3", sortIndex: 5, milestone: "v1.2.0" },
      ])
      const captured = capture()
      expect(await runBoardCli(["poll"], captured.io, deps(board))).toBe(2)
      expect(captured.err.join("\n")).toContain("milestone")

      const ok = capture()
      expect(await runBoardCli(["poll", "v1.1.0", "v1.0.1"], ok.io, deps(board))).toBe(0)
      expect(ok.out[0]).toMatch(/^milestone\tstate\tdelegate\tclaim\tissue/)
      expect(ok.out[1]).toBe("v1.1.0\tReady\t-\t-\tACM-1\tUI\tLars\tACM-9\t-\t-\t-\tFirst")
      expect(ok.out[2]).toBe("v1.1.0\tReady\t-\t-\tACM-2\t-\t-\t-\t-\t-\t-\tSecond")
      expect(ok.out).toHaveLength(3)

      const all = capture()
      expect(await runBoardCli(["poll", "--all-milestones"], all.io, deps(board))).toBe(0)
      expect(all.out).toHaveLength(4)
    })
  })

  describe("issue", () => {
    it("renders Markdown by default and raw JSON on request", async () => {
      const board = new MemoryBoard()
      board.add({ ref: "ACM-3", title: "Unity Plugin", description: "- [ ] docs", comments: [{ author: "Lars", createdAt: "2026-08-27T11:00:00.000Z", body: "Go" }] })
      const md = capture()
      expect(await runBoardCli(["issue", "acm-3", "--comments", "1"], md.io, deps(board))).toBe(0)
      expect(md.out.join("\n")).toContain("# ACM-3 Unity Plugin")
      expect(md.out.join("\n")).toContain("- [ ] docs")
      expect(md.out.join("\n")).toContain("### Lars at 2026-08-27T11:00:00.000Z")

      const json = capture()
      expect(await runBoardCli(["issue", "ACM-3", "--json"], json.io, deps(board))).toBe(0)
      expect(JSON.parse(json.out.join("\n")).ref).toBe("ACM-3")
    })
  })

  describe("state", () => {
    it("moves an issue by role or name and reports a no-op", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const captured = capture()
      expect(await runBoardCli(["state", "ACM-12", "in-progress"], captured.io, deps(board))).toBe(0)
      expect(captured.out).toEqual(["ACM-12: Ready -> In Progress"])
      expect(await runBoardCli(["state", "ACM-12", "In", "Progress"], captured.io, deps(board))).toBe(0)
      expect(captured.out[1]).toBe("ACM-12 already at In Progress")
      expect(board.writes).toEqual(["state ACM-12 Ready -> In Progress"])
    })

    it("surfaces the backend's refusal to complete a top-level task", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const captured = capture()
      expect(await runBoardCli(["state", "ACM-12", "done"], captured.io, deps(board))).toBe(2)
      expect(captured.err.join("\n")).toContain("refusing to set ACM-12 to Done")
    })

    it("parks a task in the question state, which replaced the label", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const captured = capture()
      expect(await runBoardCli(["state", "ACM-12", "question"], captured.io, deps(board))).toBe(0)
      expect(captured.out).toEqual(["ACM-12: Ready -> Question"])
    })

    it("points a retired role at the flow that replaced it instead of reading as a typo", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const captured = capture()
      expect(await runBoardCli(["state", "ACM-12", "ai-review"], captured.io, deps(board))).toBe(2)
      expect(captured.err.join("\n")).toContain("the AI Review state was removed")
      expect(captured.err.join("\n")).toContain("board assign <ref> reviewer")
      expect(board.writes).toEqual([])
    })
  })

  describe("assign", () => {
    it("hands a row to the reviewer without claiming it, and clears the claim", async () => {
      const board = new MemoryBoard([{
        ref: "ACM-12",
        state: "In Progress",
        stateRole: "inProgress",
        claim: { role: "dev", sessionId: "sess-done", stampedAt: "2026-08-27T11:00Z" },
      }])
      await board.claim("ACM-12", "dev", "sess-done", new Date("2026-08-27T11:00:00Z"))

      const captured = capture()
      expect(await runBoardCli(["assign", "ACM-12", "reviewer"], captured.io, deps(board))).toBe(0)
      expect(captured.out[0]).toBe("ACM-12 assigned to reviewer (was developer), cleared dev:sess-done@2026-08-27T11:00Z")

      const row = await board.issue("ACM-12")
      expect(row.delegate).toBe("acme-reviewer")
      expect(row.claim).toBeNull()
      // The row stays In Progress: the phase moved, not the state.
      expect(row.state).toBe("In Progress")
    })

    it("rejects anything that is not an agent identity", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const bad = capture()
      expect(await runBoardCli(["assign", "ACM-12", "dev"], bad.io, deps(board))).toBe(2)
      expect(bad.err.join("\n")).toContain("assign needs an agent: developer or reviewer")
      const missing = capture()
      expect(await runBoardCli(["assign", "ACM-12"], missing.io, deps(board))).toBe(2)
      expect(missing.err.join("\n")).toContain("got nothing")
    })
  })

  describe("claim / release", () => {
    it("claims for this session, reports what it replaced, and rejects an unknown role", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12", claim: { role: "dev", sessionId: "dead", stampedAt: "2026-08-27T08:00Z" } }])
      const captured = capture()
      expect(await runBoardCli(["claim", "ACM-12", "review"], captured.io, deps(board))).toBe(0)
      expect(captured.out).toEqual(["ACM-12 claimed review:sess-me@2026-08-27T12:00Z (replaced dev:dead@2026-08-27T08:00Z)"])

      const bad = capture()
      expect(await runBoardCli(["claim", "ACM-12", "owner"], bad.io, deps(board))).toBe(2)
      expect(bad.err.join("\n")).toContain("claim needs a role")
    })

    it("releases a claim, but leaves another session's claim alone when told whose to release", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12", claim: { role: "dev", sessionId: "sess-other", stampedAt: "2026-08-27T11:00Z" } }])
      const guarded = capture()
      expect(await runBoardCli(["release", "ACM-12", "--session", "sess-me"], guarded.io, deps(board))).toBe(0)
      expect(guarded.out[0]).toContain("left alone: claimed by dev:sess-other")
      expect(board.writes).toEqual([])

      const released = capture()
      expect(await runBoardCli(["release", "ACM-12"], released.io, deps(board))).toBe(0)
      expect(released.out[0]).toBe("ACM-12 released (was dev:sess-other@2026-08-27T11:00Z)")

      const none = capture()
      expect(await runBoardCli(["release", "ACM-12"], none.io, deps(board))).toBe(0)
      expect(none.out[0]).toBe("ACM-12 has no claim")
    })

    it("clears a delegate left behind with no claim comment, even under --session", async () => {
      // The half-state the claim's write ordering is designed to produce: the
      // delegate is written first, so a failed comment write leaves a row an
      // agent appears to hold with no session on it. `--session` exists to
      // avoid clearing *another live session's* claim, and a row with no claim
      // asserts no session at all - so guarding it there would mean the one
      // call `dispatcher:stop` makes could never clean up the very failure the
      // ordering exists to make safe.
      const board = new MemoryBoard([{
        ref: "ACM-12",
        state: "In Progress",
        stateRole: "inProgress",
        delegate: "acme-developer",
        assignee: "someuser",
      }])
      const captured = capture()

      expect(await runBoardCli(["release", "ACM-12", "--session", "sess-me"], captured.io, deps(board))).toBe(0)
      expect(captured.out[0]).toBe("ACM-12 had no claim; cleared the developer delegate it was left with")
      expect(board.writes).toEqual(["release ACM-12"])
      const row = await board.issue("ACM-12")
      expect(row.delegate).toBeNull()
      expect(row.assignee).toBeNull()
    })

    it("reports an untouched row under --session when there is nothing to clear at all", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const captured = capture()

      expect(await runBoardCli(["release", "ACM-12", "--session", "sess-me"], captured.io, deps(board))).toBe(0)
      expect(captured.out[0]).toBe("ACM-12 has no claim")
      expect(board.writes).toEqual([])
    })
  })

  describe("claims", () => {
    it("lists claimed rows with staleness, queued rows and parked questions, project-wide", async () => {
      const board = new MemoryBoard([
        { ref: "ACM-1", sortIndex: 10, title: "Mine", delegate: "acme-developer", claim: { role: "dev", sessionId: "sess-me", stampedAt: "2026-08-27T09:00Z" } },
        { ref: "ACM-2", sortIndex: 20, title: "Dead", milestone: "v1.0.1", state: "In Progress", stateRole: "inProgress", delegate: "acme-reviewer", claim: { role: "review", sessionId: "sess-dead", stampedAt: "2026-08-27T09:00Z" } },
        { ref: "ACM-3", sortIndex: 30, title: "Fresh", state: "In Progress", stateRole: "inProgress", delegate: "acme-developer", claim: { role: "dev", sessionId: "sess-live", stampedAt: "2026-08-27T11:50Z" } },
        { ref: "ACM-4", sortIndex: 40, title: "Parked", state: "Question", stateRole: "question" },
        { ref: "ACM-6", sortIndex: 45, title: "Queued", state: "In Progress", stateRole: "inProgress", delegate: "acme-reviewer" },
        { ref: "ACM-5", sortIndex: 50, title: "Plain", state: "Backlog", stateRole: "backlog" },
      ])
      const captured = capture()
      expect(await runBoardCli(["claims"], captured.io, deps(board))).toBe(0)
      expect(captured.out.slice(1, -1)).toEqual([
        "own-claim\tv1.1.0\tReady\tacme-developer\tdev:sess-me@2026-08-27T09:00Z\t180\tACM-1\tMine",
        "stale-claim\tv1.0.1\tIn Progress\tacme-reviewer\treview:sess-dead@2026-08-27T09:00Z\t180\tACM-2\tDead",
        "claim\tv1.1.0\tIn Progress\tacme-developer\tdev:sess-live@2026-08-27T11:50Z\t10\tACM-3\tFresh",
        // A parked question is a state now, so no label needs reading.
        "question\tv1.1.0\tQuestion\t-\t-\t-\tACM-4\tParked",
        // Delegated but unclaimed: waiting for a reviewer to pick it up.
        "queued\tv1.1.0\tIn Progress\tacme-reviewer\t-\t-\tACM-6\tQueued",
      ])
      expect(captured.out.at(-1)).toContain("older than 90 minutes")
    })
  })

  describe("comment", () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "board-cli-"))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it("posts the body file's contents tagged with the role that wrote it", async () => {
      const file = path.join(dir, "body.md")
      writeFileSync(file, "PR: https://github.com/acme/widgets/pull/600\n\nVerify by running `just dev`.\n")
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const captured = capture()
      expect(await runBoardCli(["comment", "ACM-12", "--as", "dispatcher", "--body-file", file], captured.io, deps(board))).toBe(0)
      expect(board.writes).toEqual(["comment ACM-12 **[dispatcher]**\n\nPR: https://github.com/acme/widgets/pull/600\n\nVerify by running `just dev`."])
      expect(captured.out[0]).toMatch(/^ACM-12 commented as dispatcher: https:/)
    })

    it("insists on a role and a body file", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const noRole = capture()
      expect(await runBoardCli(["comment", "ACM-12", "--body-file", "x"], noRole.io, deps(board))).toBe(2)
      expect(noRole.err.join("\n")).toContain("--as")
      const noBody = capture()
      expect(await runBoardCli(["comment", "ACM-12", "--as", "reviewer"], noBody.io, deps(board))).toBe(2)
      expect(noBody.err.join("\n")).toContain("--body-file")
    })
  })

  it("adds and removes labels by name, joining a multi-word name", async () => {
    const board = new MemoryBoard([{ ref: "ACM-12", labels: ["UI"] }])
    const captured = capture()
    expect(await runBoardCli(["label", "ACM-12", "add", "UI"], captured.io, deps(board))).toBe(0)
    expect(captured.out).toEqual(["ACM-12 labels: UI"])
    expect(await runBoardCli(["label", "ACM-12", "remove", "Confirm", "with", "user"], captured.io, deps(board))).toBe(0)
    expect(board.writes.at(-1)).toBe("label ACM-12 remove Confirm with user")
    const missing = capture()
    expect(await runBoardCli(["label", "ACM-12", "add", "Nope"], missing.io, deps(board))).toBe(2)
    expect(missing.err.join("\n")).toContain('no label named "Nope"')

    // The Question label became a state. Failing loudly matters here: a worker
    // that thought a label had parked a task would leave it looking
    // dispatchable while it waits on an answer nobody knows it needs.
    const retired = capture()
    expect(await runBoardCli(["label", "ACM-12", "add", "Question"], retired.io, deps(board))).toBe(2)
    expect(retired.err.join("\n")).toContain('refusing to write the "Question" label')
    expect(retired.err.join("\n")).toContain("board state <ref> question")
    expect(board.writes.filter((write) => write.includes("Question"))).toEqual([])
  })

  describe("pr-issues / link-pr", () => {
    const ghView = JSON.stringify({
      number: 600, url: "https://github.com/acme/widgets/pull/600", headRefName: "task/acm-12-thing", title: "Thing", body: "Fixes ACM-12",
    })

    it("reads the pull request through gh and prints what the board resolved it to", async () => {
      const board = new MemoryBoard()
      board.linked = [{ ref: "ACM-12", title: "Thing", url: "https://linear.app/x", state: "Human Review", stateRole: "humanReview", closed: false, agent: null, via: "identifier" }]
      const ghCalls: string[][] = []
      const captured = capture()
      expect(await runBoardCli(["pr-issues", "600"], captured.io, deps(board, { gh: (args) => { ghCalls.push(args); return ghView } }))).toBe(0)
      expect(ghCalls[0]).toEqual(["pr", "view", "600", "--repo", "acme/widgets", "--json", "number,url,headRefName,title,body"])
      expect(captured.out).toEqual(["issue\tstate\tvia\ttitle", "ACM-12\tHuman Review\tidentifier\tThing"])

      board.linked = []
      const none = capture()
      expect(await runBoardCli(["pr-issues", "600"], none.io, deps(board, { gh: () => ghView }))).toBe(0)
      expect(none.out[1]).toBe("(no board issue found for PR #600 task/acm-12-thing)")
    })

    it("links a pull request by number or URL", async () => {
      const board = new MemoryBoard([{ ref: "ACM-12" }])
      const captured = capture()
      expect(await runBoardCli(["link-pr", "ACM-12", "600"], captured.io, deps(board, { gh: () => ghView }))).toBe(0)
      expect(captured.out).toEqual(["ACM-12 linked https://github.com/acme/widgets/pull/600"])
      expect(await runBoardCli(["link-pr", "ACM-12", "https://github.com/acme/widgets/pull/601"], captured.io, deps(board))).toBe(0)
      expect(board.writes).toEqual([
        "link-pr ACM-12 https://github.com/acme/widgets/pull/600",
        "link-pr ACM-12 https://github.com/acme/widgets/pull/601",
      ])
    })
  })
})
