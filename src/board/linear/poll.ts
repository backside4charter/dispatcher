import { z } from "zod"
import type { BoardEvent } from "../../board-events"
import { isClaimComment } from "../claim-comment"
import type { LinearGraphql } from "./client"
import { CLOSED_STATE_TYPES, ISSUES_QUERY, LEGACY_CLAIM_URL_PREFIX, issuePageSchema } from "./queries"
import type { IssueNode, IssuePage } from "./queries"

/**
 * Linear side of the dispatcher's event channel.
 *
 * GitHub deliveries reach the listener through `gh webhook forward`, which
 * needs no public ingress. Linear webhooks do need one, so the board is
 * watched by polling instead: every interval the listener asks Linear for
 * the project's issues updated since the last poll, diffs the fields the
 * dispatcher routes on against a cache, and appends one event per real
 * change. New comments are fetched the same way. The dispatcher's `wait`
 * primitive then wakes on the appended events exactly as it does for a
 * webhook delivery.
 *
 * Three things keep this from waking the dispatcher on its own writes:
 * - the claim comment is not reported as a comment. The dispatcher re-stamps
 *   it every firing as a heartbeat, and an edit does not change `createdAt`,
 *   so the comment query would not return it anyway - but the first write of
 *   one would, and a "somebody commented" event for the dispatcher's own claim
 *   is noise at best and a spurious wake at worst;
 * - the link diff ignores leftover claim attachments from the mechanism claims
 *   used before delegation, so tidying one up is not read as a link change;
 * - state and delegate writes the dispatcher makes do echo back as events
 *   (delegating also moves the assignee, which is a routed field); the
 *   resulting extra firing is cheap and expected - it polls, finds nothing
 *   new, and re-arms.
 */

/** The dispatcher-relevant view of one issue, compared poll to poll. */
export interface IssueSnapshot {
  id: string
  identifier: string
  title: string
  state: string
  closed: boolean
  assignee: string | null
  labels: string[]
  milestone: string | null
  sortOrder: number
  parent: string | null
  /** Non-claim attachment URLs, sorted - a newly linked PR is a change. */
  links: string[]
  updatedAt: string
}

/**
 * Reduces an issue node to its snapshot.
 */
export function snapshotOf(issue: IssueNode): IssueSnapshot {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    closed: CLOSED_STATE_TYPES.some((type) => type === issue.state.type),
    assignee: issue.assignee?.displayName ?? null,
    labels: issue.labels.nodes.map((label) => label.name).sort(),
    milestone: issue.projectMilestone?.name ?? null,
    sortOrder: issue.sortOrder,
    parent: issue.parent?.identifier ?? null,
    links: issue.attachments.nodes.map((node) => node.url).filter((url) => !url.startsWith(LEGACY_CLAIM_URL_PREFIX)).sort(),
    updatedAt: issue.updatedAt,
  }
}

/**
 * Describes what changed between two snapshots of the same issue, as short
 * labels, or an empty list when nothing the dispatcher routes on changed.
 */
export function describeChanges(before: IssueSnapshot, after: IssueSnapshot): string[] {
  const changes: string[] = []
  if (before.state !== after.state) changes.push(`state ${before.state} -> ${after.state}`)
  if (before.assignee !== after.assignee) changes.push(`assignee ${before.assignee ?? "-"} -> ${after.assignee ?? "-"}`)
  if (before.labels.join(",") !== after.labels.join(",")) changes.push(`labels ${after.labels.join(",") || "-"}`)
  if (before.milestone !== after.milestone) changes.push(`milestone ${before.milestone ?? "-"} -> ${after.milestone ?? "-"}`)
  if (before.sortOrder !== after.sortOrder) changes.push("reordered")
  if (before.parent !== after.parent) changes.push(`parent ${before.parent ?? "-"} -> ${after.parent ?? "-"}`)
  if (before.links.join(" ") !== after.links.join(" ")) changes.push("links changed")
  if (before.title !== after.title) changes.push("retitled")
  return changes
}

/** The result of diffing one poll against the cache. */
export interface SnapshotDiff {
  /** Event summaries, one per issue that changed or appeared. */
  summaries: string[]
  /** The cache to carry into the next poll. */
  next: Map<string, IssueSnapshot>
}

