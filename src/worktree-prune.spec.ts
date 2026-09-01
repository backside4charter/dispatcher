import { describe, expect, it, vi } from "vitest"
import {
  findOrphanDirectories,
  isInside,
  lockOwnerPid,
  parseWorktreeList,
  planPrune,
  runPrune,
  samePath,
  type PruneFs,
  type PruneGit,
} from "./worktree-prune"

/**
 * Contract for the worktree pruner.
 *
 * Agent worktrees cannot clean themselves up: a worktree-isolated agent is
 * blocked from running git against the main checkout, and removing a worktree
 * has to be done from outside it. So the dispatcher removes them, and until
 * now it did so from prose instructions - which is why 38 orphaned
 * directories accumulated under `.claude/worktrees/` over three weeks. This
 * module is that cleanup as code.
 *
 * Two failure modes are what the safety rules below are made of:
 * - Removing a worktree that still holds work destroys it. Uncommitted files,
 *   unpushed commits and git's own lock (Claude Code locks a running agent's
 *   worktree) each mean hands off.
 * - On Windows `git worktree remove` regularly deregisters the worktree and
 *   then loses the directory delete to an open file handle, leaving a husk
 *   git no longer knows about. Those husks are the orphans, and deleting one
 *   is only safe because git has already stopped tracking it.
 */
describe("parseWorktreeList", () => {
  it("reads paths, lock state and the main checkout out of git's porcelain output", () => {
    const output = [
      "worktree C:/repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree C:/repo/.claude/worktrees/agent-a",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/worktree-agent-a",
      "",
      "worktree C:/repo/.claude/worktrees/agent-b",
      "HEAD 3333333333333333333333333333333333333333",
      "detached",
      "locked an agent is running here",
      "",
    ].join("\n")

    const entries = parseWorktreeList(output)

    expect(entries).toEqual([
      { path: "C:/repo", locked: false, lockReason: null, main: true },
      { path: "C:/repo/.claude/worktrees/agent-a", locked: false, lockReason: null, main: false },
      {
        path: "C:/repo/.claude/worktrees/agent-b",
        locked: true,
        lockReason: "an agent is running here",
        main: false,
      },
    ])
  })

  it("treats a bare `locked` line with no reason as locked", () => {
    const output = [
      "worktree C:/repo",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree C:/repo/.claude/worktrees/agent-a",
      "HEAD 2222222222222222222222222222222222222222",
      "locked",
      "",
    ].join("\n")

    expect(parseWorktreeList(output)[1]).toEqual({
      path: "C:/repo/.claude/worktrees/agent-a",
      locked: true,
      lockReason: null,
      main: false,
    })
  })
})

/**
 * Claude Code stamps the locking agent's process id into the lock reason
 * (`claude agent agent-a0eb2ea1 (pid 39868)`). That pid is the only evidence
 * available for whether the lock still belongs to anybody: a session that
 * dies - crash, reboot, a killed terminal - never releases its lock, and the
 * worktree then holds its task branch checked out forever. Git refuses to
 * check out one branch in two places, so the owner opening that PR locally
 * gets a bare "failed to execute git" on a branch no process is using.
 */
describe("lockOwnerPid", () => {
  it("reads the pid Claude Code stamps into an agent lock reason", () => {
    expect(lockOwnerPid("claude agent agent-a0eb2ea13dd686b79 (pid 39868)")).toBe(39868)
  })

  it("returns null for a lock reason that names no pid", () => {
    expect(lockOwnerPid("held for review")).toBeNull()
    expect(lockOwnerPid(null)).toBeNull()
  })
})

describe("path comparison", () => {
  // git reports forward slashes even on Windows, while anything built from
  // `path.join` arrives with backslashes. Comparing them raw makes every
  // registered worktree look like an orphan, which would delete live work.
  it("treats the same path as equal across separator style and case", () => {
    expect(samePath("C:/Repo/.claude/worktrees/a", "C:\\repo\\.claude\\worktrees\\A")).toBe(true)
  })

  it("does not equate different paths", () => {
    expect(samePath("C:/repo/.claude/worktrees/a", "C:/repo/.claude/worktrees/ab")).toBe(false)
  })

  it("recognises containment without matching a sibling that merely shares a prefix", () => {
    expect(isInside("C:/repo/.claude/worktrees/a", "C:\\repo\\.claude\\worktrees")).toBe(true)
    expect(isInside("C:/repo/.claude/worktrees-old/a", "C:/repo/.claude/worktrees")).toBe(false)
    expect(isInside("C:/repo/.claude/worktrees", "C:/repo/.claude/worktrees")).toBe(false)
  })
})

