/**
 * Open a pull request authored by the developer GitHub App.
 *
 * Always the developer app, never the reviewer one: the reviewer exists to be a
 * different identity from whoever wrote the code, so it must not author PRs.
 *
 * This is what makes agent work reviewable: GitHub refuses to let an account
 * approve its own pull request, so a PR opened with the owner's own auth is a
 * PR the owner can never approve. Creating it with an installation token makes
 * the app the author, leaving the human free to review.
 *
 * Talks to the REST API directly instead of shelling out to `gh pr create`,
 * because `gh` resolves the current user via `GET /user`, which does not exist
 * for an installation token (bots are not users) - so parts of `gh` fail or
 * behave oddly under GH_TOKEN=<installation token>.
 *
 * Pushing the branch stays on the normal SSH `origin` remote: who pushed has no
 * bearing on commit attribution (that follows the author email) or on PR
 * authorship (that follows the creating token).
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { loadDispatcherConfig } from "../board/config"
import { botGitEmail, getAgentApp } from "./apps"
import type { AgentApp } from "./apps"
import { githubHeaders, mintInstallationToken } from "./token"
import type { GithubCliIo } from "./token"

/** Flags parsed off the command line: a value, or `true` for a bare flag. */
export type ParsedArgs = ReadonlyMap<string, string | true>

/**
 * Parse `--flag value` / `--flag` pairs out of argv into a lookup.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined || !arg.startsWith("--")) continue
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      args.set(name, true)
    } else {
      args.set(name, next)
      i += 1
    }
  }
  return args
}

/**
 * Read a flag's value, treating a bare flag as absent.
 */
export function stringArg(args: ParsedArgs, name: string): string | undefined {
  const value = args.get(name)
  return typeof value === "string" ? value : undefined
}

/**
 * Whether a bare flag (one with no value after it) was passed.
 */
export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.get(name) === true
}

/**
 * Run a git command in the current repository and return its trimmed stdout.
 */
function git(...gitArgs: string[]): string {
  return execFileSync("git", gitArgs, { encoding: "utf8" }).trim()
}

/**
 * Derive `owner/name` from a git remote URL.
 *
 * Handles SSH, HTTPS, and host-alias forms (`git@github.com-someuser:owner/repo.git`).
 */
export function parseOwnerRepo(url: string): { owner: string; repo: string } {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  const owner = match?.[1]
  const repo = match?.[2]
  if (owner === undefined || repo === undefined) {
    throw new Error(`Could not parse owner/repo from origin URL: ${url}`)
  }
  return { owner, repo }
}

/**
 * Read an explicit `--repo owner/name` argument.
 */
export function parseRepoArg(value: string): { owner: string; repo: string } {
  const parts = value.split("/")
  const owner = parts[0]
  const repo = parts[1]
  if (parts.length !== 2 || owner === undefined || owner === "" || repo === undefined || repo === "") {
    throw new Error(`--repo must be <owner>/<name>, got: ${value}`)
  }
  return { owner, repo }
}

/**
 * Derive `owner/name` from the origin remote URL.
 */
function repoFromOrigin(): { owner: string; repo: string } {
  return parseOwnerRepo(git("remote", "get-url", "origin"))
}

/**
 * Whether a decoded JSON value is a plain object we can read named fields from.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Read a field off a decoded JSON object when it is a string.
 */
function stringField(value: Record<string, unknown>, name: string): string | undefined {
  const field = value[name]
  return typeof field === "string" ? field : undefined
}

/**
 * Read a field off a decoded JSON object when it is a number.
 */
function numberField(value: Record<string, unknown>, name: string): number | undefined {
  const field = value[name]
  return typeof field === "number" ? field : undefined
}

/** The parts of a created pull request this command reports on. */
export interface PullRequestSummary {
  /** Browser URL of the new pull request. */
  readonly htmlUrl: string
  /** API URL listing the pull request's commits. */
  readonly commitsUrl: string
  /** Numeric id of the account GitHub recorded as the author. */
  readonly authorId: number | undefined
  /** Login of that account, for display only. */
  readonly authorLogin: string | undefined
  /** Whether that account is a `Bot` or a `User`. */
  readonly authorType: string | undefined
}

