import { agentForClaimRole } from "../board/claim-comment"
import { formatClaim, formatClaimStamp } from "../board/claims"
import type { DispatcherConfig } from "../board/config"
import { assertLabelInUse, assertMayClose } from "../board/policy"
import { AGENT_ROLES } from "../board/types"
import type {
  AgentRole,
  BoardBackend,
  BoardRow,
  Claim,
  ClaimRole,
  IssueDetail,
  LinkedIssue,
  PollOptions,
  PullRequestRef,
  StateChange,
  StateRole,
  WorkflowLabels,
  WorkflowState,
} from "../board/types"

/**
 * Test doubles for the platform-neutral board: a config with both sections,
 * and an in-memory backend the CLI specs drive. Nothing here is imported by
 * production code.
 */

/** A config naming both platforms, with fictional "acme/widgets" ids. */
export const TEST_CONFIG: DispatcherConfig = {
  platform: "linear",
  repository: "acme/widgets",
  botUserIds: [100000001, 100000002],
  claimStaleMinutes: 90,
  githubApps: {
    developer: {
      appId: 111111,
      installationId: 10000001,
      slug: "acme-developer",
      botLogin: "acme-developer[bot]",
      botUserId: 100000001,
      keyEnvVar: "DISPATCHER_GITHUB_APP_KEY_DEVELOPER",
    },
    reviewer: {
      appId: 222222,
      installationId: 10000002,
      slug: "acme-reviewer",
      botLogin: "acme-reviewer[bot]",
      botUserId: 100000002,
      keyEnvVar: "DISPATCHER_GITHUB_APP_KEY_REVIEWER",
    },
  },
  linear: {
    workspace: "acme",
    teamId: "team-1",
    teamKey: "ACM",
    projectId: "proj-1",
    projectUrl: "https://linear.app/acme/project/widgets-0a1b2c3d4e5f",
    states: {
      backlog: "Backlog",
      ready: "Ready",
      changesRequested: "Changes Requested",
      inProgress: "In Progress",
      question: "Question",
      humanReview: "Human Review",
      done: "Done",
    },
    agents: {
      developer: "agent-developer",
      reviewer: "agent-reviewer",
    },
    labels: { confirmWithUser: "Confirm with user", ui: "UI" },
  },
  github: {
    owner: "acme",
    projectNumber: 2,
    projectId: "PVT_exampleProject01",
    statusFieldId: "PVTSSF_status",
    claimedByFieldId: "PVTF_claim",
    states: {
      backlog: { name: "Hold", optionId: "c6c58d18" },
      ready: { name: "Ready", optionId: "f75ad846" },
      changesRequested: { name: "Changes Requested", optionId: "cbe4dc71" },
      inProgress: { name: "In Progress", optionId: "47fc9ee4" },
      humanReview: { name: "User Review", optionId: "b2bb70ee" },
      done: { name: "Done", optionId: "98236657" },
    },
    labels: { confirmWithUser: "confirm-with-user", ui: "ui" },
  },
}

/** Display names the memory board delegates to, mirroring the Linear app users. */
export const AGENT_DISPLAY_NAMES: Record<AgentRole, string> = {
  developer: "acme-developer",
  reviewer: "acme-reviewer",
}

/** The account the memory board's API key belongs to, which delegation assigns. */
export const OWNER_DISPLAY_NAME = "someuser"

/** Fields of a fixture row that tests commonly vary. */
export type RowFixture = Partial<BoardRow> & { ref: string }

/**
 * Builds a full board row from a handful of overrides.
 */
export function makeRow(fixture: RowFixture): BoardRow {
  return {
    title: `Task ${fixture.ref}`,
    url: `https://linear.app/acme/issue/${fixture.ref}`,
    sortIndex: 10,
    state: "Ready",
    stateRole: "ready",
    closed: false,
    milestone: "v1.1.0",
    assignee: null,
    delegate: null,
    labels: [],
    claim: null,
    openBlockers: [],
    pullRequests: [],
    parent: null,
    children: null,
    githubIssue: null,
    ...fixture,
  }
}

