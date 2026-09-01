import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { z } from "zod"
import { createBoardBackend } from "./board/backend"
import type { BoardDeps } from "./board/backend"
import { claimAgeMinutes, formatClaimText, isClaimRole, isClaimStale, resolveSessionId } from "./board/claims"
import { loadDispatcherConfig } from "./board/config"
import type { DispatcherConfig } from "./board/config"
import { ROW_TSV_HEADER, formatRowTsv, renderIssueMarkdown, sortRows } from "./board/format"
import { AGENT_ROLES, RETIRED_STATE_ROLE_ALIASES, STATE_ROLE_ALIASES } from "./board/types"
import type { AgentRole, BoardBackend, PullRequestRef, StateRole } from "./board/types"

/**
 * `just board <command>` - the dispatcher's window onto the task board.
 *
 * Every board read and write the dispatcher skills and worker agents make goes
 * through here, so the platform API lives in one tested place and a skill
 * invokes a one-line command instead of composing a query at a decision point
 * hours into a session. Which platform answers is `dispatcher.config.json`'s
 * business (`--platform` or `DISPATCHER_BOARD_PLATFORM` override it); the
 * commands and their output are the same on every platform. Output is
 * tab-separated (one row per line) or Markdown, made to be read by an agent.
 *
 * Issue references are the platform's: `ACM-12` on Linear, `#480` on GitHub.
 */

/** Output sinks, injectable for tests. */
export interface BoardCliIo {
  out: (line: string) => void
  err: (line: string) => void
}

/** Runtime dependencies, injectable for tests. */
export interface BoardCliDeps {
  /** Builds the backend for a config; the default resolves real credentials. */
  backend: (config: DispatcherConfig) => BoardBackend
  /** Loads the config; the default reads `dispatcher.config.json`. */
  loadConfig: (explicitPath: string | undefined, platformOverride: string | undefined) => { config: DispatcherConfig; path: string }
  env: Record<string, string | undefined>
  now: () => Date
  /** Runs `gh` with the given arguments and returns stdout. */
  gh: (args: string[]) => string
}

const USAGE_LINES = [
  "usage: dispatcher board [--config <path>] [--platform linear|github] <command> [options]",
  "",
  "reads:",
  "  config                       the resolved config: platform, project, state and label names",
  "  states                       the board's workflow states (name, role, id)",
  "  milestones                   milestones with their open-issue counts",
  "  poll <milestone>... [--all]  open issues in those milestones, board order, one TSV row each",
  "                               (--all-milestones for every milestone; --all to include closed issues)",
  "  issue <ref> [--comments <n>] [--json]",
  "                               one issue in full: header, sub-issues, blockers, description, comments",
  "  claims                       every claimed issue and every parked question, project-wide",
  "  pr-issues <pr-number|url>    the board issues a pull request belongs to",
  "",
  "writes:",
  "  state <ref> <state>          move an issue; <state> is a role (ready, in-progress, question,",
  "                               human-review, changes-requested, backlog) or the platform's name",
  "                               (refuses to complete a top-level task - merging does that)",
  "  claim <ref> <dev|review|cleanup> [--session <id>]",
  "                               claim (or re-stamp) an issue for this session: delegates it to the",
  "                               role's agent and stamps the claim comment",
  "  assign <ref> <developer|reviewer>",
  "                               hand an issue to an agent without claiming it for a session",
  "                               (the developer-to-reviewer handoff); clears any claim",
  "  release <ref> [--session <id>]",
  "                               release the claim and the delegate; with --session, a claim from",
  "                               another session is left alone (a row with no claim is still cleared)",
  "  comment <ref> --as <role> --body-file <path>",
  "                               post a comment, tagged with the agent role that wrote it",
  "  label <ref> add|remove <label name>",
  "  link-pr <ref> <pr-url|number>",
  "                               attach a pull request to an issue (Linear; GitHub links via Fixes #N)",
]

/**
 * Splits the global `--config` / `--platform` flags off the front of argv.
 */
