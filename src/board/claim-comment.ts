import { CLAIM_ROLES, formatClaimStamp } from "./claims"
import type { AgentRole, ClaimRole } from "./types"

/**
 * The dispatcher's claim comment: the machine-readable half of a claim.
 *
 * A claim is split across two places on Linear. `Issue.delegate` is the
 * visible half - it puts the owning agent in Linear's assignee UI, which is
 * the whole point of delegating rather than parking a fake link on the issue.
 * But the delegate cannot carry the whole claim, for two reasons: there are
 * three worker roles and only two agent identities (`dev` and `cleanup` both
 * run as the developer, mirroring the GitHub apps, where the cleaner already
 * commits under the developer app), and a `User` has nowhere to record which
 * Claude session is holding the row.
 *
 * So the rest of the claim lives in one comment on the issue, carrying the
 * role, the minute it was stamped, and the session id. Re-stamping edits that
 * comment in place rather than posting another, so a long-running worker
 * leaves one line on the issue instead of a thread of them.
 *
 * The format is deliberately a sentence a human can act on rather than an
 * encoded blob, because the owner reads it in Linear:
 *
 * ```
 * **[developer]** claimed 2026-08-27T14:05Z · `claude --resume eded70f3-9199-411f-b7a0-62a6df8eabb4`
 * ```
 *
 * The role tag matches what `just board comment --as <role>` writes, so agent
 * comments all read the same way; the word `claimed` after the tag is what
 * separates a claim from an ordinary role-tagged comment, and is what the
 * parser keys on. The resume command stays last and unbroken so the line can
 * be copy-pasted straight out of Linear.
 *
 * **The timestamp is load-bearing, not decoration.** Staleness is measured on
 * it (`claimAgeMinutes`), which is the whole point: the heartbeat is a value
 * this codebase writes and reads, so it does not rest on how a tracker treats
 * the `updatedAt` of a comment edited in place - behaviour we cannot verify
 * and whose failure mode is silent. Without it a re-stamp wrote a
 * byte-identical body, and if such an update did not move the platform's own
 * timestamp, a live claim would age past the staleness window, a second
 * dispatcher would read it as a dead session's and steal it, and two workers
 * would land on one row: the single failure the claim exists to prevent.
 */

/** The comment tag each worker role writes, matching `just board comment --as`. */
export const CLAIM_ROLE_TAGS: Record<ClaimRole, string> = {
  dev: "developer",
  review: "reviewer",
  cleanup: "cleaner",
}

/**
 * The agent identity a worker role runs as.
 *
 * Two identities for three roles: cleanup work is developer work (it resolves
 * conflicts and pushes commits), so it delegates to the developer agent, the
 * same way the cleaner already commits under the developer GitHub App. The
 * role itself is never lost - the claim comment carries it.
 */
export function agentForClaimRole(role: ClaimRole): AgentRole {
  return role === "review" ? "reviewer" : "developer"
}

/**
 * Formats the claim comment for a role, session and moment.
 *
 * `now` is what makes a re-stamp a real edit: the body differs from the last
 * one as soon as the UTC minute has moved, so re-stamping is never a write
 * that changes nothing.
 */
export function formatClaimComment(role: ClaimRole, sessionId: string, now: Date): string {
  return `**[${CLAIM_ROLE_TAGS[role]}]** claimed ${formatClaimStamp(now)} · \`claude --resume ${sessionId}\``
}

/** Matches a claim comment and captures its role tag, stamp and session id. */
const CLAIM_COMMENT_PATTERN = /^\*\*\[([a-z]+)\]\*\* claimed (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z) · `claude --resume ([^`]+)`$/

/**
 * Parses a claim comment back to its role, stamp and session, or null when the
 * body is any other comment - an ordinary role-tagged agent comment, one of
 * the owner's, or a claim written in a format this parser does not know.
 *
 * A line with no parsable stamp is not a claim. That is the safe direction: a
 * claim whose age cannot be read would otherwise have to be treated as either
 * forever-live (nobody could ever take the row back) or forever-stale (anybody
 * could steal it from a live worker), and neither is a state to leave a board
 * in. Reading it as "no claim" makes the row claimable, and the next claim
 * writes a body this parser does understand.
 */
export function parseClaimComment(body: string | null | undefined): { role: ClaimRole; sessionId: string; stampedAt: string } | null {
  if (body == null) return null
  const match = CLAIM_COMMENT_PATTERN.exec(body.trim())
  if (match === null) return null
  const [, tag, stampedAt, sessionId] = match
  if (tag === undefined || stampedAt === undefined || sessionId === undefined) return null
  const role = CLAIM_ROLES.find((candidate) => CLAIM_ROLE_TAGS[candidate] === tag)
  if (role === undefined) return null
  return { role, sessionId, stampedAt }
}

/**
 * Whether a comment body is the dispatcher's claim comment rather than part
 * of the issue's conversation. Used to keep claim comments out of worker
 * prompts and out of the listener's comment events, so the dispatcher is never
 * woken by its own heartbeat.
 */
export function isClaimComment(body: string | null | undefined): boolean {
  return parseClaimComment(body) !== null
}
