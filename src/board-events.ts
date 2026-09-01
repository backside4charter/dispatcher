import { z } from "zod"
import { GITHUB_BOARD_FORWARD_EVENTS, mapGitHubBoardDelivery } from "./board/github/webhook-events"
import type { BoardPlatform } from "./board/types"

/**
 * A dispatcher-relevant event as recorded in the local event log: a GitHub
 * webhook delivery, or a Linear board change the poller observed.
 */
export interface BoardEvent {
  /** ISO timestamp of when the listener recorded the event. */
  receivedAt: string
  /** The source event name: a GitHub webhook event, or `linear_issue` / `linear_comment`. */
  event: string
  /** The action within the event ("opened", "changed", ...). */
  action: string
  /** One-line human summary shown in dispatcher status output. */
  summary: string
}

/** Zod schema for a BoardEvent, used when reading log lines back. */
export const boardEventSchema = z.object({
  receivedAt: z.string(),
  event: z.string(),
  action: z.string(),
  summary: z.string(),
})

/**
 * The result of mapping a raw webhook delivery: either an event to log, or a
 * reason it was dropped.
 */
export type DeliveryMapping =
  | { accepted: true; action: string; summary: string }
  | { accepted: false; reason: string }

/**
 * Webhook events every platform subscribes to: the pull request side of the
 * workflow always lives on GitHub.
 */
export const PULL_REQUEST_FORWARD_EVENTS = [
  "pull_request",
  "pull_request_review",
] as const

/**
 * The webhook events to forward for a platform. On Linear the board itself is
 * watched by the Linear poller; on GitHub the board's own events are
 * subscribed as well.
 */
export function forwardEventsFor(platform: BoardPlatform): string[] {
  return platform === "github"
    ? [...PULL_REQUEST_FORWARD_EVENTS, ...GITHUB_BOARD_FORWARD_EVENTS]
    : [...PULL_REQUEST_FORWARD_EVENTS]
}

/** Loose schema covering the payload fields the pull request mapping reads. */
const webhookPayloadSchema = z.object({
  action: z.string().optional(),
  sender: z.object({
    login: z.string().nullish(),
    type: z.string().nullish(),
  }).nullish(),
  pull_request: z.object({
    number: z.number(),
    title: z.string().nullish(),
    merged: z.boolean().nullish(),
    draft: z.boolean().nullish(),
  }).nullish(),
  review: z.object({
    state: z.string().nullish(),
    user: z.object({ login: z.string().nullish() }).nullish(),
  }).nullish(),
  repository: z.object({ full_name: z.string().nullish() }).nullish(),
})

type WebhookPayload = z.infer<typeof webhookPayloadSchema>

/** pull_request actions worth waking the dispatcher for. */
const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "closed", "ready_for_review", "converted_to_draft"])

/**
 * Renders " [repo]" from a payload's repository, or "" when absent.
 */
function repoSuffix(payload: WebhookPayload): string {
  const fullName = payload.repository?.full_name
  if (!fullName) return ""
  const short = fullName.split("/").pop() ?? fullName
  return ` [${short}]`
}

/**
 * Maps a pull_request delivery to a board event.
 */
function mapPullRequest(action: string, payload: WebhookPayload): DeliveryMapping {
  if (!PULL_REQUEST_ACTIONS.has(action)) {
    return { accepted: false, reason: `unsupported pull_request action: ${action}` }
  }
  const pullRequest = payload.pull_request
  if (!pullRequest) return { accepted: false, reason: "malformed payload" }
  const verb = action === "closed" && pullRequest.merged ? "merged" : action
  const title = pullRequest.title ?? "(untitled)"
  return {
    accepted: true,
    action,
    summary: `PR #${pullRequest.number} ${verb}: ${title}${repoSuffix(payload)}`,
  }
}

/**
 * Maps a pull_request_review delivery to a board event.
 */
function mapPullRequestReview(action: string, payload: WebhookPayload): DeliveryMapping {
  if (action !== "submitted") {
    return { accepted: false, reason: `unsupported pull_request_review action: ${action}` }
  }
  const pullRequest = payload.pull_request
  if (!pullRequest) return { accepted: false, reason: "malformed payload" }
  const state = payload.review?.state ?? "unknown"
  const login = payload.review?.user?.login ?? "unknown"
  return {
    accepted: true,
    action,
    summary: `PR #${pullRequest.number} review submitted (${state}) by ${login}${repoSuffix(payload)}`,
  }
}

/**
 * Maps a raw GitHub webhook delivery to a board event, or drops it.
 *
 * Drops (with a reason):
 * - anything sent by a bot (the agent app's own PR pushes and reviews), so
 *   the dispatcher is only woken by human actions;
 * - event/action combinations that carry no dispatcher signal - on Linear
 *   that includes every issue and project event, which belong to the GitHub
 *   board and are only mapped when that is the configured platform;
 * - payloads that do not parse.
 */
export function mapWebhookDelivery(eventName: string, payload: unknown, platform: BoardPlatform = "linear"): DeliveryMapping {
  const parsed = webhookPayloadSchema.safeParse(payload)
  if (!parsed.success) return { accepted: false, reason: "malformed payload" }
  const data = parsed.data

  const senderLogin = data.sender?.login ?? ""
  if (data.sender?.type === "Bot" || senderLogin.endsWith("[bot]")) {
    return { accepted: false, reason: "bot sender" }
  }

  const action = data.action ?? ""
  switch (eventName) {
    case "pull_request":
      return mapPullRequest(action, data)
    case "pull_request_review":
      return mapPullRequestReview(action, data)
    default: {
      const board = platform === "github" ? mapGitHubBoardDelivery(eventName, action, payload) : null
      return board ?? { accepted: false, reason: `unsupported event: ${eventName}` }
    }
  }
}