/**
 * Diffs freshly fetched snapshots against the cache. An unknown open issue is
 * reported as created (with its state), a known one only when a routed field
 * changed. An unknown *closed* issue is cached silently: the baseline holds
 * open issues only, so a closed issue touched after the listener started is
 * routinely "unknown" without anything dispatcher-relevant having happened.
 * The returned cache carries every incoming snapshot forward, so nothing is
 * re-reported as created if it is touched again.
 */
export function diffSnapshots(cache: Map<string, IssueSnapshot>, incoming: IssueSnapshot[]): SnapshotDiff {
  const next = new Map(cache)
  const summaries: string[] = []
  for (const snapshot of incoming) {
    const previous = cache.get(snapshot.id)
    if (previous === undefined) {
      if (!snapshot.closed) summaries.push(`linear ${snapshot.identifier} created (${snapshot.state}): ${snapshot.title}`)
    } else {
      const changes = describeChanges(previous, snapshot)
      if (changes.length > 0) summaries.push(`linear ${snapshot.identifier} ${changes.join("; ")}: ${snapshot.title}`)
    }
    next.set(snapshot.id, snapshot)
  }
  return { summaries, next }
}

/** Comments created since the last poll. */
export const RECENT_COMMENTS_QUERY = `
query($filter: CommentFilter!, $after: String) {
  comments(first: 50, after: $after, filter: $filter, orderBy: createdAt) {
    pageInfo { hasNextPage endCursor }
    nodes { id body createdAt user { displayName } issue { identifier } }
  }
}`

const commentPageSchema = z.object({
  comments: z.object({
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    nodes: z.array(z.object({
      id: z.string(),
      body: z.string(),
      createdAt: z.string(),
      user: z.object({ displayName: z.string() }).nullable(),
      issue: z.object({ identifier: z.string() }).nullable(),
    })),
  }),
})

/**
 * Renders a comment as a one-line event summary.
 */
export function summarizeComment(comment: { body: string; user: { displayName: string } | null; issue: { identifier: string } | null }): string {
  const firstLine = comment.body.split("\n").find((line) => line.trim() !== "")?.trim() ?? ""
  const excerpt = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine
  return `linear comment on ${comment.issue?.identifier ?? "?"} by ${comment.user?.displayName ?? "unknown"}: ${excerpt}`
}

/** Health of the Linear poller, published in the listener heartbeat. */
export interface LinearPollState {
  /** Whether polling was requested at all (false without an API key, with --no-linear, or on another platform). */
  enabled: boolean
  /** Whether the poller is currently running. */
  running: boolean
  /** Completed polls since start. */
  polls: number
  /** Polls that failed since start. */
  errors: number
  /** When the last successful poll finished, or null. */
  lastPollAt: string | null
  /** The most recent failure, or null. */
  lastError: string | null
}

/** Options for the poller. */
export interface LinearPollerOptions {
  client: LinearGraphql
  projectId: string
  intervalMs: number
  /** Receives every accepted event, in order. */
  onEvent: (event: BoardEvent) => void
  /** Receives the poller's health after every change to it. */
  onState: (state: LinearPollState) => void
  /** Clock override for tests. */
  now?: () => Date
}

/** A running poller. */
export interface LinearPoller {
  /** Loads the baseline and starts the interval. Never throws: a failed baseline is retried by the next poll. */
  start: () => Promise<void>
  /** Runs one poll immediately (the interval calls this). */
  pollOnce: () => Promise<void>
  /** Stops the interval. */
  stop: () => void
}

/**
 * Fetches every page of the issues query for a filter.
 */
async function fetchIssues(client: LinearGraphql, filter: Record<string, unknown>): Promise<IssueNode[]> {
  const nodes: IssueNode[] = []
  let after: string | null = null
  for (;;) {
    const page: IssuePage = await client.query(ISSUES_QUERY, { filter, after }, issuePageSchema)
    nodes.push(...page.issues.nodes)
    if (!page.issues.pageInfo.hasNextPage || page.issues.pageInfo.endCursor === null) return nodes
    after = page.issues.pageInfo.endCursor
  }
}

/**
 * The latest ISO timestamp among the given ones, or the fallback when there
 * are none. The fallback never competes with a real timestamp: the cursor
 * must follow Linear's clock, not the listener's, or a local clock running
 * ahead would skip every change made in the gap.
 */