function splitGlobalFlags(argv: string[]): { configPath?: string; platform?: string; rest: string[] } {
  const rest = [...argv]
  let configPath: string | undefined
  let platform: string | undefined
  while (rest.length > 0) {
    const flag = rest[0]
    if (flag === "--config" && rest[1] !== undefined) {
      configPath = rest[1]
      rest.splice(0, 2)
    } else if (flag === "--platform" && rest[1] !== undefined) {
      platform = rest[1]
      rest.splice(0, 2)
    } else {
      break
    }
  }
  return { configPath, platform, rest }
}

/**
 * Turns a command-line state argument into a role when it spells one, else
 * leaves it as a display name for the backend to resolve.
 *
 * A role the workflow has retired throws instead, naming what replaced it: a
 * skill or a habit that still writes `ai-review` should be told where the flow
 * moved, not left to read "unknown state" as a typo.
 */
export function stateArgument(parts: string[]): string | StateRole {
  const joined = parts.join(" ").trim()
  const key = joined.toLowerCase().replace(/\s+/g, "-")
  const retired = RETIRED_STATE_ROLE_ALIASES[key]
  if (retired !== undefined) throw new Error(`refusing to move to "${joined}": ${retired}`)
  return STATE_ROLE_ALIASES[key] ?? joined
}

/**
 * `config`: what the CLI resolved, so a skill can confirm the platform.
 */
function commandConfig(config: DispatcherConfig, configPath: string, board: BoardBackend, io: BoardCliIo): number {
  io.out(`config: ${configPath}`)
  io.out(`platform: ${board.platform}`)
  io.out(`repository: ${config.repository}`)
  if (board.platform === "linear" && config.linear !== undefined) {
    io.out(`project: ${config.linear.projectUrl} (team ${config.linear.teamKey})`)
  }
  if (board.platform === "github" && config.github !== undefined) {
    io.out(`project: https://github.com/orgs/${config.github.owner}/projects/${config.github.projectNumber}`)
  }
  const states = board.platform === "linear" ? config.linear?.states : undefined
  const githubStates = board.platform === "github" ? config.github?.states : undefined
  io.out("states:")
  for (const [role, value] of Object.entries(states ?? githubStates ?? {})) {
    io.out(`  ${role}: ${typeof value === "string" ? value : value.name}`)
  }
  io.out(`labels: confirmWithUser="${board.labels.confirmWithUser}" ui="${board.labels.ui}"`)
  io.out(`claims stale after: ${config.claimStaleMinutes} min`)
  return 0
}

/**
 * `states`: the workflow states.
 */
async function commandStates(board: BoardBackend, io: BoardCliIo): Promise<number> {
  io.out("name\trole\tclosed\tid")
  for (const state of await board.states()) io.out(`${state.name}\t${state.role ?? "-"}\t${state.closed ? "yes" : "no"}\t${state.id}`)
  return 0
}

/**
 * `milestones`: each milestone with its open-issue count.
 */
async function commandMilestones(board: BoardBackend, io: BoardCliIo): Promise<number> {
  io.out("milestone\topen")
  for (const milestone of await board.milestones()) io.out(`${milestone.name}\t${milestone.open}`)
  return 0
}

/**
 * `poll`: the board rows for a milestone set, in board order.
 */
async function commandPoll(argv: string[], board: BoardBackend, deps: BoardCliDeps, io: BoardCliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { all: { type: "boolean" }, "all-milestones": { type: "boolean" } },
    strict: true,
    allowPositionals: true,
  })
  if (positionals.length === 0 && values["all-milestones"] !== true) {
    throw new Error("poll needs at least one milestone name (or --all-milestones)")
  }
  const rows = sortRows(await board.poll({
    milestones: values["all-milestones"] === true ? "all" : positionals,
    includeClosed: values.all === true,
  }))
  const now = deps.now()
  io.out(ROW_TSV_HEADER)
  for (const row of rows) io.out(formatRowTsv(row, now))
  return 0
}

/**
 * `issue`: one issue as Markdown for a worker prompt, or raw JSON.
 */
async function commandIssue(argv: string[], board: BoardBackend, deps: BoardCliDeps, io: BoardCliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { comments: { type: "string" }, json: { type: "boolean" } },
    strict: true,
    allowPositionals: true,
  })
  const ref = positionals[0]
  if (ref === undefined) throw new Error("issue needs an issue reference")
  const commentLimit = values.comments === undefined ? 10 : Number(values.comments)
  if (!Number.isInteger(commentLimit) || commentLimit < 0) throw new Error(`invalid --comments: ${values.comments}`)
  const issue = await board.issue(board.normalizeRef(ref))
  if (values.json === true) {
    io.out(JSON.stringify(issue, null, 2))
    return 0
  }
  for (const line of renderIssueMarkdown(issue, deps.now(), commentLimit)) io.out(line)
  return 0
}

