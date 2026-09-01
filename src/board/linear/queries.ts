import { z } from "zod"
import { parseClaimComment } from "../claim-comment"
import type { LinearAgents, LinearConfig } from "../config"
import { STATE_ROLES } from "../types"
import type { AgentRole, BoardRow, Claim, StateRole } from "../types"

/**
 * Linear's shape of the board: the GraphQL documents, their zod schemas, and
 * the reduction of an issue node to a platform-neutral `BoardRow`.
 */

/** Linear state types that mean the issue is closed. */
export const CLOSED_STATE_TYPES = ["completed", "canceled", "duplicate"] as const

/**
 * URL prefix of the claim attachment the dispatcher used until claims moved
 * onto agent delegation.
 *
 * Nothing writes these any more. The prefix survives only so the listener's
 * link diff ignores any that are still lying around on old issues, which would
 * otherwise read as a link change the first time one is tidied up.
 */
export const LEGACY_CLAIM_URL_PREFIX = "dispatcher://claim/"

/**
 * How many comments to scan for the claim comment.
 *
 * `orderBy: updatedAt` returns comments **newest-updated first** - verified
 * against the live API rather than assumed, because the direction is what
 * makes this bound safe: a live claim is re-stamped in place, so it sits at
 * the front however old the issue is, and only an issue with more than this
 * many comments *all* updated more recently than its claim could hide one.
 */
export const CLAIM_COMMENT_SCAN = 50

/**
 * Whether a state type counts as closed.
 */
export function isClosedStateType(type: string): boolean {
  return CLOSED_STATE_TYPES.some((closed) => closed === type)
}

/**
 * The workflow role a state name plays, from the config, or null.
 */
export function roleForStateName(config: LinearConfig, name: string): StateRole | null {
  const wanted = name.trim().toLowerCase()
  return STATE_ROLES.find((role) => config.states[role].toLowerCase() === wanted) ?? null
}

/** One attachment on an issue, as the poll reads it. */
export const attachmentSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  updatedAt: z.string(),
})

/** A related issue's state, enough to tell whether it is still open. */
const relatedStateSchema = z.object({ name: z.string(), type: z.string() })

/** An issue as the board poll returns it. */
export const issueNodeSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  sortOrder: z.number(),
  updatedAt: z.string(),
  state: relatedStateSchema,
  assignee: z.object({ displayName: z.string() }).nullable(),
  delegate: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  projectMilestone: z.object({ name: z.string() }).nullable(),
  parent: z.object({
    identifier: z.string(),
    projectMilestone: z.object({ name: z.string() }).nullable(),
  }).nullable(),
  children: z.object({ nodes: z.array(z.object({ identifier: z.string(), state: relatedStateSchema })) }),
  inverseRelations: z.object({
    nodes: z.array(z.object({
      type: z.string(),
      issue: z.object({ identifier: z.string(), state: relatedStateSchema }),
    })),
  }),
  attachments: z.object({ nodes: z.array(attachmentSchema) }),
})

export type IssueNode = z.infer<typeof issueNodeSchema>

/** A paginated `issues` result. */
export const issuePageSchema = z.object({
  issues: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(issueNodeSchema),
  }),
})

export type AttachmentNode = z.infer<typeof attachmentSchema>

/** A page of issues as `ISSUES_QUERY` returns it. */
export type IssuePage = z.infer<typeof issuePageSchema>

/**
 * The fields every board query selects on an issue; keep in sync with
 * `issueNodeSchema`.
 *
 * `delegate` is one cheap object per issue and is deliberately the only thing
 * the poll learns about claims here: the rest of a claim lives in a comment,
 * and selecting comments on a 250-issue board query would pull every comment
 * body on the board to find the handful that are claims. The poll fetches
 * those separately, for delegated rows only.
 */
export const ISSUE_NODE_FIELDS = `
  id identifier title url sortOrder updatedAt
  state { name type }
  assignee { displayName }
  delegate { id displayName }
  labels { nodes { name } }
  projectMilestone { name }
  parent { identifier projectMilestone { name } }
  children { nodes { identifier state { name type } } }
  inverseRelations { nodes { type issue { identifier state { name type } } } }
  attachments { nodes { id url title subtitle updatedAt } }
`

/** One page of board issues, filtered server-side. */
export const ISSUES_QUERY = `
query($filter: IssueFilter!, $after: String) {
  issues(first: 50, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ISSUE_NODE_FIELDS} }
  }
}`

/** The team's workflow states. */
export const TEAM_STATES_QUERY = `
query($teamId: String!) {
  team(id: $teamId) { states { nodes { id name type position } } }
}`

export const teamStatesSchema = z.object({
  team: z.object({
    states: z.object({
      nodes: z.array(z.object({ id: z.string(), name: z.string(), type: z.string(), position: z.number() })),
    }),
  }),
})

/**
 * One comment, as the claim lookup reads it.
 *
 * Deliberately just the id and the body. The comment's own `updatedAt` is what
 * the connection is *ordered* by, but it is never read: everything the claim
 * says, the heartbeat included, comes out of the body the claiming worker
 * wrote.
 */
export const claimCommentNodeSchema = z.object({
  id: z.string(),
  body: z.string(),
})

export type ClaimCommentNode = z.infer<typeof claimCommentNodeSchema>