export function latestOf(timestamps: string[], fallback: string): string {
  const [first, ...rest] = timestamps
  if (first === undefined) return fallback
  let latest = first
  for (const timestamp of rest) {
    if (Date.parse(timestamp) > Date.parse(latest)) latest = timestamp
  }
  return latest
}

/**
 * Creates the Linear poller.
 *
 * Features:
 * - Baseline on start: every open issue in the project is snapshotted
 *   silently, so the first poll reports only what changed after the listener
 *   came up rather than replaying the whole board.
 * - Each poll asks for issues whose `updatedAt` is later than the latest one
 *   seen, which is skew-proof (Linear's clock on both sides), and diffs them.
 * - Comments are polled by `createdAt` from the listener's start time.
 * - Failures are recorded in the poll state and the next interval retries;
 *   a Linear outage degrades the channel to polling latency, never crashes
 *   the listener.
 */
export function createLinearPoller(options: LinearPollerOptions): LinearPoller {
  const { client, projectId, intervalMs, onEvent, onState, now = () => new Date() } = options
  const state: LinearPollState = {
    enabled: true, running: false, polls: 0, errors: 0, lastPollAt: null, lastError: null,
  }
  let cache = new Map<string, IssueSnapshot>()
  let issuesSince: string | null = null
  let commentsSince: string = now().toISOString()
  let timer: NodeJS.Timeout | null = null
  let inFlight: Promise<void> | null = null

  const publish = (): void => { onState({ ...state }) }

  /**
   * Records a failure without throwing.
   */
  const fail = (error: unknown): void => {
    state.errors += 1
    state.lastError = error instanceof Error ? error.message : String(error)
    publish()
  }

  /**
   * Emits one event.
   */
  const emit = (event: string, action: string, summary: string): void => {
    onEvent({ receivedAt: now().toISOString(), event, action, summary })
  }

  /**
   * Loads the baseline: every open issue, snapshotted without events.
   */
  const loadBaseline = async (): Promise<void> => {
    const nodes = await fetchIssues(client, {
      project: { id: { eq: projectId } },
      state: { type: { nin: [...CLOSED_STATE_TYPES] } },
    })
    const snapshots = nodes.map(snapshotOf)
    cache = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
    issuesSince = latestOf(snapshots.map((snapshot) => snapshot.updatedAt), now().toISOString())
  }

  /**
   * One poll: changed issues, then new comments.
   */
  const poll = async (): Promise<void> => {
    if (issuesSince === null) await loadBaseline()
    const since = issuesSince
    if (since === null) return

    const changed = await fetchIssues(client, {
      project: { id: { eq: projectId } },
      updatedAt: { gt: since },
    })
    const snapshots = changed.map(snapshotOf)
    const diff = diffSnapshots(cache, snapshots)
    cache = diff.next
    issuesSince = latestOf([...snapshots.map((snapshot) => snapshot.updatedAt), since], since)
    for (const summary of diff.summaries) emit("linear_issue", "changed", summary)

    const commentFilter = {
      issue: { project: { id: { eq: projectId } } },
      createdAt: { gt: commentsSince },
    }
    let after: string | null = null
    for (;;) {
      const page: z.infer<typeof commentPageSchema> = await client.query(RECENT_COMMENTS_QUERY, { filter: commentFilter, after }, commentPageSchema)
      for (const comment of page.comments.nodes) {
        // The dispatcher's own claim comment is bookkeeping, not conversation.
        if (!isClaimComment(comment.body)) emit("linear_comment", "created", summarizeComment(comment))
        commentsSince = latestOf([comment.createdAt, commentsSince], commentsSince)
      }
      if (!page.comments.pageInfo.hasNextPage || page.comments.pageInfo.endCursor === null) break
      after = page.comments.pageInfo.endCursor
    }

    state.polls += 1
    state.lastPollAt = now().toISOString()
    publish()
  }

  /**
   * Runs a poll unless one is already in flight (a slow Linear response must
   * not stack polls).
   */
  const pollOnce = async (): Promise<void> => {
    if (inFlight !== null) return inFlight
    inFlight = poll().catch(fail).finally(() => { inFlight = null })
    return inFlight
  }

  return {
    start: async () => {
      state.running = true
      publish()
      try {
        await loadBaseline()
      } catch (error) {
        fail(error)
      }
      timer = setInterval(() => { void pollOnce() }, intervalMs)
    },
    pollOnce,
    stop: () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      state.running = false
      publish()
    },
  }
}
