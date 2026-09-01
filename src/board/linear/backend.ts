import { z } from "zod"
import { agentForClaimRole, formatClaimComment, isClaimComment } from "../claim-comment"
import { formatClaim } from "../claims"
import type { LinearConfig } from "../config"
import { assertLabelInUse, assertMayClose } from "../policy"
import { STATE_ROLES } from "../types"
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
} from "../types"
import type { LinearGraphql } from "./client"
import { resolvePullRequestIssues } from "./links"
import {
  CLAIM_COMMENTS_QUERY,
  CLAIM_COMMENT_SCAN,
  CLOSED_STATE_TYPES,
  ISSUES_QUERY,
  ISSUE_NODE_FIELDS,
  TEAM_STATES_QUERY,
  agentForDelegateId,
  claimCommentIdBatches,
  claimCommentNodeSchema,
  claimCommentsSchema,
  findClaimComment,
  isClosedStateType,
  issueNodeSchema,
  issuePageSchema,
  roleForStateName,
  teamStatesSchema,
  toBoardRow,
} from "./queries"
import type { IssueNode, IssuePage, LinearClaim } from "./queries"

const issueRefSchema = z.object({
  issue: z.object({
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string(),
    state: z.object({ name: z.string(), type: z.string() }),
    parent: z.object({ identifier: z.string() }).nullable(),
  }),
})

const ISSUE_REF_QUERY = `
query($id: String!) {
  issue(id: $id) {
    id identifier title url state { name type } parent { identifier }
  }
}`

/**
 * The claim's own view of an issue: who holds it, who it is assigned to, and
 * the comments the claim comment is among. Separate from `ISSUE_REF_QUERY`
 * because only the three claim commands need comment bodies, and every other
 * write (state, label, comment, link-pr) would be paying for them.
 */
const ISSUE_CLAIM_QUERY = `
query($id: String!) {
  issue(id: $id) {
    id identifier
    assignee { id displayName }
    delegate { id displayName }
    comments(first: ${CLAIM_COMMENT_SCAN}, orderBy: updatedAt) { nodes { id body } }
  }
}`

const issueClaimSchema = z.object({
  issue: z.object({
    id: z.string(),
    identifier: z.string(),
    assignee: z.object({ id: z.string(), displayName: z.string() }).nullable(),
    delegate: z.object({ id: z.string(), displayName: z.string() }).nullable(),
    comments: z.object({ nodes: z.array(claimCommentNodeSchema) }),
  }),
})

const MILESTONES_QUERY = `
query($projectId: String!) {
  project(id: $projectId) { projectMilestones { nodes { id name } } }
}`

const milestonesSchema = z.object({
  project: z.object({ projectMilestones: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }) }),
})

const MILESTONE_COUNT_QUERY = `
query($filter: IssueFilter!, $after: String) {
  issues(first: 250, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { projectMilestone { name } }
  }
}`

const milestoneCountSchema = z.object({
  issues: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(z.object({ projectMilestone: z.object({ name: z.string() }).nullable() })),
  }),
})

const ISSUE_DETAIL_QUERY = `
query($id: String!) {
  issue(id: $id) {
    ${ISSUE_NODE_FIELDS}
    description
    parent { title }
    children { nodes { title inverseRelations { nodes { type issue { identifier state { type } } } } } }
    inverseRelations { nodes { issue { title } } }
    comments(first: 100) { nodes { id body createdAt user { displayName } } }
  }
}`

const issueDetailSchema = z.object({
  issue: issueNodeSchema.extend({
    description: z.string().nullable(),
    parent: z.object({
      identifier: z.string(),
      title: z.string(),
      projectMilestone: z.object({ name: z.string() }).nullable(),
    }).nullable(),
    children: z.object({
      nodes: z.array(z.object({
        identifier: z.string(),
        title: z.string(),
        state: z.object({ name: z.string(), type: z.string() }),
        inverseRelations: z.object({
          nodes: z.array(z.object({ type: z.string(), issue: z.object({ identifier: z.string(), state: z.object({ type: z.string() }) }) })),
        }),
      })),
    }),
    inverseRelations: z.object({
      nodes: z.array(z.object({
        type: z.string(),
        issue: z.object({ identifier: z.string(), title: z.string(), state: z.object({ name: z.string(), type: z.string() }) }),
      })),
    }),
    comments: z.object({
      nodes: z.array(claimCommentNodeSchema.extend({
        createdAt: z.string(),
        user: z.object({ displayName: z.string() }).nullable(),
      })),
    }),
  }),
})

