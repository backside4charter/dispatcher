/**
 * The platform-neutral board model the dispatcher works against.
 *
 * The dispatcher's skills and worker agents never talk to a tracker directly:
 * they run `just board <command>`, which drives one `BoardBackend`. Two
 * backends exist - Linear (the live one) and GitHub Projects v2 (the flow the
 * dispatcher ran on until 2026-08-27, kept as a selectable alternative) - and
 * everything that is the same on both sides (claim text, row rendering, the
 * review-to-board sync's decision, the CLI) is written once against these
 * types. The intent is for the whole package to lift out as a library one
 * day, with the platform a configuration choice.
 */

/** The trackers a board can live on. */
export type BoardPlatform = "linear" | "github"

/**
 * The workflow roles the dispatcher routes on, independent of what each
 * platform calls the state. `backlog` is "not to be worked on yet" (Linear
 * `Backlog`, GitHub `Hold`); `question` is "parked on something only the owner
 * can answer"; `humanReview` is "waiting on the owner" (Linear `Human Review`,
 * GitHub `User Review`).
 *
 * There is deliberately no review-by-agent state. Which agent phase a row is
 * in is carried by `BoardRow.delegate`, so the state says only where the row
 * sits in the human-facing pipeline and a task stays `In Progress` from
 * dispatch until it is ready for the owner.
 */
export type StateRole = "backlog" | "ready" | "changesRequested" | "inProgress" | "question" | "humanReview" | "done"

export const STATE_ROLES: readonly StateRole[] = [
  "backlog", "ready", "changesRequested", "inProgress", "question", "humanReview", "done",
]

/** Kebab-case spellings a command line accepts for each role. */
export const STATE_ROLE_ALIASES: Record<string, StateRole> = {
  backlog: "backlog",
  hold: "backlog",
  ready: "ready",
  "changes-requested": "changesRequested",
  "in-progress": "inProgress",
  question: "question",
  "human-review": "humanReview",
  "user-review": "humanReview",
  done: "done",
}

/**
 * State roles a command line used to accept, with what to do instead.
 *
 * Naming them explicitly means a skill or a habit that still writes the old
 * role gets told where the flow moved, rather than falling through to
 * "unknown state" and reading as a typo.
 */
export const RETIRED_STATE_ROLE_ALIASES: Record<string, string> = {
  "ai-review": 'the AI Review state was removed: hand the row to the reviewer instead, with "board assign <ref> reviewer", '
    + "and leave it In Progress until it is ready for Human Review",
}

/** One workflow state as a platform exposes it. */
export interface WorkflowState {
  /** Display name on the platform. */
  name: string
  /** The dispatcher role it plays, or null for a state the workflow does not use. */
  role: StateRole | null
  /** Whether issues in this state count as closed. */
  closed: boolean
  /** The platform's identifier for it. */
  id: string
}

/** Which worker type holds a claim. */
export type ClaimRole = "dev" | "review" | "cleanup"

/**
 * The agent identities work is delegated to. Two, for the three claim roles:
 * cleanup work is developer work, so it runs as the developer, exactly as the
 * cleaner already commits under the developer GitHub App.
 */
export type AgentRole = "developer" | "reviewer"

export const AGENT_ROLES: readonly AgentRole[] = ["developer", "reviewer"]

/**
 * A parsed claim on an issue.
 *
 * Every field comes out of the claim text the claiming worker wrote, on every
 * platform - nothing is read off a record the tracker maintains. That is what
 * makes staleness portable and verifiable: `stampedAt` is written on each
 * re-stamp and is what `claimAgeMinutes` measures, so the heartbeat never
 * depends on how a platform timestamps a record edited in place.
 */
export interface Claim {
  role: ClaimRole
  sessionId: string
  /** When the claim was last written (UTC minute) - what staleness is measured on. */
  stampedAt: string
}

/**
 * Labels the dispatcher keys on, by the platform's display name.
 *
 * Parked questions are a workflow *state*, not a label: the state alone says
 * a task is waiting on the owner, where a label had to be read together with
 * the state to mean anything.
 */
export interface WorkflowLabels {
  /** Agent-workable, but the owner wants a check-in before it starts. */
  confirmWithUser: string
  /** Design-sensitive frontend work. */
  ui: string
}