describe("findOrphanDirectories", () => {
  const registered = ["C:/repo/.claude/worktrees/agent-a"]

  it("returns directories git no longer tracks", () => {
    const orphans = findOrphanDirectories(
      ["C:\\repo\\.claude\\worktrees\\agent-a", "C:\\repo\\.claude\\worktrees\\agent-dead"],
      registered,
    )

    expect(orphans).toEqual(["C:\\repo\\.claude\\worktrees\\agent-dead"])
  })

  it("never reports a registered directory, whatever the separators", () => {
    expect(findOrphanDirectories(["C:\\repo\\.claude\\worktrees\\agent-a"], registered)).toEqual([])
  })
})

describe("planPrune", () => {
  const MANAGED = "C:/repo/.claude/worktrees"
  const clean = { uncommitted: false, unpushed: false }

  /**
   * Builds a plan over one managed worktree with the given state. The main
   * checkout is always present because git always lists it, and is filtered
   * out of `keeps` here so each test reads as being about its own worktree;
   * that the main checkout is kept is asserted on its own below.
   */
  function planFor(
    entry: Parameters<typeof planPrune>[0]["entries"][number],
    work = clean,
    isProcessAlive: (pid: number) => boolean = () => true,
  ) {
    const plan = planPrune({
      entries: [{ path: "C:/repo", locked: false, lockReason: null, main: true }, entry],
      managedRoot: MANAGED,
      workFor: () => work,
      directories: [],
      isProcessAlive,
    })
    return { ...plan, keeps: plan.keeps.filter((keep) => keep.reason !== "main-checkout") }
  }

  const agent = { path: "C:/repo/.claude/worktrees/agent-a", locked: false, lockReason: null, main: false }
  const liveLock = { ...agent, locked: true, lockReason: "claude agent agent-a (pid 4242)" }

  it("removes a managed worktree that is clean, unlocked and fully pushed", () => {
    const plan = planFor(agent)

    expect(plan.removals).toEqual(["C:/repo/.claude/worktrees/agent-a"])
    expect(plan.keeps).toEqual([])
  })

  it("never removes the main checkout", () => {
    const plan = planPrune({
      entries: [{ path: "C:/repo", locked: false, lockReason: null, main: true }],
      managedRoot: MANAGED,
      workFor: () => clean,
      directories: [],
      isProcessAlive: () => true,
    })

    expect(plan.removals).toEqual([])
    expect(plan.keeps).toEqual([{ path: "C:/repo", reason: "main-checkout" }])
  })

  it("keeps a locked worktree whose agent process is still running", () => {
    const plan = planFor(liveLock, clean, (pid) => pid === 4242)

    expect(plan.removals).toEqual([])
    expect(plan.keeps).toEqual([{ path: agent.path, reason: "locked" }])
    expect(plan.staleLocks).toEqual([])
  })

  it("keeps a lock whose reason names no pid, because nothing says the holder is gone", () => {
    const plan = planFor({ ...agent, locked: true, lockReason: "held for review" }, clean, () => false)

    expect(plan.removals).toEqual([])
    expect(plan.keeps).toEqual([{ path: agent.path, reason: "locked" }])
  })

  it("reclaims a lock whose agent process is gone, so its branch stops being un-checkoutable", () => {
    const plan = planFor(liveLock, clean, () => false)

    expect(plan.removals).toEqual([agent.path])
    expect(plan.staleLocks).toEqual([agent.path])
  })

  it("still keeps a stale-locked worktree that holds work, because the lock is not what protects it", () => {
    const uncommitted = planFor(liveLock, { uncommitted: true, unpushed: false }, () => false)
    expect(uncommitted.removals).toEqual([])
    expect(uncommitted.keeps).toEqual([{ path: agent.path, reason: "uncommitted-changes" }])

    const unpushed = planFor(liveLock, { uncommitted: false, unpushed: true }, () => false)
    expect(unpushed.removals).toEqual([])
    expect(unpushed.keeps).toEqual([{ path: agent.path, reason: "unpushed-commits" }])
  })

  it("keeps a worktree holding uncommitted changes", () => {
    const plan = planFor(agent, { uncommitted: true, unpushed: false })

    expect(plan.removals).toEqual([])
    expect(plan.keeps).toEqual([{ path: agent.path, reason: "uncommitted-changes" }])
  })

  it("keeps a worktree holding unpushed commits", () => {
    const plan = planFor(agent, { uncommitted: false, unpushed: true })

    expect(plan.removals).toEqual([])
    expect(plan.keeps).toEqual([{ path: agent.path, reason: "unpushed-commits" }])
  })

  it("keeps a worktree the user made outside the managed root", () => {
    const plan = planFor({ path: "C:/elsewhere/review-checkout", locked: false, lockReason: null, main: false })

    expect(plan.removals).toEqual([])
    expect(plan.keeps).toEqual([
      { path: "C:/elsewhere/review-checkout", reason: "outside-managed-root" },
    ])
  })

  it("reports husks on disk that git has already forgotten", () => {
    const plan = planPrune({
      entries: [{ path: "C:/repo", locked: false, lockReason: null, main: true }, agent],
      managedRoot: MANAGED,
      workFor: () => clean,
      directories: ["C:\\repo\\.claude\\worktrees\\agent-a", "C:\\repo\\.claude\\worktrees\\husk"],
      isProcessAlive: () => true,
    })

    expect(plan.orphans).toEqual(["C:\\repo\\.claude\\worktrees\\husk"])
  })

  it("does not count a worktree it is about to remove as an orphan as well", () => {
    // The directory is still on disk at planning time; removing it via git and
    // then deleting it again as an orphan would be a double free.
    const plan = planPrune({
      entries: [{ path: "C:/repo", locked: false, lockReason: null, main: true }, agent],
      managedRoot: MANAGED,
      workFor: () => clean,
      directories: ["C:\\repo\\.claude\\worktrees\\agent-a"],
      isProcessAlive: () => true,
    })

    expect(plan.removals).toEqual([agent.path])
    expect(plan.orphans).toEqual([])
  })

  it("refuses to plan at all when git listed no worktrees", () => {
    // git always lists the main checkout. An empty list means the command
    // failed or its output was not understood, and treating that as "nothing
    // is registered" would classify every live worktree as an orphan.
    expect(() => planPrune({
      entries: [],
      managedRoot: MANAGED,
      workFor: () => clean,
      directories: ["C:\\repo\\.claude\\worktrees\\agent-a"],
      isProcessAlive: () => true,
    })).toThrow(/no worktrees/i)
  })

  it("refuses to plan when git listed no main checkout", () => {
    expect(() => planPrune({
      entries: [agent],
      managedRoot: MANAGED,
      workFor: () => clean,
      directories: [],
      isProcessAlive: () => true,
    })).toThrow(/main/i)
  })
})