const SET_STATE_MUTATION = `
mutation($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { identifier state { name } } }
}`

const setStateSchema = z.object({
  issueUpdate: z.object({ success: z.boolean(), issue: z.object({ identifier: z.string(), state: z.object({ name: z.string() }) }) }),
})

/**
 * Sets or clears the delegate.
 *
 * Clearing takes the assignee with it. Linear sets the assignee to the acting
 * account when a delegate is set and leaves it behind when the delegate is
 * cleared, so a released row would keep the owner's name on it forever - and
 * an assignee with no delegate is exactly how the board says "a human took
 * this, agents keep off". Leaving the residue would make every row an agent
 * ever touched permanently undispatchable.
 */
const SET_DELEGATE_MUTATION = `
mutation($id: String!, $delegateId: String) {
  issueUpdate(id: $id, input: { delegateId: $delegateId }) {
    success issue { identifier assignee { displayName } delegate { id displayName } }
  }
}`

const CLEAR_DELEGATE_MUTATION = `
mutation($id: String!) {
  issueUpdate(id: $id, input: { delegateId: null, assigneeId: null }) {
    success issue { identifier assignee { displayName } delegate { id displayName } }
  }
}`

const delegateSchema = z.object({
  issueUpdate: z.object({
    success: z.boolean(),
    issue: z.object({
      identifier: z.string(),
      assignee: z.object({ displayName: z.string() }).nullable(),
      delegate: z.object({ id: z.string(), displayName: z.string() }).nullable(),
    }),
  }),
})

const CLAIM_COMMENT_CREATE_MUTATION = `
mutation($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id body updatedAt } }
}`

const CLAIM_COMMENT_UPDATE_MUTATION = `
mutation($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) { success comment { id body updatedAt } }
}`

const claimCommentWriteSchema = z.object({
  commentCreate: z.object({ success: z.boolean(), comment: claimCommentNodeSchema }).optional(),
  commentUpdate: z.object({ success: z.boolean(), comment: claimCommentNodeSchema }).optional(),
})

const CLAIM_COMMENT_DELETE_MUTATION = `
mutation($id: String!) { commentDelete(id: $id) { success } }`

const claimCommentDeleteSchema = z.object({ commentDelete: z.object({ success: z.boolean() }) })

const COMMENT_MUTATION = `
mutation($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`

const commentSchema = z.object({ commentCreate: z.object({ success: z.boolean(), comment: z.object({ id: z.string(), url: z.string() }) }) })

const LABEL_LOOKUP_QUERY = `
query($name: String!) {
  issueLabels(filter: { name: { eqIgnoreCase: $name } }) { nodes { id name } }
}`

const labelLookupSchema = z.object({ issueLabels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }) })

const LABEL_MUTATION = `
mutation($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success issue { identifier labels { nodes { name } } } }
}`

const labelMutationSchema = z.object({
  issueUpdate: z.object({ success: z.boolean(), issue: z.object({ identifier: z.string(), labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }) }) }),
})

const LINK_PR_MUTATION = `
mutation($issueId: String!, $url: String!) {
  attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success attachment { id url } }
}`

const linkPrSchema = z.object({ attachmentLinkGitHubPR: z.object({ success: z.boolean(), attachment: z.object({ id: z.string(), url: z.string() }) }) })

/**
 * Strips the Linear-only comment id off a claim.
 */
function publicClaim(claim: LinearClaim | null): Claim | null {
  if (claim === null) return null
  return { role: claim.role, sessionId: claim.sessionId, stampedAt: claim.stampedAt }
}

