import { z } from "zod"
import type { DeliveryMapping } from "../../board-events"

/**
 * Webhook mapping for the GitHub Projects v2 board: the events that carry a
 * board change when the board itself lives on GitHub. Only subscribed when
 * the configured platform is `github`; on Linear the equivalent signal comes
 * from the Linear poller.
 */

/**
 * Webhook events the forwarder subscribes to for the GitHub board, on top of
 * the pull request events every platform needs. `projects_v2_item`
 * (org-level) is the one that carries board Status moves.
 */
export const GITHUB_BOARD_FORWARD_EVENTS = [
  "projects_v2_item",
  "issues",
  "issue_comment",
  "sub_issues",
] as const

/**
 * Board fields whose edits are dropped: the dispatcher re-stamps Claimed By on
 * every firing as a claim heartbeat, so logging those edits would let the
 * dispatcher wake itself in a loop.
 */
const IGNORED_BOARD_FIELDS = new Set(["Claimed By"])

const payloadSchema = z.object({
  changes: z.object({
    field_value: z.object({
      field_name: z.string().nullish(),
      field_type: z.string().nullish(),
      from: z.object({ name: z.string().nullish() }).nullish(),
      to: z.object({ name: z.string().nullish() }).nullish(),
    }).nullish(),
  }).nullish(),
  issue: z.object({
    number: z.number(),
    title: z.string().nullish(),
  }).nullish(),
  comment: z.object({
    user: z.object({ login: z.string().nullish() }).nullish(),
  }).nullish(),
  label: z.object({ name: z.string().nullish() }).nullish(),
  milestone: z.object({ title: z.string().nullish() }).nullish(),
  repository: z.object({ full_name: z.string().nullish() }).nullish(),
  parent_issue: z.object({
    number: z.number().nullish(),
    title: z.string().nullish(),
  }).nullish(),
})

type Payload = z.infer<typeof payloadSchema>

/** projects_v2_item actions worth waking the dispatcher for. */
const BOARD_ITEM_ACTIONS = new Set(["created", "edited", "deleted", "archived", "restored", "reordered", "converted"])

/** issues actions worth waking the dispatcher for. */
const ISSUE_ACTIONS = new Set(["closed", "reopened", "labeled", "unlabeled", "milestoned", "demilestoned"])

/**
 * Renders " [repo]" from a payload's repository, or "" when absent.
 */
function repoSuffix(payload: Payload): string {
  const fullName = payload.repository?.full_name
  if (!fullName) return ""
  const short = fullName.split("/").pop() ?? fullName
  return ` [${short}]`
}

/**
 * Maps a projects_v2_item delivery to a board event.
 */
function mapProjectsV2Item(action: string, payload: Payload): DeliveryMapping {
  if (!BOARD_ITEM_ACTIONS.has(action)) {
    return { accepted: false, reason: `unsupported projects_v2_item action: ${action}` }
  }
  if (action !== "edited") {
    return { accepted: true, action, summary: `board item ${action}` }
  }
  const fieldValue = payload.changes?.field_value
  const fieldName = fieldValue?.field_name ?? null
  if (fieldName !== null && IGNORED_BOARD_FIELDS.has(fieldName)) {
    return { accepted: false, reason: `${fieldName} edit (dispatcher claim heartbeat)` }
  }
  const from = fieldValue?.from?.name
  const to = fieldValue?.to?.name
  const transition = from && to ? ` (${from} -> ${to})` : ""
  return {
    accepted: true,
    action,
    summary: `board item edited: ${fieldName ?? "unknown field"}${transition}`,
  }
}

/**
 * Maps an issue_comment delivery to a board event.
 */
function mapIssueComment(action: string, payload: Payload): DeliveryMapping {
  if (action !== "created") {
    return { accepted: false, reason: `unsupported issue_comment action: ${action}` }
  }
  const issue = payload.issue
  if (!issue) return { accepted: false, reason: "malformed payload" }
  const login = payload.comment?.user?.login ?? "unknown"
  return {
    accepted: true,
    action,
    summary: `comment on #${issue.number} by ${login}${repoSuffix(payload)}`,
  }
}

/**
 * Maps an issues delivery to a board event.
 */
function mapIssues(action: string, payload: Payload): DeliveryMapping {
  if (!ISSUE_ACTIONS.has(action)) {
    return { accepted: false, reason: `unsupported issues action: ${action}` }
  }
  const issue = payload.issue
  if (!issue) return { accepted: false, reason: "malformed payload" }
  let detail = ""
  if ((action === "labeled" || action === "unlabeled") && payload.label?.name) {
    detail = ` "${payload.label.name}"`
  }
  if (action === "milestoned" && payload.milestone?.title) {
    detail = ` "${payload.milestone.title}"`
  }
  return {
    accepted: true,
    action,
    summary: `issue #${issue.number} ${action}${detail}${repoSuffix(payload)}`,
  }
}

/**
 * Maps a sub_issues delivery (sub-issue tree change) to a board event.
 */
function mapSubIssues(action: string, payload: Payload): DeliveryMapping {
  const parentNumber = payload.parent_issue?.number
  if (parentNumber === null || parentNumber === undefined) {
    return { accepted: false, reason: "malformed payload" }
  }
  return {
    accepted: true,
    action,
    summary: `sub-issues ${action} on #${parentNumber}${repoSuffix(payload)}`,
  }
}

/**
 * Maps a GitHub-board webhook delivery (already known not to be from a bot)
 * to a board event, or drops it. Returns null for an event this mapper does
 * not handle at all.
 */
export function mapGitHubBoardDelivery(eventName: string, action: string, payload: unknown): DeliveryMapping | null {
  const parsed = payloadSchema.safeParse(payload)
  if (!parsed.success) return { accepted: false, reason: "malformed payload" }
  switch (eventName) {
    case "projects_v2_item":
      return mapProjectsV2Item(action, parsed.data)
    case "issue_comment":
      return mapIssueComment(action, parsed.data)
    case "issues":
      return mapIssues(action, parsed.data)
    case "sub_issues":
      return mapSubIssues(action, parsed.data)
    default:
      return null
  }
}