/**
 * `state`: moves an issue to a state named by role or display name.
 */
async function commandState(argv: string[], board: BoardBackend, io: BoardCliIo): Promise<number> {
  const [ref, ...nameParts] = argv
  if (ref === undefined) throw new Error("state needs an issue reference and a state, e.g. state ACM-12 in-progress")
  const state = stateArgument(nameParts)
  if (state === "") throw new Error("state needs a state name or role, e.g. state ACM-12 in-progress")
  const change = await board.setState(board.normalizeRef(ref), state)
  io.out(change.changed ? `${change.ref}: ${change.from} -> ${change.to}` : `${change.ref} already at ${change.to}`)
  return 0
}

/**
 * `claim`: writes (or re-stamps) the claim. Claims are last-writer-wins on
 * every platform, so claim right after polling, never from a stale read.
 */
async function commandClaim(argv: string[], board: BoardBackend, deps: BoardCliDeps, io: BoardCliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
    strict: true,
    allowPositionals: true,
  })
  const ref = positionals[0]
  const role = positionals[1]
  if (ref === undefined) throw new Error("claim needs an issue reference and a role")
  if (role === undefined || !isClaimRole(role)) throw new Error(`claim needs a role: dev, review or cleanup (got ${role ?? "nothing"})`)
  const sessionId = resolveSessionId(values.session, deps.env)
  const result = await board.claim(board.normalizeRef(ref), role, sessionId, deps.now())
  const replaced = result.replaced === null ? "" : ` (replaced ${formatClaimText(result.replaced)})`
  io.out(`${result.ref} claimed ${result.claim}${replaced}`)
  return 0
}

/**
 * `assign`: hands an issue to an agent without claiming it for a session.
 *
 * This is what moves work between agent phases - a developer finishing hands
 * the row to the reviewer - and it is deliberately separate from `claim`: the
 * delegate says which agent phase the row is in and survives between sessions,
 * while a claim says a session is working it right now.
 */
async function commandAssign(argv: string[], board: BoardBackend, io: BoardCliIo): Promise<number> {
  const [ref, agent] = argv
  if (ref === undefined) throw new Error("assign needs an issue reference and an agent")
  const target = AGENT_ROLES.find((candidate): candidate is AgentRole => candidate === agent)
  if (target === undefined) throw new Error(`assign needs an agent: developer or reviewer (got ${agent ?? "nothing"})`)
  const result = await board.assign(board.normalizeRef(ref), target)
  const from = result.previous === null ? "" : ` (was ${result.previous})`
  const cleared = result.released === null ? "" : `, cleared ${formatClaimText(result.released)}`
  io.out(`${result.ref} assigned to ${result.agent}${from}${cleared}`)
  return 0
}

/**
 * `release`: releases the claim and the delegate.
 *
 * With `--session`, a claim belonging to a *different* session is left alone -
 * the stop skill uses this so one dispatcher never clears another live
 * dispatcher's worker. A row carrying **no** claim is still released, because
 * there is no session there to protect and refusing would strand the exact
 * half-state the claim's write ordering is designed to produce: the delegate
 * is written before the comment, so a failed comment write leaves an agent
 * apparently holding a row with nobody on it, and `release --session` is the
 * one call the stop skill makes at such a row.
 */
async function commandRelease(argv: string[], board: BoardBackend, io: BoardCliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
    strict: true,
    allowPositionals: true,
  })
  const ref = positionals[0]
  if (ref === undefined) throw new Error("release needs an issue reference")
  const normalized = board.normalizeRef(ref)
  if (values.session !== undefined) {
    const claim = (await board.issue(normalized)).claim
    if (claim !== null && claim.sessionId !== values.session) {
      io.out(`${normalized} left alone: claimed by ${formatClaimText(claim)}, not ${values.session}`)
      return 0
    }
  }
  const result = await board.release(normalized)
  if (result.released !== null) {
    io.out(`${result.ref} released (was ${formatClaimText(result.released)})`)
    return 0
  }
  if (result.delegate !== null) {
    io.out(`${result.ref} had no claim; cleared the ${result.delegate} delegate it was left with`)
    return 0
  }
  io.out(`${result.ref} has no claim`)
  return 0
}

