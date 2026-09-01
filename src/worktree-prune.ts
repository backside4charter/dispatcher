/**
 * Cleanup for the agent worktrees under `.claude/worktrees/`.
 *
 * Why this is a script and not an instruction: **an agent cannot clean up
 * after itself.** A worktree-isolated agent is blocked from running git
 * against the main checkout, and removing a worktree has to be done from
 * outside the worktree being removed - so the removal always falls to
 * whoever is left, which is the dispatcher. Until now that was prose in the
 * dispatch skills ("worth deleting in the background"), and prose at the end
 * of a long loop is not a guarantee: 38 orphaned directories accumulated
 * under `.claude/worktrees/` over three weeks.
 *
 * Two things it has to get right:
 *
 * - **Never destroy work.** Removing a worktree deletes its files. A worktree
 *   is only removable when git holds no lock on it (Claude Code locks a
 *   running agent's worktree, so a lock means someone is still in there),
 *   it has nothing uncommitted or untracked, and nothing unpushed.
 * - **Sweep the husks git already forgot.** On Windows `git worktree remove`
 *   routinely deregisters the worktree and then loses the directory delete to
 *   an open file handle. What is left is a directory git no longer tracks -
 *   an orphan. Deleting one is safe precisely because git has stopped
 *   tracking it, and it has to be done separately because `git worktree
 *   prune` only cleans up git's own bookkeeping, never the files.
 *
 * The decision logic is pure and the git/filesystem access is injected, so
 * the safety rules above are tested rather than trusted.
 */

/** One worktree as `git worktree list --porcelain` reports it. */
export interface WorktreeEntry {
  /** Path git records for the worktree, always with forward slashes. */
  path: string
  /** Whether git holds a lock on it; Claude Code locks a running agent's. */
  locked: boolean
  /** The reason git records for the lock, or null when it recorded none. */
  lockReason: string | null
  /** True for the repository's main working tree, which git lists first. */
  main: boolean
}

/** What a worktree still holds that removing it would destroy. */
export interface WorktreeWork {
  /** Any uncommitted or untracked file. */
  uncommitted: boolean
  /** Any commit not yet on its upstream branch. */
  unpushed: boolean
}

/** Why a worktree was left alone. */
export type KeepReason =
  | "main-checkout"
  | "outside-managed-root"
  | "locked"
  | "uncommitted-changes"
  | "unpushed-commits"

/** A worktree the plan deliberately does not touch. */
export interface KeptWorktree {
  path: string
  reason: KeepReason
}

/** What a prune run should do. */
export interface PrunePlan {
  /** Registered worktrees to hand to `git worktree remove`. */
  removals: string[]
  /** Registered worktrees left alone, with the reason each survived. */
  keeps: KeptWorktree[]
  /** Directories git no longer tracks, to delete outright. */
  orphans: string[]
  /**
   * Worktrees whose lock was ignored because the agent holding it is gone.
   * Reported so a reclaim is visible rather than silent; each still had to
   * pass the uncommitted and unpushed checks to reach `removals`.
   */
  staleLocks: string[]
}

/** Inputs a plan is derived from; all git and filesystem access is the caller's. */
export interface PruneInput {
  /** Everything `git worktree list --porcelain` reported. */
  entries: WorktreeEntry[]
  /** The directory agent worktrees live under, normally `.claude/worktrees`. */
  managedRoot: string
  /** Reads what a worktree still holds. Only called for removal candidates. */
  workFor: (path: string) => WorktreeWork
  /** Directories currently on disk under `managedRoot`. */
  directories: string[]
  /**
   * Whether a process id is still running. Only consulted for a locked
   * worktree whose lock reason names a pid, to tell a live agent's lock from
   * one a dead session left behind.
   */
  isProcessAlive: (pid: number) => boolean
}

/**
 * Normalizes a path for comparison: git prints forward slashes even on
 * Windows while anything built from `path.join` arrives with backslashes, and
 * Windows paths are case-insensitive. Comparing raw would make every
 * registered worktree look unregistered, which is the one mistake that
 * deletes live work.
 */
function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

/** Whether two paths refer to the same location. */
export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

/**
 * Whether `child` sits under `parent`. The trailing separator matters: without
 * it `worktrees-old` would read as being inside `worktrees`.
 */