/**
 * The Linear implementation of the board.
 *
 * Features:
 * - Issues are addressed by identifier (`ACM-12`); Linear resolves them to
 *   ids itself, so no id ever appears in a skill or a prompt.
 * - A claim is Linear's own agent delegation plus one claim comment: the
 *   delegate shows the owning agent in the assignee UI, and the comment
 *   carries the role, the session and the heartbeat. `assign` moves the
 *   delegate alone, for the developer-to-reviewer handoff.
 * - State names come from the config, and every write resolves a name or
 *   role against the live team so a rename surfaces as "unknown state" rather
 *   than a silent write to the wrong column.
 * - Pull requests are linked by Linear's GitHub integration (branch name or
 *   body mentioning the identifier), by `link-pr`, or - for PRs opened before
 *   the move - through the GitHub issue the Linear issue was imported from.
 */
export class LinearBoard implements BoardBackend {
  readonly platform = "linear" as const

  readonly labels: WorkflowLabels

  private readonly identifierPattern: RegExp

  constructor(
    private readonly config: LinearConfig,
    private readonly repository: string,
    private readonly client: LinearGraphql,
  ) {
    this.labels = config.labels
    this.identifierPattern = new RegExp(`^${config.teamKey}-\\d+$`, "i")
  }

  /**
   * Validates and upper-cases an `ACM-n` reference.
   */
  normalizeRef(ref: string): string {
    if (!this.identifierPattern.test(ref)) {
      throw new Error(`expected an issue identifier like ${this.config.teamKey}-12, got ${ref}`)
    }
    return ref.toUpperCase()
  }

  /**
   * The team's workflow states with the role each plays.
   */
  async states(): Promise<WorkflowState[]> {
    const result = await this.client.query(TEAM_STATES_QUERY, { teamId: this.config.teamId }, teamStatesSchema)
    return [...result.team.states.nodes]
      .sort((a, b) => a.position - b.position)
      .map((state) => ({
        name: state.name,
        role: roleForStateName(this.config, state.name),
        closed: isClosedStateType(state.type),
        id: state.id,
      }))
  }

  /**
   * Each project milestone with its open-issue count, plus `(none)` for open
   * issues carrying no milestone.
   */
  async milestones(): Promise<{ name: string; open: number }[]> {
    const milestones = await this.client.query(MILESTONES_QUERY, { projectId: this.config.projectId }, milestonesSchema)
    const counts = new Map<string, number>()
    let after: string | null = null
    for (;;) {
      const page: z.infer<typeof milestoneCountSchema> = await this.client.query(MILESTONE_COUNT_QUERY, {
        filter: { project: { id: { eq: this.config.projectId } }, state: { type: { nin: [...CLOSED_STATE_TYPES] } } },
        after,
      }, milestoneCountSchema)
      for (const node of page.issues.nodes) {
        const name = node.projectMilestone?.name ?? "(none)"
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) break
      after = page.issues.pageInfo.endCursor
    }
    const result = milestones.project.projectMilestones.nodes.map((milestone) => ({
      name: milestone.name, open: counts.get(milestone.name) ?? 0,
    }))
    if ((counts.get("(none)") ?? 0) > 0) result.push({ name: "(none)", open: counts.get("(none)") ?? 0 })
    return result
  }