/** The Linear-named states the memory board exposes. */
const MEMORY_STATES: WorkflowState[] = [
  { name: "Backlog", role: "backlog", closed: false, id: "st-backlog" },
  { name: "Ready", role: "ready", closed: false, id: "st-ready" },
  { name: "In Progress", role: "inProgress", closed: false, id: "st-in-progress" },
  { name: "Changes Requested", role: "changesRequested", closed: false, id: "st-changes" },
  { name: "Question", role: "question", closed: false, id: "st-question" },
  { name: "Human Review", role: "humanReview", closed: false, id: "st-human-review" },
  { name: "Done", role: "done", closed: true, id: "st-done" },
  { name: "Canceled", role: null, closed: true, id: "st-canceled" },
]

/**
 * An in-memory `BoardBackend` with Linear-style refs, recording every write.
 */
export class MemoryBoard implements BoardBackend {
  readonly platform = "linear" as const

  readonly labels: WorkflowLabels = { confirmWithUser: "Confirm with user", ui: "UI" }

  readonly writes: string[] = []

  readonly rows = new Map<string, IssueDetail>()

  linked: LinkedIssue[] = []

  constructor(rows: RowFixture[] = []) {
    for (const fixture of rows) this.add(fixture)
  }

  /**
   * Adds a row (as a full detail record) to the board.
   */
  add(fixture: RowFixture & Partial<IssueDetail>): IssueDetail {
    const detail: IssueDetail = {
      ...makeRow(fixture),
      description: fixture.description ?? null,
      blockers: fixture.blockers ?? [],
      childIssues: fixture.childIssues ?? [],
      pullRequestUrls: fixture.pullRequestUrls ?? [],
      comments: fixture.comments ?? [],
      commentCount: fixture.commentCount ?? (fixture.comments ?? []).length,
    }
    this.rows.set(detail.ref, detail)
    return detail
  }

  /**
   * Validates and upper-cases an `ACM-n` reference.
   */
  normalizeRef(ref: string): string {
    if (!/^acm-\d+$/i.test(ref)) throw new Error(`expected an issue identifier like ACM-12, got ${ref}`)
    return ref.toUpperCase()
  }

  /**
   * The row for a ref, or throws.
   */
  private get(ref: string): IssueDetail {
    const row = this.rows.get(ref)
    if (row === undefined) throw new Error(`Entity not found: Issue ${ref}`)
    return row
  }

  async states(): Promise<WorkflowState[]> {
    return MEMORY_STATES
  }

  async milestones(): Promise<{ name: string; open: number }[]> {
    const counts = new Map<string, number>()
    for (const row of this.rows.values()) {
      if (row.closed) continue
      const name = row.milestone ?? "(none)"
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts.entries()].map(([name, open]) => ({ name, open }))
  }

  async poll(options: PollOptions): Promise<BoardRow[]> {
    return [...this.rows.values()].filter((row) => {
      if (options.milestones !== "all" && (row.milestone === null || !options.milestones.includes(row.milestone))) return false
      return options.includeClosed || !row.closed
    })
  }

  async issue(ref: string): Promise<IssueDetail> {
    return this.get(ref)
  }

  async setState(ref: string, state: string | StateRole): Promise<StateChange> {
    const row = this.get(ref)
    const target = MEMORY_STATES.find((candidate) => candidate.role === state || candidate.name.toLowerCase() === String(state).toLowerCase())
    if (target === undefined) throw new Error(`unknown state "${state}"; the team has: ${MEMORY_STATES.map((s) => s.name).join(", ")}`)
    assertMayClose(ref, target.name, target.closed, row.parent !== null)
    if (row.state === target.name) return { ref, from: row.state, to: target.name, changed: false }
    const from = row.state
    row.state = target.name
    row.stateRole = target.role
    row.closed = target.closed
    this.writes.push(`state ${ref} ${from} -> ${target.name}`)
    return { ref, from, to: target.name, changed: true }
  }