/**
 * Read the created pull request, or nothing if the payload is unrecognizable.
 *
 * The two URLs are required because everything downstream needs them; the
 * author fields are optional, since GitHub sends `user: null` for an account it
 * cannot resolve and that case is exactly what the warning below reports.
 */
export function parsePullRequest(value: unknown): PullRequestSummary | undefined {
  if (!isRecord(value)) return undefined
  const htmlUrl = stringField(value, "html_url")
  const commitsUrl = stringField(value, "commits_url")
  if (htmlUrl === undefined || commitsUrl === undefined) return undefined
  const user = value.user
  return {
    htmlUrl,
    commitsUrl,
    authorId: isRecord(user) ? numberField(user, "id") : undefined,
    authorLogin: isRecord(user) ? stringField(user, "login") : undefined,
    authorType: isRecord(user) ? stringField(user, "type") : undefined,
  }
}

/** One commit on the pull request, as far as attribution is concerned. */
export interface CommitSummary {
  /** The commit's sha. */
  readonly sha: string
  /** Numeric id of the GitHub account it was attributed to, if any. */
  readonly authorId: number | undefined
  /** Login of that account, for display only. */
  readonly authorLogin: string | undefined
  /** The author email recorded in the commit itself. */
  readonly authorEmail: string | undefined
}

/**
 * Read the pull request's commit list, or nothing if it is not a list.
 *
 * An unreadable list means attribution could not be checked, which the caller
 * reports rather than passing over in silence.
 */
export function parseCommitSummaries(value: unknown): CommitSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  const summaries: CommitSummary[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const sha = stringField(entry, "sha")
    if (sha === undefined) continue
    const githubAuthor = entry.author
    const commit = entry.commit
    const commitAuthor = isRecord(commit) ? commit.author : undefined
    summaries.push({
      sha,
      authorId: isRecord(githubAuthor) ? numberField(githubAuthor, "id") : undefined,
      authorLogin: isRecord(githubAuthor) ? stringField(githubAuthor, "login") : undefined,
      authorEmail: isRecord(commitAuthor) ? stringField(commitAuthor, "email") : undefined,
    })
  }
  return summaries
}

/**
 * The commits GitHub did not attribute to the bot account.
 *
 * Compare ids, not logins: GitHub matches a noreply address on the numeric id
 * prefix, and that id is also what survives an app rename (the bot account
 * keeps its original login, so the login is display only).
 */
export function findUnattributedCommits(
  commits: readonly CommitSummary[],
  botUserId: number,
): CommitSummary[] {
  return commits.filter((commit) => commit.authorId !== botUserId)
}

/**
 * Report whether the app opened the pull request, warning when it did not.
 */
export function formatOpenedByLine(pull: PullRequestSummary, app: AgentApp): string {
  const openedByApp = pull.authorId === app.botUserId
  return `opened by: ${pull.authorLogin} (${pull.authorType})`
    + `${openedByApp ? "" : ` - WARNING: expected ${app.botLogin}, so the owner cannot approve this PR`}`
}

/**
 * Report the commit attribution - the live guard on the agent commit identity.
 *
 * A commit whose author email does not match the bot comes back with
 * `author: null` - it renders as a plain name with no avatar and, more
 * importantly, means the commit identity has drifted.
 */
export function formatAttributionLines(commits: readonly CommitSummary[], app: AgentApp): string[] {
  const unattributed = findUnattributedCommits(commits, app.botUserId)
  if (unattributed.length === 0) {
    return [`all commits attributed to ${app.botLogin}`]
  }
  return [
    `WARNING: ${unattributed.length} commit(s) not attributed to ${app.botLogin}. `
      + `Commit with \`dispatcher commit\` so the author email is ${botGitEmail(app)}.`,
    ...unattributed.map((commit) => `  ${commit.sha.slice(0, 8)} author=${commit.authorLogin ?? "unattributed"} `
      + `email=${commit.authorEmail ?? "unknown"}`),
  ]
}

