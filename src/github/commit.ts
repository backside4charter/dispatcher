/**
 * Commit staged changes as the developer app's bot account.
 *
 * Commits are attributed by matching the author *email*, so this sets the
 * bot's `<user-id>+<login>@users.noreply.github.com` address via per-invocation
 * `-c` flags rather than changing any repo config - the owner's own commits
 * keep their real identity.
 */
import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"
import { loadDispatcherConfig } from "../board/config"
import { botGitEmail, getAgentApp } from "./apps"
import type { AgentApp } from "./apps"
import type { GithubCliIo } from "./token"

/** What to commit: an inline message or a message file, never both. */
export interface CommitInput {
  /** Inline commit message (`-m`). */
  message?: string
  /** Path to a file holding the message (`--file`), for multi-paragraph messages. */
  file?: string
}

/**
 * The exact git argv that commits staged changes as the bot, exported so the
 * identity flags are testable without running git.
 */
export function buildCommitGitArgs(app: AgentApp, input: CommitInput): string[] {
  const identity = ["-c", `user.name=${app.botLogin}`, "-c", `user.email=${botGitEmail(app)}`]
  if (input.message !== undefined && input.file === undefined) {
    return [...identity, "commit", "-m", input.message]
  }
  if (input.file !== undefined && input.message === undefined) {
    return [...identity, "commit", "-F", input.file]
  }
  throw new Error("pass exactly one of --message <text> or --file <path>")
}

/**
 * `commit (--message <text> | --file <path>)`: run `git commit` with the
 * developer bot's author identity. git's own output streams through, and its
 * exit code is returned.
 */
export function runCommitCli(argv: string[], io: GithubCliIo): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      message: { type: "string", short: "m" },
      file: { type: "string", short: "F" },
    },
    strict: true,
  })
  const { config } = loadDispatcherConfig()
  const app = getAgentApp(config, "developer")
  const gitArgs = buildCommitGitArgs(app, { message: values.message, file: values.file })
  try {
    execFileSync("git", gitArgs, { stdio: "inherit" })
    return 0
  } catch (error) {
    const status = error !== null && typeof error === "object" && "status" in error ? error.status : undefined
    io.err(`git commit failed${typeof status === "number" ? ` (exit ${status})` : ""}`)
    return typeof status === "number" && status !== 0 ? status : 1
  }
}