  /**
   * Refuses to move a delegate belonging to an agent this dispatcher does not
   * run, mirroring the Linear backend's guard.
   */
  private assertDelegateIsOurs(ref: string, what: string): void {
    const delegate = this.get(ref).delegate
    if (delegate === null) return
    if (AGENT_ROLES.some((role) => AGENT_DISPLAY_NAMES[role] === delegate)) return
    throw new Error(`refusing to ${what} ${ref}: it is delegated to ${delegate}, which is not an agent this dispatcher runs`)
  }

  async claim(ref: string, role: ClaimRole, sessionId: string, now: Date): Promise<{ ref: string; claim: string; replaced: Claim | null }> {
    const row = this.get(ref)
    this.assertDelegateIsOurs(ref, "claim")
    const replaced = row.claim
    const text = formatClaim(role, sessionId, now)
    row.claim = { role, sessionId, stampedAt: formatClaimStamp(now) }
    // Claiming delegates and, as Linear does, takes the assignee with it.
    row.delegate = AGENT_DISPLAY_NAMES[agentForClaimRole(role)]
    row.assignee = OWNER_DISPLAY_NAME
    this.writes.push(`claim ${ref} ${text}`)
    return { ref, claim: text, replaced }
  }

  async assign(ref: string, agent: AgentRole): Promise<{ ref: string; agent: AgentRole; previous: AgentRole | null; released: Claim | null }> {
    const row = this.get(ref)
    this.assertDelegateIsOurs(ref, `hand to the ${agent}`)
    const previous = AGENT_ROLES.find((candidate) => AGENT_DISPLAY_NAMES[candidate] === row.delegate) ?? null
    const released = row.claim
    row.delegate = AGENT_DISPLAY_NAMES[agent]
    row.assignee = OWNER_DISPLAY_NAME
    row.claim = null
    this.writes.push(`assign ${ref} ${agent}`)
    return { ref, agent, previous, released }
  }

  async release(ref: string): Promise<{ ref: string; released: Claim | null; delegate: AgentRole | null }> {
    const row = this.get(ref)
    const released = row.claim
    row.claim = null
    // Releasing clears the assignee with the delegate, or the row would read
    // as human-owned forever and never be dispatched again. A delegate we do
    // not run is left alone, exactly as the Linear backend leaves it.
    const delegate = AGENT_ROLES.find((role) => AGENT_DISPLAY_NAMES[role] === row.delegate) ?? null
    if (delegate !== null) {
      row.delegate = null
      row.assignee = null
    }
    // Recorded whenever the call cleared something, so a caller's write
    // sequence shows the release even on a row that carried only a delegate.
    if (released !== null || delegate !== null) this.writes.push(`release ${ref}`)
    return { ref, released, delegate }
  }

  async comment(ref: string, body: string): Promise<{ ref: string; url: string | null }> {
    this.get(ref)
    this.writes.push(`comment ${ref} ${body}`)
    return { ref, url: `https://linear.app/comment/${this.writes.length}` }
  }

  async label(ref: string, verb: "add" | "remove", name: string): Promise<string[]> {
    assertLabelInUse(name)
    const row = this.get(ref)
    if (!["Confirm with user", "UI", "Bug"].includes(name)) throw new Error(`no label named "${name}" in the workspace - the owner creates labels`)
    row.labels = verb === "add" ? [...new Set([...row.labels, name])] : row.labels.filter((label) => label !== name)
    this.writes.push(`label ${ref} ${verb} ${name}`)
    return row.labels
  }

  async resolvePullRequest(_pr: PullRequestRef): Promise<LinkedIssue[]> {
    return this.linked
  }

  async linkPullRequest(ref: string, prUrl: string): Promise<void> {
    this.get(ref).pullRequestUrls.push(prUrl)
    this.writes.push(`link-pr ${ref} ${prUrl}`)
  }
}
