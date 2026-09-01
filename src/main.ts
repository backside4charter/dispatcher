/**
 * The unified `dispatcher` entrypoint - the one binary that carries every
 * command in this package. `bun build --compile` points here to produce the
 * redistributable executable, and the dev recipes run this same file under
 * tsx, so the compiled binary and `just` dispatch identically by construction.
 *
 * Commands:
 * - `board <subcommand>` - the task board CLI (board-cli.ts)
 * - `listen` / `status` / `wait` / `consume` - the event channel (cli.ts)
 * - `prune-worktrees` - remove finished agent worktrees (worktree-prune-cli.ts)
 * - `review-sync` - the review-to-board sync (review-status-sync-cli.ts)
 * - `version` / `help`
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runBoardCliFromProcess } from "./board-cli"
import type { CliIo } from "./cli"
import { runCliFromProcess } from "./cli"
import { runCommitCli } from "./github/commit"
import { runPrCli } from "./github/pr"
import { runIdentityFromProcess, runTokenFromProcess } from "./github/token"
import { runReviewStatusSyncFromProcess } from "./review-status-sync-cli"
import { runWorktreePruneCli } from "./worktree-prune-cli"

/**
 * The version stamped into a compiled binary via `--define` (see
 * scripts/compile.ts); running from source reports "dev".
 */
const VERSION = process.env.DISPATCHER_VERSION ?? "dev"

/** One handler per command group, injectable so tests can verify routing. */
export interface MainHandlers {
  /** The board CLI; receives everything after `board`. */
  board: (argv: string[]) => Promise<number>
  /** The event-channel CLI; receives the command name plus its options. */
  events: (argv: string[]) => Promise<number>
  /** The worktree pruner; receives its flags. */
  pruneWorktrees: (argv: string[]) => Promise<number>
  /** The review-to-board sync; reads its input from the environment. */
  reviewSync: () => Promise<number>
  /** Mint an agent app installation token. */
  token: (argv: string[]) => Promise<number>
  /** Print an agent app installation's permissions and bot identity. */
  identity: (argv: string[]) => Promise<number>
  /** Open a pull request as the developer app. */
  pr: (argv: string[]) => Promise<number>
  /** Commit staged changes as the developer bot. */
  commit: (argv: string[]) => Promise<number>
}

const USAGE_LINES = [
  "usage: dispatcher <command> [options]",
  "",
  "commands:",
  "  board <subcommand>        read and write the task board (`dispatcher board` lists them)",
  "  listen                    start the event-channel listener (long-running)",
  "  status                    report whether the event channel is up (exit 0) or down (exit 1)",
  "  wait                      block until new board events arrive, then exit",
  "  consume                   print pending events and advance the consumed cursor",
  "  prune-worktrees [--dry-run]",
  "                            remove finished agent worktrees and failed-removal husks",
  "  review-sync               roll a change-requested task back to Changes Requested",
  "                            (reads the pull_request_review payload named by GITHUB_EVENT_PATH)",
  "  token [--app <role>]      mint a short-lived agent app installation token (default: developer)",
  "  identity [--app <role>]   print an agent app installation's permissions and bot identity",
  "  pr --title <t> [--body-file <p> | --body <t>] [--base <b>] [--head <b>] [--repo <o/n>] [--draft]",
  "                            open a pull request authored by the developer app",
  "  commit (-m <msg> | -F <file>)",
  "                            commit staged changes as the developer bot",
  "  version                   print the version",
]

/** io that writes to the real stdout/stderr. */
const processIo: CliIo = {
  out: (line) => { console.log(line) },
  err: (line) => { console.error(line) },
}

/** The real command implementations. */
const PRODUCTION_HANDLERS: MainHandlers = {
  board: (argv) => runBoardCliFromProcess(argv),
  events: (argv) => runCliFromProcess(argv),
  pruneWorktrees: (argv) => Promise.resolve(runWorktreePruneCli(argv)),
  reviewSync: () => runReviewStatusSyncFromProcess(),
  token: (argv) => runTokenFromProcess(argv),
  identity: (argv) => runIdentityFromProcess(argv),
  pr: (argv) => runPrCli(argv, processIo),
  commit: (argv) => Promise.resolve(runCommitCli(argv, processIo)),
}

/**
 * Dispatches one invocation to its command group and returns the process exit
 * code. Unknown input prints the usage and exits 2; each group handles its own
 * errors beyond that.
 */
export async function runMain(
  argv: string[],
  io: CliIo,
  handlers: MainHandlers = PRODUCTION_HANDLERS,
): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case "board":
      return handlers.board(rest)
    case "listen":
    case "status":
    case "wait":
    case "consume":
      return handlers.events([command, ...rest])
    case "prune-worktrees":
      return handlers.pruneWorktrees(rest)
    case "review-sync":
      return handlers.reviewSync()
    case "token":
      return handlers.token(rest)
    case "identity":
      return handlers.identity(rest)
    case "pr":
      return handlers.pr(rest)
    case "commit":
      return handlers.commit(rest)
    case "version":
    case "--version":
    case "-v":
      io.out(`dispatcher ${VERSION}`)
      return 0
    case "help":
    case "--help":
    case "-h":
      for (const line of USAGE_LINES) io.out(line)
      return 0
    case undefined:
      for (const line of USAGE_LINES) io.err(line)
      return 2
    default:
      io.err(`unknown command: ${command}`)
      for (const line of USAGE_LINES) io.err(line)
      return 2
  }
}

const executedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (executedDirectly) {
  runMain(process.argv.slice(2), processIo)
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 2
    })
}