/** A claim as Linear stores it: the shared claim plus the comment to edit or delete. */
export interface LinearClaim extends Claim {
  commentId: string
}

/**
 * How many delegated issues one claim-comments query asks about.
 *
 * The `issues` selection there is filtered to a named set of ids, so its size
 * is known up front and no cursor loop is needed - but it still has to pass an
 * explicit `first`, or it silently takes Linear's default page size of 50 and
 * every delegated row past the fiftieth reads as unclaimed and stealable.
 * Delegates outlive claims (a row handed to the reviewer keeps its delegate
 * until it is released), so more than 50 at once is reachable. 250 is Linear's
 * maximum page size; ids beyond that are asked for in further batches.
 */
export const CLAIM_COMMENT_ID_BATCH = 250

/** Claim comments for a named set of issues - the poll's second query. */
export const CLAIM_COMMENTS_QUERY = `
query($ids: [ID!], $first: Int!) {
  issues(first: $first, filter: { id: { in: $ids } }) {
    nodes { id comments(first: ${CLAIM_COMMENT_SCAN}, orderBy: updatedAt) { nodes { id body } } }
  }
}`

/**
 * Splits issue ids into batches a single claim-comments query can carry.
 */
export function claimCommentIdBatches(ids: string[], size = CLAIM_COMMENT_ID_BATCH): string[][] {
  const batches: string[][] = []
  for (let index = 0; index < ids.length; index += size) batches.push(ids.slice(index, index + size))
  return batches
}

export const claimCommentsSchema = z.object({
  issues: z.object({
    nodes: z.array(z.object({
      id: z.string(),
      comments: z.object({ nodes: z.array(claimCommentNodeSchema) }),
    })),
  }),
})

/**
 * Finds the dispatcher's claim comment among an issue's comments, or null.
 *
 * Everything the claim says comes out of the body: the role, the session, and
 * the stamp staleness is measured on. Nothing is taken from the comment's own
 * `updatedAt` - re-stamping edits the comment in place, and reading the
 * heartbeat off a field Linear maintains would make the whole mechanism rest
 * on how it timestamps such an edit. The comment id is kept so the next
 * re-stamp or release can address it.
 */
export function findClaimComment(comments: ClaimCommentNode[]): LinearClaim | null {
  for (const comment of comments) {
    const parsed = parseClaimComment(comment.body)
    if (parsed === null) continue
    return {
      role: parsed.role,
      sessionId: parsed.sessionId,
      stampedAt: parsed.stampedAt,
      commentId: comment.id,
    }
  }
  return null
}

/**
 * The agent role a delegate id belongs to, or null when the issue is
 * delegated to somebody the dispatcher does not run.
 */
export function agentForDelegateId(agents: LinearAgents, delegateId: string | null | undefined): AgentRole | null {
  if (delegateId == null) return null
  if (delegateId === agents.developer) return "developer"
  if (delegateId === agents.reviewer) return "reviewer"
  return null
}

/**
 * GitHub pull request URLs attached to an issue - the Linear GitHub
 * integration adds one per linked PR, and `link-pr` adds them by hand.
 */
export function linkedPullRequestUrls(issue: Pick<IssueNode, "attachments">): string[] {
  return issue.attachments.nodes
    .map((node) => node.url)
    .filter((url) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url))
}

/**
 * The GitHub issue this Linear issue was imported from, as its number, or
 * null for an issue created natively in Linear. Every imported issue carries a
 * `GitHub #N` link attachment.
 */
export function importedGitHubIssueNumber(issue: Pick<IssueNode, "attachments">): number | null {
  for (const node of issue.attachments.nodes) {
    const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(node.url)
    if (match?.[1] !== undefined) return Number(match[1])
  }
  return null
}

/**
 * Reduces an issue node to a board row.
 *
 * The claim is passed in rather than read off the node: it lives in a comment,
 * which the poll fetches in a separate query for delegated rows only, so the
 * node alone cannot know it. The comment id it came from stays with the
 * backend.
 */
export function toBoardRow(issue: IssueNode, config: LinearConfig, claim: Claim | null = null): BoardRow {
  return {
    ref: issue.identifier,
    title: issue.title,
    url: issue.url,
    sortIndex: issue.sortOrder,
    state: issue.state.name,
    stateRole: roleForStateName(config, issue.state.name),
    closed: isClosedStateType(issue.state.type),
    milestone: issue.projectMilestone?.name ?? null,
    assignee: issue.assignee?.displayName ?? null,
    delegate: issue.delegate?.displayName ?? null,
    labels: issue.labels.nodes.map((label) => label.name),
    claim,
    openBlockers: issue.inverseRelations.nodes
      .filter((relation) => relation.type === "blocks" && !isClosedStateType(relation.issue.state.type))
      .map((relation) => relation.issue.identifier),
    pullRequests: linkedPullRequestUrls(issue).map((url) => Number(url.split("/pull/")[1]?.split(/[^0-9]/)[0])),
    parent: issue.parent === null
      ? null
      : { ref: issue.parent.identifier, milestone: issue.parent.projectMilestone?.name ?? null },
    children: issue.children.nodes.length === 0
      ? null
      : {
        closed: issue.children.nodes.filter((child) => isClosedStateType(child.state.type)).length,
        total: issue.children.nodes.length,
      },
    githubIssue: importedGitHubIssueNumber(issue),
  }
}