describe("runPrune", () => {
  const MANAGED = "C:/repo/.claude/worktrees"
  /** Swallows the run's progress output; these tests assert on its result. */
  const silent = (): void => undefined

  /**
   * A git/filesystem stand-in. `registered` is what git reports; a removal
   * mutates it the way the real command would, and `failDelete` reproduces
   * Windows losing the directory delete while the deregistration succeeded.
   */
  function createWorld({ registered, directories, failDelete = [], work = {} }: {
    registered: string[]
    directories: string[]
    failDelete?: string[]
    work?: Record<string, { uncommitted: boolean, unpushed: boolean }>
  }) {
    const live = [...registered]
    const disk = [...directories]
    const git: PruneGit = {
      listWorktrees: () => ["worktree C:/repo", "HEAD 1".padEnd(45, "1"), "branch refs/heads/main", "", ...live.flatMap((p) => [`worktree ${p}`, "HEAD 2".padEnd(45, "2"), "detached", ""])].join("\n"),
      pruneRegistry: vi.fn(),
      workFor: (path) => work[path] ?? { uncommitted: false, unpushed: false },
      isProcessAlive: () => true,
      removeWorktree: vi.fn((path: string) => {
        const at = live.findIndex((p) => samePath(p, path))
        if (at >= 0) live.splice(at, 1)
        if (failDelete.some((p) => samePath(p, path))) throw new Error("access denied")
        const onDisk = disk.findIndex((p) => samePath(p, path))
        if (onDisk >= 0) disk.splice(onDisk, 1)
      }),
    }
    const fs: PruneFs = {
      listDirectories: () => [...disk],
      removeDirectory: vi.fn((path: string) => {
        const at = disk.findIndex((p) => samePath(p, path))
        if (at >= 0) disk.splice(at, 1)
      }),
    }
    return { git, fs, disk: () => disk, live: () => live }
  }

  const A = "C:/repo/.claude/worktrees/agent-a"

  it("removes a clean worktree and leaves nothing on disk", () => {
    const world = createWorld({ registered: [A], directories: [A] })

    const result = runPrune({ repoRoot: "C:/repo", managedRoot: MANAGED, ...world, log: silent })

    expect(result.removed).toEqual([A])
    expect(result.failed).toEqual([])
    expect(world.disk()).toEqual([])
  })

  it("finishes the job when git deregisters the worktree but cannot delete its directory", () => {
    // The Windows case that produced every husk: the command throws, yet the
    // worktree is gone from the registry and the files remain.
    const world = createWorld({ registered: [A], directories: [A], failDelete: [A] })

    const result = runPrune({ repoRoot: "C:/repo", managedRoot: MANAGED, ...world, log: silent })

    expect(result.removed).toEqual([A])
    expect(result.deletedDirectories).toEqual([A])
    expect(world.disk()).toEqual([])
  })

  it("deletes a husk left by an earlier run, with no worktree to remove", () => {
    const husk = "C:/repo/.claude/worktrees/agent-dead"
    const world = createWorld({ registered: [], directories: [husk] })

    const result = runPrune({ repoRoot: "C:/repo", managedRoot: MANAGED, ...world, log: silent })

    expect(result.removed).toEqual([])
    expect(result.deletedDirectories).toEqual([husk])
  })

  it("reports a worktree git still lists afterwards as failed rather than deleting its files", () => {
    const world = createWorld({ registered: [A], directories: [A] })
    world.git.removeWorktree = vi.fn(() => { throw new Error("locked by another process") })

    const result = runPrune({ repoRoot: "C:/repo", managedRoot: MANAGED, ...world, log: silent })

    expect(result.failed).toEqual([A])
    expect(result.removed).toEqual([])
    expect(result.deletedDirectories).toEqual([])
    expect(world.disk()).toEqual([A])
  })

  it("touches nothing on a dry run", () => {
    const world = createWorld({ registered: [A], directories: [A] })
    const lines: string[] = []

    const result = runPrune({ repoRoot: "C:/repo", managedRoot: MANAGED, ...world, log: (l) => lines.push(l), dryRun: true })

    expect(world.git.removeWorktree).not.toHaveBeenCalled()
    expect(world.git.pruneRegistry).not.toHaveBeenCalled()
    expect(world.fs.removeDirectory).not.toHaveBeenCalled()
    expect(result.removed).toEqual([])
    expect(world.disk()).toEqual([A])
    expect(lines.some((l) => l.includes("would remove worktree"))).toBe(true)
  })

  it("leaves a worktree that still holds work, and its directory with it", () => {
    const world = createWorld({
      registered: [A],
      directories: [A],
      work: { [A]: { uncommitted: false, unpushed: true } },
    })

    const result = runPrune({ repoRoot: "C:/repo", managedRoot: MANAGED, ...world, log: silent })

    expect(world.git.removeWorktree).not.toHaveBeenCalled()
    expect(result.kept).toContainEqual({ path: A, reason: "unpushed-commits" })
    expect(world.disk()).toEqual([A])
  })
})