/**
 * `claims`: every open issue that carries a claim or a delegate, plus every
 * parked question, whatever milestone it sits in. This is the stranded-row
 * scan's input and the stop skill's inventory.
 *
 * A delegate with no claim is listed too, and is not a fault: it is a row
 * queued for an agent that no session has picked up yet. A dead session leaves
 * the opposite - a stale claim - which is what the scan steals.
 */
async function commandClaims(argv: string[], board: BoardBackend, config: DispatcherConfig, deps: BoardCliDeps, io: BoardCliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { session: { type: "string" } },
    strict: true,
  })
  const rows = sortRows(await board.poll({ milestones: "all", includeClosed: false }))
  const now = deps.now()
  const ownSession = resolveSessionId(values.session, deps.env)
  io.out("kind\tmilestone\tstate\tdelegate\tclaim\tage-min\tissue\ttitle")
  for (const row of rows) {
    const delegate = row.delegate ?? "-"
    if (row.claim !== null) {
      const stale = isClaimStale(row.claim, now, ownSession, config.claimStaleMinutes)
      const kind = stale ? "stale-claim" : (row.claim.sessionId === ownSession ? "own-claim" : "claim")
      io.out([
        kind, row.milestone ?? "-", row.state, delegate, formatClaimText(row.claim),
        String(claimAgeMinutes(row.claim, now)), row.ref, row.title,
      ].join("\t"))
    } else if (row.delegate !== null) {
      io.out(["queued", row.milestone ?? "-", row.state, delegate, "-", "-", row.ref, row.title].join("\t"))
    }
    if (row.stateRole === "question") {
      io.out(["question", row.milestone ?? "-", row.state, delegate, "-", "-", row.ref, row.title].join("\t"))
    }
  }
  io.out(`(claims older than ${config.claimStaleMinutes} minutes from another session are stale)`)
  return 0
}

/**
 * `comment`: posts a comment tagged with the role that wrote it. On Linear
 * every comment goes out under the one account the API key belongs to, so the
 * tag is the only attribution there is; on GitHub the caller's `gh` identity
 * shows too.
 */
async function commandComment(argv: string[], board: BoardBackend, io: BoardCliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { as: { type: "string" }, "body-file": { type: "string" } },
    strict: true,
    allowPositionals: true,
  })
  const ref = positionals[0]
  if (ref === undefined) throw new Error("comment needs an issue reference")
  const role = values.as
  if (role === undefined || role === "") throw new Error("comment needs --as <dispatcher|developer|reviewer|cleaner>")
  if (values["body-file"] === undefined) throw new Error("comment needs --body-file <path>")
  const body = readFileSync(values["body-file"], "utf8").trim()
  if (body === "") throw new Error("comment body is empty")
  const result = await board.comment(board.normalizeRef(ref), `**[${role}]**\n\n${body}`)
  io.out(`${result.ref} commented as ${role}${result.url === null ? "" : `: ${result.url}`}`)
  return 0
}

/**
 * `label`: adds or removes one label by name.
 */
async function commandLabel(argv: string[], board: BoardBackend, io: BoardCliIo): Promise<number> {
  const [ref, verb, ...nameParts] = argv
  if (ref === undefined) throw new Error("label needs an issue reference")
  if (verb !== "add" && verb !== "remove") throw new Error("label needs add or remove, e.g. label ACM-12 add UI")
  const name = nameParts.join(" ").trim()
  if (name === "") throw new Error("label needs a label name")
  const normalized = board.normalizeRef(ref)
  const labels = await board.label(normalized, verb, name)
  io.out(`${normalized} labels: ${labels.join(", ") || "-"}`)
  return 0
}

const prViewSchema = z.object({
  number: z.number(),
  url: z.string(),
  headRefName: z.string(),
  title: z.string(),
  body: z.string().nullable(),
})

/**
 * Reads a pull request through `gh`, by number or URL.
 */