export function isInside(child: string, parent: string): boolean {
  return normalize(child).startsWith(`${normalize(parent)}/`)
}

/**
 * Reads `git worktree list --porcelain`. Records are separated by a blank
 * line, each opening with a `worktree <path>` line; `locked` may appear alone
 * or with a reason. The first record is always the main working tree.
 */
export function parseWorktreeList(output: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      entries.push({
        path: line.slice("worktree ".length).trim(),
        locked: false,
        lockReason: null,
        main: entries.length === 0,
      })
      continue
    }
    const current = entries.at(-1)
    if (current != null && (line === "locked" || line.startsWith("locked "))) {
      current.locked = true
      const reason = line.slice("locked".length).trim()
      current.lockReason = reason.length > 0 ? reason : null
    }
  }
  return entries
}

/**
 * The process id Claude Code stamps into an agent worktree's lock reason
 * (`claude agent agent-a0eb2ea13dd686b79 (pid 39868)`), or null when the
 * reason names none.
 *
 * This pid is the only evidence available for whether a lock still belongs to
 * anybody. Git never releases a lock on its own, so a session that dies -
 * crash, reboot, a closed terminal - leaves its worktree locked forever with
 * the task branch checked out. Git refuses to check out one branch in two
 * places, so that PR then cannot be checked out by anyone, and the owner sees
 * only a bare "failed to execute git".
 */
export function lockOwnerPid(reason: string | null): number | null {
  const match = reason?.match(/\(pid (\d+)\)/)
  return match?.[1] != null ? Number(match[1]) : null
}

/**
 * Directories under the managed root that git no longer tracks - the husks a
 * failed `git worktree remove` leaves behind.
 */
export function findOrphanDirectories(directories: string[], registered: string[]): string[] {
  return directories.filter((directory) => !registered.some((entry) => samePath(entry, directory)))
}

/**
 * Decides what to do with every worktree and directory, without touching any
 * of them.
 *
 * Throws rather than returning an empty plan when git's output makes no sense:
 * git always lists the main working tree, so a list without one means the
 * command failed or was misparsed, and treating that as "nothing is
 * registered" would class every live worktree as an orphan and delete it.
 */
export function planPrune({
  entries,
  managedRoot,
  workFor,
  directories,
  isProcessAlive,
}: PruneInput): PrunePlan {
  if (entries.length === 0) {
    throw new Error("git reported no worktrees; refusing to plan a prune from an empty list")
  }
  if (!entries.some((entry) => entry.main)) {
    throw new Error("git reported no main working tree; refusing to plan a prune")
  }

  const removals: string[] = []
  const keeps: KeptWorktree[] = []
  const staleLocks: string[] = []

  for (const entry of entries) {
    if (entry.main) {
      keeps.push({ path: entry.path, reason: "main-checkout" })
      continue
    }
    if (!isInside(entry.path, managedRoot)) {
      keeps.push({ path: entry.path, reason: "outside-managed-root" })
      continue
    }
    if (entry.locked) {
      // A lock only means "someone is still in there" while the agent that
      // took it is running. When the reason names a pid and that process is
      // gone, the lock is a dead session's leftover and holds the branch
      // hostage - so it is reclaimed. A reason naming no pid says nothing
      // about its holder, so it is left alone. Reclaiming only skips the
      // lock: the uncommitted and unpushed checks below still run, and they
      // are what actually protects work.
      const pid = lockOwnerPid(entry.lockReason)
      if (pid == null || isProcessAlive(pid)) {
        keeps.push({ path: entry.path, reason: "locked" })
        continue
      }
      staleLocks.push(entry.path)
    }
    const work = workFor(entry.path)
    if (work.uncommitted) {
      keeps.push({ path: entry.path, reason: "uncommitted-changes" })
      continue
    }
    if (work.unpushed) {
      keeps.push({ path: entry.path, reason: "unpushed-commits" })
      continue
    }
    removals.push(entry.path)
  }

  // Orphans are measured against every registered worktree, including the
  // ones queued for removal: those directories still exist at planning time,
  // and deleting them here as well would be a second delete of the same path.
  return {
    removals,
    keeps,
    orphans: findOrphanDirectories(directories, entries.map((entry) => entry.path)),
    staleLocks,
  }
}

