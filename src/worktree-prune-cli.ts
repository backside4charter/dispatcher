/**
 * CLI for the worktree pruner: `just prune-worktrees [--dry-run]`.
 *
 * Everything decision-shaped lives in worktree-prune.ts and is unit-tested;
 * this file is the thin layer that talks to real git and the real filesystem.
 */
import { execFileSync } from "node:child_process"
import { readdirSync, rmSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { runPrune, type PruneFs, type PruneGit } from "./worktree-prune"

/** Runs git in `cwd` and returns stdout, throwing on a non-zero exit. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/**
 * The repository's main working tree. Run from anywhere inside the repo; the
 * prune has to happen from the main checkout, because git will not remove a
 * worktree from inside itself.
 */
function findRepoRoot(): string {
  const common = git(process.cwd(), ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim()
  return path.dirname(common)
}

/** Real git access. */
function createGit(repoRoot: string): PruneGit {
  return {
    listWorktrees: () => git(repoRoot, ["worktree", "list", "--porcelain"]),
    pruneRegistry: () => { git(repoRoot, ["worktree", "prune"]) },
    workFor: (worktree) => {
      // A worktree whose git metadata is already broken reads as holding
      // work, so it is kept rather than deleted on a guess.
      try {
        const uncommitted = git(worktree, ["status", "--porcelain"]).trim().length > 0
        let unpushed = false
        try {
          unpushed = git(worktree, ["log", "--oneline", "@{u}.."]).trim().length > 0
        } catch {
          // No upstream configured: any commit of its own is unpushed.
          unpushed = git(worktree, ["log", "--oneline", "-1", "HEAD", "--not", "--remotes"]).trim().length > 0
        }
        return { uncommitted, unpushed }
      } catch {
        return { uncommitted: true, unpushed: true }
      }
    },
    removeWorktree: (worktree) => {
      try {
        git(repoRoot, ["worktree", "unlock", worktree])
      } catch {
        // Not locked, which is the normal case for a finished agent.
      }
      git(repoRoot, ["worktree", "remove", worktree])
    },
    isProcessAlive: (pid) => {
      try {
        // Signal 0 performs the permission and existence checks without
        // delivering anything. EPERM means the process exists but belongs to
        // someone else, which still counts as alive.
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM"
      }
    },
  }
}

/** Real filesystem access. */
const fsPort: PruneFs = {
  listDirectories: (root) => {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name))
    } catch {
      return []
    }
  },
  removeDirectory: (target) => { rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) },
}

/**
 * Runs the prune against the real repository. Returns the exit code: non-zero
 * when a worktree git still lists could not be removed (one a human has to
 * look at; everything else either succeeded or was deliberately kept).
 * Execution belongs to main.ts alone - a module-level "am I the entrypoint"
 * guard here would misfire in the compiled binary, where bundling gives every
 * module the entry's `import.meta.url`.
 */
export function runWorktreePruneCli(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { "dry-run": { type: "boolean", default: false } } })
  const repoRoot = findRepoRoot()
  const managedRoot = path.join(repoRoot, ".claude", "worktrees")

  const result = runPrune({
    repoRoot,
    managedRoot,
    git: createGit(repoRoot),
    fs: fsPort,
    log: (line) => { process.stdout.write(`${line}\n`) },
    dryRun: values["dry-run"],
  })

  return result.failed.length > 0 ? 1 : 0
}