/** Either the pull request's commits, or why they could not be read. */
type CommitReadResult =
  | { readonly kind: "commits"; readonly commits: CommitSummary[] }
  | { readonly kind: "unavailable"; readonly reason: string }

/**
 * Fetch the pull request's commits, or say why they could not be read.
 *
 * Every failure comes back as a result rather than an exception: the pull
 * request already exists by this point, so throwing here would fail a command
 * that in fact succeeded and leave the caller unsure whether to retry.
 */
async function readCommits(commitsUrl: string, token: string): Promise<CommitReadResult> {
  try {
    const response = await fetch(commitsUrl, { headers: githubHeaders(token) })
    if (!response.ok) {
      return { kind: "unavailable", reason: `${commitsUrl} answered ${response.status} ${response.statusText}` }
    }
    const payload: unknown = await response.json()
    const commits = parseCommitSummaries(payload)
    if (commits === undefined) {
      return { kind: "unavailable", reason: `${commitsUrl} returned an unexpected payload` }
    }
    return { kind: "commits", commits }
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `${commitsUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Verify the two things that make this PR reviewable by the owner: the app
 * opened it, and GitHub actually attributed the commits to the bot.
 *
 * A failure to read the commit list is reported rather than skipped - a silent
 * skip would look exactly like a clean attribution check.
 */
async function reportAttribution(pull: PullRequestSummary, token: string, app: AgentApp, io: GithubCliIo): Promise<void> {
  io.out(formatOpenedByLine(pull, app))

  const result = await readCommits(pull.commitsUrl, token)
  if (result.kind === "unavailable") {
    io.out(`WARNING: commit attribution is unverified - ${result.reason}.`)
    return
  }

  for (const line of formatAttributionLines(result.commits, app)) {
    io.out(line)
  }
}

/**
 * `pr --title <text> [--body-file <path> | --body <text>] [--base <branch>]
 * [--head <branch>] [--repo <owner/name>] [--draft]`: open the pull request as
 * the developer app, then report its author and commit attribution.
 */
export async function runPrCli(argv: string[], io: GithubCliIo): Promise<number> {
  const args = parseArgs(argv)

  const title = stringArg(args, "title")
  if (title === undefined || title === "") {
    io.err("--title is required")
    return 1
  }

  const bodyFile = stringArg(args, "body-file")
  const body = bodyFile !== undefined && bodyFile !== ""
    ? readFileSync(bodyFile, "utf8")
    : stringArg(args, "body") ?? ""
  const head = stringArg(args, "head") || git("rev-parse", "--abbrev-ref", "HEAD")
  const base = stringArg(args, "base") || "main"
  const repoArg = stringArg(args, "repo")
  const { owner, repo } = repoArg !== undefined && repoArg !== "" ? parseRepoArg(repoArg) : repoFromOrigin()

  if (head === base) {
    io.err(`Refusing to open a PR from ${head} into itself - task work belongs on a task branch.`)
    return 1
  }

  const { config } = loadDispatcherConfig()
  const app = getAgentApp(config, "developer")
  const { token } = await mintInstallationToken(app)

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { ...githubHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ title, body, head, base, draft: hasFlag(args, "draft") }),
  })

  if (!response.ok) {
    io.err(`Creating the pull request failed: ${response.status} ${response.statusText}\n${await response.text()}`)
    return 1
  }

  const payload: unknown = await response.json()
  const pull = parsePullRequest(payload)
  if (pull === undefined) {
    io.err(`GitHub accepted the pull request but returned an unexpected payload, so its URL is `
      + `unknown - check the repository on GitHub before retrying.\n${JSON.stringify(payload)}`)
    return 1
  }

  io.out(pull.htmlUrl)
  await reportAttribution(pull, token, app, io)
  return 0
}