/** The git commands a prune run needs, injected so the run is testable. */
export interface PruneGit {
  /** Raw stdout of `git worktree list --porcelain`. */
  listWorktrees: () => string
  /** Drops registry entries whose directories are already gone. */
  pruneRegistry: () => void
  /** Reads what a worktree still holds. */
  workFor: (path: string) => WorktreeWork
  /** Unlocks then removes a worktree. May throw; callers re-list to confirm. */
  removeWorktree: (path: string) => void
  /** Whether a process id is still running. */
  isProcessAlive: (pid: number) => boolean
}

/** The filesystem access a prune run needs. */
export interface PruneFs {
  /** Absolute paths of the directories directly under the managed root. */
  listDirectories: (root: string) => string[]
  /** Deletes a directory tree. */
  removeDirectory: (path: string) => void
}

/** One line of human-readable output. */
export type PruneLogger = (line: string) => void

/** What a run actually did. */
export interface PruneResult {
  /** Worktrees git no longer tracks after the run. */
  removed: string[]
  /** Worktrees deliberately left alone, with the reason for each. */
  kept: KeptWorktree[]
  /** Directories deleted from disk. */
  deletedDirectories: string[]
  /** Removals git still reports as registered afterwards. */
  failed: string[]
}

/**
 * Removes every agent worktree that holds nothing, then deletes the husks
 * left under the managed root.
 *
 * The order matters and so does the re-listing. On Windows `git worktree
 * remove` regularly deregisters a worktree and then fails to delete its
 * directory, reporting failure for something that half-succeeded - so the run
 * never trusts that command's exit status. It re-lists afterwards and asks
 * git what is actually registered now, which is also what turns those
 * half-removals into orphans this same run then deletes.
 */
export function runPrune({ repoRoot, managedRoot, git, fs, log, dryRun = false }: {
  repoRoot: string
  managedRoot: string
  git: PruneGit
  fs: PruneFs
  log: PruneLogger
  dryRun?: boolean
}): PruneResult {
  if (!dryRun) git.pruneRegistry()

  const plan = planPrune({
    entries: parseWorktreeList(git.listWorktrees()),
    managedRoot,
    workFor: git.workFor,
    directories: fs.listDirectories(managedRoot),
    isProcessAlive: git.isProcessAlive,
  })

  for (const keep of plan.keeps) {
    if (keep.reason === "main-checkout") continue
    log(`keep    ${keep.path}  (${keep.reason})`)
  }

  // Say so out loud: overriding a lock is the one thing here that looks
  // dangerous, and it should never happen silently.
  for (const path of plan.staleLocks) {
    log(`reclaim ${path}  (stale lock; the agent that took it is no longer running)`)
  }

  if (dryRun) {
    for (const path of plan.removals) log(`would remove worktree  ${path}`)
    for (const path of plan.orphans) log(`would delete directory ${path}`)
    log(`dry run: ${plan.removals.length} worktree(s), ${plan.orphans.length} orphaned director(ies), repo ${repoRoot}`)
    return { removed: [], kept: plan.keeps, deletedDirectories: [], failed: [] }
  }

  for (const path of plan.removals) {
    try {
      git.removeWorktree(path)
    } catch {
      // Deliberately swallowed: the re-list below is the source of truth for
      // whether this worked, because the command lies on Windows.
    }
  }

  // Ask git what survived rather than believing the exit codes above.
  const stillRegistered = parseWorktreeList(git.listWorktrees()).map((entry) => entry.path)
  const removed = plan.removals.filter((path) => !stillRegistered.some((entry) => samePath(entry, path)))
  const failed = plan.removals.filter((path) => stillRegistered.some((entry) => samePath(entry, path)))
  for (const path of removed) log(`removed ${path}`)
  for (const path of failed) log(`FAILED  ${path}  (still registered; left alone)`)

  // Re-read the disk too: a removal that deregistered but could not delete
  // has just become an orphan, and this run should finish the job.
  const deletedDirectories: string[] = []
  for (const path of findOrphanDirectories(fs.listDirectories(managedRoot), stillRegistered)) {
    try {
      fs.removeDirectory(path)
      deletedDirectories.push(path)
      log(`deleted ${path}`)
    } catch (error) {
      log(`FAILED  ${path}  (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  log(`pruned ${removed.length} worktree(s), deleted ${deletedDirectories.length} orphaned director(ies)`)
  return { removed, kept: plan.keeps, deletedDirectories, failed }
}
