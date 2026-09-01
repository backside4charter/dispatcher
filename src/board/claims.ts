import type { Claim, ClaimRole } from "./types"

/**
 * Claim text, shared by every platform: `<role>:<session-id>@<UTC minute>`.
 *
 * Where a claim lives differs - a Projects v2 text field on GitHub, an agent
 * delegation plus one claim comment on Linear (see `claim-comment.ts`) - but
 * what it says does not, so a claim renders the same in a status line
 * whichever board wrote it. This is the rendering and staleness half; the
 * Linear comment's own wording lives next door.
 */

/** A claim older than this belongs to a session that died. */
export const CLAIM_STALE_MINUTES = 90

export const CLAIM_ROLES: readonly ClaimRole[] = ["dev", "review", "cleanup"]

/**
 * Checks whether a string is one of the claim roles.
 */
export function isClaimRole(value: string): value is ClaimRole {
  return CLAIM_ROLES.some((role) => role === value)
}

/**
 * Formats the timestamp a claim carries: the UTC minute, `2026-08-27T14:05Z`.
 *
 * Minute precision on purpose. It is a timestamp a human reads off the board,
 * and it is what the staleness window (90 minutes) is measured against, so
 * seconds would be noise. Every claim on every platform writes this string
 * into its own text, which is what makes the heartbeat independent of any
 * field the tracker maintains.
 */
export function formatClaimStamp(now: Date): string {
  return `${now.toISOString().slice(0, 16)}Z`
}

/**
 * Formats claim text: `dev:<session-id>@2026-08-27T14:05Z`.
 */
export function formatClaim(role: ClaimRole, sessionId: string, now: Date): string {
  return `${role}:${sessionId}@${formatClaimStamp(now)}`
}

/**
 * Parses claim text back, or null when it is not a claim.
 */
export function parseClaimText(text: string | null | undefined): Claim | null {
  if (text == null) return null
  const match = /^(dev|review|cleanup):([^@]+)@(.+)$/.exec(text.trim())
  if (match === null) return null
  const [, role, sessionId, stampedAt] = match
  if (role === undefined || !isClaimRole(role) || sessionId === undefined || stampedAt === undefined) return null
  return { role, sessionId, stampedAt }
}

/**
 * Age of a claim in whole minutes, from the stamp the claim itself carries.
 *
 * Measured on `stampedAt` - the minute the claiming worker wrote into the
 * claim text - and deliberately not on any timestamp the tracker maintains.
 * Every re-stamp rewrites that text, so the heartbeat is a value this codebase
 * writes and reads, with no dependency on how a platform treats the
 * `updatedAt` of a record that is edited in place. Getting that wrong in the
 * safe-looking direction is expensive: a live claim that stops ageing forward
 * goes stale, a second dispatcher steals it, and two workers land on one row.
 */
export function claimAgeMinutes(claim: Pick<Claim, "stampedAt">, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(claim.stampedAt)) / 60_000)
}

/**
 * Whether a claim is stale: older than the staleness window. A claim from the
 * caller's own session is never stale - that is a worker this session is
 * still running.
 */
export function isClaimStale(claim: Claim, now: Date, ownSessionId?: string, staleMinutes = CLAIM_STALE_MINUTES): boolean {
  if (ownSessionId !== undefined && claim.sessionId === ownSessionId) return false
  return claimAgeMinutes(claim, now) >= staleMinutes
}

/**
 * Renders a claim for a status line or TSV cell.
 */
export function formatClaimText(claim: Claim): string {
  return `${claim.role}:${claim.sessionId}@${claim.stampedAt}`
}

/**
 * Resolves the claiming session id: an explicit value, else
 * CLAUDE_CODE_SESSION_ID, else an `unknown-<random>` marker so the claim is
 * still attributable to one process.
 */
export function resolveSessionId(explicit: string | undefined, env: Record<string, string | undefined>): string {
  if (explicit !== undefined && explicit !== "") return explicit
  const fromEnv = env.CLAUDE_CODE_SESSION_ID
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return `unknown-${Math.random().toString(36).slice(2, 8)}`
}