  /**
   * Every page of the issues query for a filter.
   */
  private async fetchIssues(filter: Record<string, unknown>): Promise<IssueNode[]> {
    const nodes: IssueNode[] = []
    let after: string | null = null
    for (;;) {
      const page: IssuePage = await this.client.query(ISSUES_QUERY, { filter, after }, issuePageSchema)
      nodes.push(...page.issues.nodes)
      if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) return nodes
      after = page.issues.pageInfo.endCursor
    }
  }

  /**
   * Claims for the issues that carry a delegate, by issue id.
   *
   * This is the poll's second query, and the reason the first one selects no
   * comments. A board poll returns up to 250 issues; asking for their comments
   * would drag every comment body on the board across the wire to find the one
   * or two that are claims. A delegate, by contrast, is one small object per
   * issue, and only a delegated row can be claimed - claiming sets both. So
   * the poll asks for comments on exactly the rows that could have a claim,
   * and skips the query entirely when none do, which is the common case.
   */
  private async claimsFor(issues: IssueNode[]): Promise<Map<string, Claim>> {
    const claimed = new Map<string, Claim>()
    const ids = issues.filter((issue) => issue.delegate !== null).map((issue) => issue.id)
    if (ids.length === 0) return claimed
    for (const batch of claimCommentIdBatches(ids)) {
      const result = await this.client.query(CLAIM_COMMENTS_QUERY, { ids: batch, first: batch.length }, claimCommentsSchema)
      for (const node of result.issues.nodes) {
        const claim = publicClaim(findClaimComment(node.comments.nodes))
        if (claim !== null) claimed.set(node.id, claim)
      }
    }
    return claimed
  }

  /**
   * Board rows for a milestone set, filtered server-side, in no particular
   * order (the CLI sorts).
   */
  async poll(options: PollOptions): Promise<BoardRow[]> {
    const filter: Record<string, unknown> = { project: { id: { eq: this.config.projectId } } }
    if (options.milestones !== "all") filter.projectMilestone = { name: { in: options.milestones } }
    if (!options.includeClosed) filter.state = { type: { nin: [...CLOSED_STATE_TYPES] } }
    const issues = await this.fetchIssues(filter)
    const claims = await this.claimsFor(issues)
    return issues.map((node) => toBoardRow(node, this.config, claims.get(node.id) ?? null))
  }

  /**
   * One issue in full.
   */
  async issue(ref: string): Promise<IssueDetail> {
    const { issue } = await this.client.query(ISSUE_DETAIL_QUERY, { id: this.normalizeRef(ref) }, issueDetailSchema)
    const claim = publicClaim(findClaimComment(issue.comments.nodes))
    const row = toBoardRow(issue, this.config, claim)
    // The claim comment is dispatcher bookkeeping, not conversation: it is
    // reported as the claim, and left out of the comments a worker prompt
    // embeds so it cannot be mistaken for something the owner said.
    const conversation = issue.comments.nodes.filter((comment) => !isClaimComment(comment.body))
    const comments = [...conversation]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((comment) => ({ author: comment.user?.displayName ?? "unknown", createdAt: comment.createdAt, body: comment.body }))
    return {
      ...row,
      description: issue.description,
      blockers: issue.inverseRelations.nodes
        .filter((relation) => relation.type === "blocks")
        .map((relation) => ({ ref: relation.issue.identifier, title: relation.issue.title, state: relation.issue.state.name })),
      childIssues: issue.children.nodes.map((child) => ({
        ref: child.identifier,
        title: child.title,
        state: child.state.name,
        openBlockers: child.inverseRelations.nodes
          .filter((relation) => relation.type === "blocks" && !isClosedStateType(relation.issue.state.type))
          .map((relation) => relation.issue.identifier),
      })),
      pullRequestUrls: issue.attachments.nodes.map((node) => node.url).filter((url) => /\/pull\/\d+/.test(url)),
      comments,
      commentCount: conversation.length,
    }
  }

  /**
   * The minimal issue record the write commands need.
   */
  private async issueRef(ref: string): Promise<z.infer<typeof issueRefSchema>["issue"]> {
    return (await this.client.query(ISSUE_REF_QUERY, { id: this.normalizeRef(ref) }, issueRefSchema)).issue
  }

  /**
   * Resolves a state by role or display name against the live team.
   */
  private async resolveState(state: string | StateRole): Promise<WorkflowState> {
    const states = await this.states()
    const asRole = STATE_ROLES.find((role) => role === state)
    const wantedName = (asRole === undefined ? state : this.config.states[asRole]).trim().toLowerCase()
    const found = states.find((candidate) => candidate.name.toLowerCase() === wantedName)
    if (found === undefined) {
      throw new Error(`unknown state "${state}"; the team has: ${states.map((candidate) => candidate.name).join(", ")}`)
    }
    return found
  }

  /**
   * Moves an issue to a state named by role or display name.
   */
  async setState(ref: string, state: string | StateRole): Promise<StateChange> {
    const target = await this.resolveState(state)
    const issue = await this.issueRef(ref)
    assertMayClose(issue.identifier, target.name, target.closed, issue.parent !== null)
    if (issue.state.name === target.name) {
      return { ref: issue.identifier, from: issue.state.name, to: target.name, changed: false }
    }
    const result = await this.client.query(SET_STATE_MUTATION, { id: issue.id, stateId: target.id }, setStateSchema)
    return { ref: issue.identifier, from: issue.state.name, to: result.issueUpdate.issue.state.name, changed: true }
  }

  /**
   * The claim's view of an issue: the delegate, the assignee, and the claim
   * comment if there is one.
   */
  private async claimState(ref: string): Promise<{
    id: string
    identifier: string
    assignee: string | null
    delegate: { id: string; displayName: string } | null
    claim: LinearClaim | null
  }> {
    const { issue } = await this.client.query(ISSUE_CLAIM_QUERY, { id: this.normalizeRef(ref) }, issueClaimSchema)
    return {
      id: issue.id,
      identifier: issue.identifier,
      assignee: issue.assignee?.displayName ?? null,
      delegate: issue.delegate,
      claim: findClaimComment(issue.comments.nodes),
    }
  }

  /**
   * Writes the claim comment, editing the existing one in place when there is
   * one.
   *
   * Editing rather than posting is what makes the comment a heartbeat: its
   * `updatedAt` moves on every re-stamp, which is what staleness is measured
   * on, and a worker running for hours leaves one line on the issue instead of
   * a thread of them.
   */
  private async writeClaimComment(issueId: string, existing: LinearClaim | null, body: string): Promise<void> {
    if (existing === null) {
      await this.client.query(CLAIM_COMMENT_CREATE_MUTATION, { input: { issueId, body } }, claimCommentWriteSchema)
      return
    }
    await this.client.query(CLAIM_COMMENT_UPDATE_MUTATION, { id: existing.commentId, input: { body } }, claimCommentWriteSchema)
  }

  /**
   * Delegates the issue to the role's agent and writes the claim comment.
   *
   * Both halves are last-writer-wins, the same as the GitHub board's text
   * field, so claim right after polling and never from a stale read. The
   * delegate write comes first: if the comment write then fails, the row shows
   * an agent holding it with no session, which the stranded-row scan treats as
   * claimable - the opposite order would leave a claim comment on a row that
   * looks unheld.
   */
  async claim(ref: string, role: ClaimRole, sessionId: string, now: Date): Promise<{ ref: string; claim: string; replaced: Claim | null }> {
    const issue = await this.claimState(ref)
    this.assertDelegateIsOurs(issue.identifier, issue.delegate, "claim")
    await this.client.query(SET_DELEGATE_MUTATION, { id: issue.id, delegateId: this.agentId(agentForClaimRole(role)) }, delegateSchema)
    await this.writeClaimComment(issue.id, issue.claim, formatClaimComment(role, sessionId, now))
    return { ref: issue.identifier, claim: formatClaim(role, sessionId, now), replaced: publicClaim(issue.claim) }
  }

  /**
   * Hands the issue to an agent without claiming it for a session.
   *
   * This is the developer-to-reviewer handoff: the delegate says which agent
   * phase the row is in and survives between sessions, so moving it is how
   * work is queued for the next worker. Any claim comment is removed, because
   * no session holds the row until one claims it.
   */
  async assign(ref: string, agent: AgentRole): Promise<{ ref: string; agent: AgentRole; previous: AgentRole | null; released: Claim | null }> {
    const issue = await this.claimState(ref)
    this.assertDelegateIsOurs(issue.identifier, issue.delegate, `hand to the ${agent}`)
    const previous = agentForDelegateId(this.config.agents, issue.delegate?.id)
    await this.client.query(SET_DELEGATE_MUTATION, { id: issue.id, delegateId: this.agentId(agent) }, delegateSchema)
    if (issue.claim !== null) {
      await this.client.query(CLAIM_COMMENT_DELETE_MUTATION, { id: issue.claim.commentId }, claimCommentDeleteSchema)
    }
    return { ref: issue.identifier, agent, previous, released: publicClaim(issue.claim) }
  }

  /**
   * Clears the delegate and deletes the claim comment.
   *
   * Idempotent, and tolerant of half a claim: a delegate with no comment, or a
   * comment with no delegate, both come back cleanly rather than throwing. The
   * delegate is only cleared when it is one of our agents - if the owner has
   * taken the row over, their delegate and assignee are theirs to keep.
   */
  async release(ref: string): Promise<{ ref: string; released: Claim | null; delegate: AgentRole | null }> {
    const issue = await this.claimState(ref)
    const delegate = agentForDelegateId(this.config.agents, issue.delegate?.id)
    if (delegate !== null) {
      await this.client.query(CLEAR_DELEGATE_MUTATION, { id: issue.id }, delegateSchema)
    }
    if (issue.claim !== null) {
      await this.client.query(CLAIM_COMMENT_DELETE_MUTATION, { id: issue.claim.commentId }, claimCommentDeleteSchema)
    }
    return { ref: issue.identifier, released: publicClaim(issue.claim), delegate }
  }

  /**
   * The configured Linear user id of an agent.
   */
  private agentId(agent: AgentRole): string {
    return this.config.agents[agent]
  }

  /**
   * Refuses to move a delegate that belongs to somebody this dispatcher does
   * not run.
   *
   * A row delegated to another workspace agent is not ours to work, and the
   * three claim operations have to agree about that or the lifecycle
   * contradicts itself: `release` has always left a foreign delegate (and its
   * assignee) alone, so `claim` and `assign` overwriting one without a word
   * would mean we could take a stranger's row but never give it back. Failing
   * loudly here also makes the poll's blind spot harmless - `BoardRow` carries
   * display names rather than ids, so a foreign delegate is told apart by
   * reading the delegate column against the two agent names (the eligibility
   * rule in `dispatcher:start` says so), and if that read ever goes wrong the
   * write is refused rather than silently stealing the row.
   */
  private assertDelegateIsOurs(ref: string, delegate: { id: string; displayName: string } | null, what: string): void {
    if (delegate === null) return
    if (agentForDelegateId(this.config.agents, delegate.id) !== null) return
    throw new Error(
      `refusing to ${what} ${ref}: it is delegated to ${delegate.displayName}, which is not an agent this dispatcher runs - `
      + "clear the delegate in Linear first if the row really is ours to work",
    )
  }

  /**
   * Posts a comment. Every comment goes out under the one Linear account the
   * API key belongs to; the caller prefixes the body with the role that wrote
   * it.
   */
  async comment(ref: string, body: string): Promise<{ ref: string; url: string | null }> {
    const issue = await this.issueRef(ref)
    const result = await this.client.query(COMMENT_MUTATION, { input: { issueId: issue.id, body } }, commentSchema)
    return { ref: issue.identifier, url: result.commentCreate.comment.url }
  }

  /**
   * Adds or removes one workspace label by name.
   */
  async label(ref: string, verb: "add" | "remove", name: string): Promise<string[]> {
    assertLabelInUse(name)
    const labels = (await this.client.query(LABEL_LOOKUP_QUERY, { name }, labelLookupSchema)).issueLabels.nodes
    const label = labels[0]
    if (label === undefined) throw new Error(`no label named "${name}" in the workspace - the owner creates labels`)
    const issue = await this.issueRef(ref)
    const input = verb === "add" ? { addedLabelIds: [label.id] } : { removedLabelIds: [label.id] }
    const result = await this.client.query(LABEL_MUTATION, { id: issue.id, input }, labelMutationSchema)
    return result.issueUpdate.issue.labels.nodes.map((node) => node.name)
  }

  /**
   * The issues a pull request belongs to.
   */
  async resolvePullRequest(pr: PullRequestRef): Promise<LinkedIssue[]> {
    const issues = await resolvePullRequestIssues(this.client, this.config, this.repository, pr)
    return issues.map(({ id: _id, ...issue }) => issue)
  }

  /**
   * Attaches a pull request through the GitHub integration, so Linear tracks
   * it (and completes the issue on merge) exactly as if the branch name had
   * carried the identifier.
   */
  async linkPullRequest(ref: string, prUrl: string): Promise<void> {
    const issue = await this.issueRef(ref)
    await this.client.query(LINK_PR_MUTATION, { issueId: issue.id, url: prUrl }, linkPrSchema)
  }
}
