/**
 * Decision logic for the review-to-board sync: when the owner submits a
 * "Request changes" review on a pull request, the task's board row goes back
 * to `Changes Requested`.
 *
 * Why this exists as a workflow rather than a dispatcher step: promotion to
 * human review is not the end of the review conversation. The owner reviews
 * the PR *after* it lands there, and nothing was reading those reviews - the
 * dispatcher read owner reviews at exactly one moment, deciding whether a
 * `reviewer` PASS could promote. A change request arriving after that
 * checkpoint was invisible, so the row sat at review looking like it awaited
 * a merge that the owner was in fact waiting on the agents for. Three rows
 * stranded that way (#125, #189, #259 on the GitHub board), two of them for
 * two days.
 *
 * Putting it in the dispatcher would have made the fix conditional on a
 * dispatcher session being awake, which is exactly the property that failed.
 * A workflow fires on GitHub's side, whether or not anything local is running.
 * Linear's own GitHub automation cannot do this either: it has states for a
 * PR being opened, reviewed and merged, but no event for a review that
 * requests changes.
 *
 * Two things it has to get right, and the two failure directions cost very
 * different amounts:
 *
 * - **Never roll back a row that is not in the review conversation.** Writing
 *   `Changes Requested` onto a done row reopens finished work; onto an
 *   in-progress row it erases the fact a developer is mid-fix. So the
 *   rollbackable set is named explicitly, by workflow role, and anything else
 *   - including a state added to the board later - is left alone.
 * - **Never act on a bot's review.** The reviewer app is forbidden from posting
 *   `CHANGES_REQUESTED`, but policy is not a mechanism: if that ever changed,
 *   an AI verdict would drive the board without the owner in the loop.
 *
 * The decision logic here is pure and every API call is the caller's, so the
 * rules above are tested rather than trusted. It is written against the
 * platform-neutral board model, so the same workflow runs on either backend.
 */
import type { AgentRole, StateRole } from "./board/types"

/**
 * The only role a change request rolls back on the state alone.
 *
 * Deliberately a small allow-list rather than a deny-list: a state this file
 * has never heard of should be left alone, not rolled back on the assumption
 * it is safe to overwrite.
 */
export const ROLLBACKABLE_ROLES: readonly StateRole[] = ["humanReview"]

/**
 * The agent phase that also rolls back, while the row is `In Progress`.
 *
 * A row under review by the agent reviewer used to sit in its own state, so
 * the state alone said it was in the review conversation. It no longer does:
 * review is now `In Progress` with the row delegated to the reviewer, and the
 * state cannot tell that apart from a developer mid-fix. So the delegate is
 * what decides, and a developer's row is still left alone - erasing the fact
 * that somebody is part-way through a fix is exactly the damage the allow-list
 * above exists to prevent.
 */
export const ROLLBACKABLE_AGENT: AgentRole = "reviewer"

/** A `pull_request_review` delivery, reduced to what the decision needs. */
export interface ReviewEvent {
  /** The webhook action: `submitted`, `edited` or `dismissed`. */
  action: string
  /** The review state, in either the webhook's or the REST API's spelling. */
  reviewState: string
  /** Login of whoever submitted the review, for logging. */
  reviewerLogin: string
  /** Numeric user id of the reviewer; this is what bot detection matches on. */
  reviewerUserId: number
  /** The pull request the review was left on. */
  prNumber: number
  /** The pull request's HTML URL - what Linear's attachments key on. */
  prUrl: string
  /** The PR's head branch, which carries the issue reference by convention. */
  headRef: string
  /** The PR title and body, which may name the issue too. */
  title: string
  body: string
}

/** Why a delivery was ignored. */
export type IgnoreReason = "not-submitted" | "not-a-change-request" | "bot-reviewer"

/** Whether a delivery should drive a board write. */
export type ActDecision = { act: true } | { act: false; reason: IgnoreReason }

/** One issue linked to the PR, with its board state. */
export interface LinkedRow {
  ref: string
  /** Current state display name, for the log. */
  state: string
  stateRole: StateRole | null
  /** Whether the issue is closed. */
  closed: boolean
  /** The agent phase the row is in, which is what marks review while In Progress. */
  agent: AgentRole | null
}

/** A row the plan will move back to `Changes Requested`. */
export interface RollbackMove {
  ref: string
  /** The state it is coming from, for the run's log. */
  from: string
}

/** A row deliberately left alone, with the reason. */
export interface RollbackSkip {
  ref: string
  reason: "issue-closed" | "state-not-rollbackable"
  state: string
}

/** What a sync run should write. */
export interface RollbackPlan {
  moves: RollbackMove[]
  skips: RollbackSkip[]
}

/**
 * Decides whether a `pull_request_review` delivery should move the board.
 *
 * Accepts both spellings of the review state: the webhook payload lowercases
 * it (`changes_requested`) while the REST API returns it upper-cased, and the
 * same logic is reachable from both. `botUserIds` are the agent apps' bot
 * accounts, whose reviews never drive the board.
 */
export function shouldAct(event: ReviewEvent, botUserIds: readonly number[]): ActDecision {
  if (event.action !== "submitted") return { act: false, reason: "not-submitted" }

  if (event.reviewState.toLowerCase() !== "changes_requested") {
    return { act: false, reason: "not-a-change-request" }
  }

  if (botUserIds.some((id) => id === event.reviewerUserId)) {
    return { act: false, reason: "bot-reviewer" }
  }

  return { act: true }
}

/**
 * Whether a row is far enough along to be in the review conversation, and so
 * something a change request should send back.
 */
export function isInReviewConversation(row: Pick<LinkedRow, "stateRole" | "agent">): boolean {
  if (row.stateRole === null) return false
  if (ROLLBACKABLE_ROLES.includes(row.stateRole)) return true
  return row.stateRole === "inProgress" && row.agent === ROLLBACKABLE_AGENT
}

/**
 * Decides what to write for the issues a PR is linked to, without writing
 * anything.
 *
 * A PR may link several issues - the parent task plus legacy sub-issues it
 * also delivers - and only the ones actually in the review conversation come
 * back. Sub-issues are completed as they are implemented, so they fall out on
 * the closed check and the parent is what moves.
 */
export function planRollback(rows: LinkedRow[]): RollbackPlan {
  const moves: RollbackMove[] = []
  const skips: RollbackSkip[] = []

  for (const row of rows) {
    if (row.closed) {
      skips.push({ ref: row.ref, reason: "issue-closed", state: row.state })
      continue
    }
    if (!isInReviewConversation(row)) {
      skips.push({ ref: row.ref, reason: "state-not-rollbackable", state: row.state })
      continue
    }
    moves.push({ ref: row.ref, from: row.state })
  }

  return { moves, skips }
}