/** One board row, reduced to what dispatch decisions need. */
export interface BoardRow {
  /** The platform's human reference: `ACM-12` on Linear, `#480` on GitHub. */
  ref: string
  title: string
  url: string
  /** Position in the owner's manual board order; lower is higher priority. */
  sortIndex: number
  /** State display name. */
  state: string
  stateRole: StateRole | null
  closed: boolean
  milestone: string | null
  assignee: string | null
  /**
   * Display name of the agent the issue is delegated to, or null. This is the
   * visible half of a claim, and it is what separates a row an agent holds
   * from one a human took: delegating always sets an assignee too, so an
   * assignee on its own no longer means the row is a human's. Platforms with
   * no delegation report null.
   */
  delegate: string | null
  labels: string[]
  claim: Claim | null
  /** Refs of open issues that block this one. */
  openBlockers: string[]
  /** Numbers of pull requests linked to the issue. */
  pullRequests: number[]
  /** The parent issue, with its milestone, for legacy sub-issues. */
  parent: { ref: string; milestone: string | null } | null
  /** Sub-issue progress, for issues that have children. */
  children: { closed: number; total: number } | null
  /** The GitHub issue a Linear issue was imported from, when known. */
  githubIssue: number | null
}

/** A comment on an issue. */
export interface IssueComment {
  author: string
  createdAt: string
  body: string
}

/** One issue in full, for prompt-building. */
export interface IssueDetail extends BoardRow {
  description: string | null
  blockers: { ref: string; title: string; state: string }[]
  childIssues: { ref: string; title: string; state: string; openBlockers: string[] }[]
  pullRequestUrls: string[]
  /** Oldest first. */
  comments: IssueComment[]
  /** How many comments the issue has in total (the list above may be truncated). */
  commentCount: number
}

/** A pull request, reduced to what linking needs. */
export interface PullRequestRef {
  number: number
  url: string
  headRef: string
  title: string
  body: string
}

/** An issue a pull request resolved to. */
export interface LinkedIssue {
  ref: string
  title: string
  url: string
  state: string
  stateRole: StateRole | null
  closed: boolean
  /** The agent phase the issue is in, or null when no agent holds it. */
  agent: AgentRole | null
  /** Which route found it, for the log. */
  via: string
}

/** Options for a board poll. */
export interface PollOptions {
  /** Milestone names to include, or every milestone. */
  milestones: string[] | "all"
  includeClosed: boolean
}

/** Result of a state write. */
export interface StateChange {
  ref: string
  from: string
  to: string
  changed: boolean
}

/**
 * What every platform has to provide. Commands on the CLI map one-to-one onto
 * these methods; anything platform-specific stays behind them.
 */
export interface BoardBackend {
  readonly platform: BoardPlatform
  readonly labels: WorkflowLabels
  /** Normalizes a user-typed reference (`acm-12`, `480`, `#480`) to the canonical form, or throws. */
  normalizeRef(ref: string): string
  states(): Promise<WorkflowState[]>
  milestones(): Promise<{ name: string; open: number }[]>
  poll(options: PollOptions): Promise<BoardRow[]>
  issue(ref: string): Promise<IssueDetail>
  /** Moves an issue; `state` is a display name or a StateRole. */
  setState(ref: string, state: string | StateRole): Promise<StateChange>
  claim(ref: string, role: ClaimRole, sessionId: string, now: Date): Promise<{ ref: string; claim: string; replaced: Claim | null }>
  /**
   * Hands the issue to an agent without claiming it for a session: the
   * developer-to-reviewer handoff. Sets the delegate and clears any claim, so
   * the row reads as "queued for that agent, nobody working it yet".
   */
  assign(ref: string, agent: AgentRole): Promise<{ ref: string; agent: AgentRole; previous: AgentRole | null; released: Claim | null }>
  /**
   * Clears the claim and the delegate. `delegate` reports which agent's
   * delegation was actually cleared, so a caller can say what happened on a
   * row that carried a delegate but no claim - the half-state a failed claim
   * comment write leaves behind. Null when there was nothing to clear, and
   * null for a delegate belonging to somebody the dispatcher does not run,
   * which is deliberately left alone.
   */
  release(ref: string): Promise<{ ref: string; released: Claim | null; delegate: AgentRole | null }>
  comment(ref: string, body: string): Promise<{ ref: string; url: string | null }>
  label(ref: string, verb: "add" | "remove", name: string): Promise<string[]>
  resolvePullRequest(pr: PullRequestRef): Promise<LinkedIssue[]>
  /** Attaches a pull request to an issue, or throws when the platform links PRs another way. */
  linkPullRequest(ref: string, prUrl: string): Promise<void>
}