function readPullRequest(deps: BoardCliDeps, ref: string, repository: string): PullRequestRef {
  const raw = deps.gh(["pr", "view", ref, "--repo", repository, "--json", "number,url,headRefName,title,body"])
  const pr = prViewSchema.parse(JSON.parse(raw))
  return { number: pr.number, url: pr.url, headRef: pr.headRefName, title: pr.title, body: pr.body ?? "" }
}

/**
 * `pr-issues`: the board issues a pull request belongs to.
 */
async function commandPrIssues(argv: string[], board: BoardBackend, config: DispatcherConfig, deps: BoardCliDeps, io: BoardCliIo): Promise<number> {
  const ref = argv[0]
  if (ref === undefined) throw new Error("pr-issues needs a pull request number or URL")
  const pr = readPullRequest(deps, ref, config.repository)
  const issues = await board.resolvePullRequest(pr)
  io.out("issue\tstate\tvia\ttitle")
  for (const issue of issues) io.out(`${issue.ref}\t${issue.state}\t${issue.via}\t${issue.title}`)
  if (issues.length === 0) io.out(`(no board issue found for PR #${pr.number} ${pr.headRef})`)
  return 0
}

/**
 * `link-pr`: attaches a pull request to an issue.
 */
async function commandLinkPr(argv: string[], board: BoardBackend, config: DispatcherConfig, deps: BoardCliDeps, io: BoardCliIo): Promise<number> {
  const [ref, prRef] = argv
  if (ref === undefined || prRef === undefined) throw new Error("link-pr needs an issue reference and a pull request URL or number")
  const url = /^https?:\/\//.test(prRef) ? prRef : readPullRequest(deps, prRef, config.repository).url
  const normalized = board.normalizeRef(ref)
  await board.linkPullRequest(normalized, url)
  io.out(`${normalized} linked ${url}`)
  return 0
}

/**
 * Dispatches one CLI invocation. Returns the exit code; never throws (errors
 * print to stderr and exit 2, so a skill sees the reason in its output).
 */
export async function runBoardCli(argv: string[], io: BoardCliIo, deps: BoardCliDeps): Promise<number> {
  const { configPath, platform, rest } = splitGlobalFlags(argv)
  const [command, ...args] = rest
  try {
    if (command === undefined) {
      for (const line of USAGE_LINES) io.err(line)
      return 2
    }
    const { config, path: resolvedPath } = deps.loadConfig(configPath, platform)
    const board = deps.backend(config)
    switch (command) {
      case "config": return commandConfig(config, resolvedPath, board, io)
      case "states": return await commandStates(board, io)
      case "milestones": return await commandMilestones(board, io)
      case "poll": return await commandPoll(args, board, deps, io)
      case "issue": return await commandIssue(args, board, deps, io)
      case "claims": return await commandClaims(args, board, config, deps, io)
      case "pr-issues": return await commandPrIssues(args, board, config, deps, io)
      case "state": return await commandState(args, board, io)
      case "claim": return await commandClaim(args, board, deps, io)
      case "assign": return await commandAssign(args, board, io)
      case "release": return await commandRelease(args, board, io)
      case "comment": return await commandComment(args, board, io)
      case "label": return await commandLabel(args, board, io)
      case "link-pr": return await commandLinkPr(args, board, config, deps, io)
      default:
        for (const line of USAGE_LINES) io.err(line)
        return 2
    }
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

/**
 * Runs the board CLI with real process wiring: output to stdout/stderr, real
 * `gh`, real config, real backend credentials. Execution belongs to main.ts
 * alone - a module-level "am I the entrypoint" guard here would misfire in
 * the compiled binary, where bundling gives every module the entry's
 * `import.meta.url`.
 */
export async function runBoardCliFromProcess(argv: string[]): Promise<number> {
  const io: BoardCliIo = {
    out: (line) => { console.log(line) },
    err: (line) => { console.error(line) },
  }
  const boardDeps: BoardDeps = { env: process.env }
  const deps: BoardCliDeps = {
    backend: (config) => createBoardBackend(config, boardDeps),
    loadConfig: (explicitPath, platformOverride) => loadDispatcherConfig({ explicitPath, platformOverride }),
    env: process.env,
    now: () => new Date(),
    gh: (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
  }
  return runBoardCli(argv, io, deps)
}
