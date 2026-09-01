/**
 * CLI for the review-to-board sync, run by `.github/workflows/board-review-sync.yml`.
 *
 * Everything decision-shaped lives in review-status-sync.ts and is unit-tested;
 * this file is the thin layer that reads the webhook payload, resolves the
 * pull request to its board issues through the configured backend, and writes
 * the result. Thin is not the same as untested: the *sequence* of writes is a
 * contract of its own (see `runReviewStatusSync`), so it is driven by
 * `review-status-sync-cli.spec.ts` against an in-memory board rather than
 * trusted to be too simple to be wrong.
 *
 * It is deliberately quiet about failure in one direction only: a delivery it
 * decides not to act on exits 0 with a one-line reason, because the workflow
 * fires on every review and most reviews are not change requests. A genuine
 * API failure exits non-zero, so a broken sync shows up as a red workflow run
 * rather than as a board that silently stops moving.
 */
import { readFileSync } from "node:fs"
import { createBoardBackend } from "./board/backend"
import { loadDispatcherConfig } from "./board/config"
import type { DispatcherConfig } from "./board/config"
import type { BoardBackend } from "./board/types"
import { planRollback, shouldAct } from "./review-status-sync"
import type { LinkedRow, ReviewEvent } from "./review-status-sync"

/** Reads a required environment variable, failing loudly when it is absent. */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (value == null || value.length === 0) throw new Error(`${name} is not set`)
  return value
}

/**
 * Reads the `pull_request_review` payload GitHub wrote to disk for this run.
 *
 * Narrowed by hand rather than with a schema library: this runs in a workflow
 * where a dependency is one more thing that can break the sync, and the shape
 * needed is four fields deep at most.
 */
export function readReviewEvent(eventPath: string): ReviewEvent {
  const raw: unknown = JSON.parse(readFileSync(eventPath, "utf8"))
  if (typeof raw !== "object" || raw == null) throw new Error("event payload is not an object")

  const record = raw as Record<string, unknown>
  const review = record.review as Record<string, unknown> | undefined
  const pull = record.pull_request as Record<string, unknown> | undefined
  const reviewer = review?.user as Record<string, unknown> | undefined
  const head = pull?.head as Record<string, unknown> | undefined

  if (review == null || pull == null) throw new Error("event payload is not a pull_request_review")

  return {
    action: String(record.action ?? ""),
    reviewState: String(review.state ?? ""),
    reviewerLogin: String(reviewer?.login ?? "unknown"),
    reviewerUserId: Number(reviewer?.id ?? -1),
    prNumber: Number(pull.number ?? -1),
    prUrl: String(pull.html_url ?? ""),
    headRef: String(head?.ref ?? ""),
    title: String(pull.title ?? ""),
    body: String(pull.body ?? ""),
  }
}

/** What the sync needs from the outside world, injectable for tests. */
export interface ReviewSyncDeps {
  /** Loads the dispatcher config; the default reads `dispatcher.config.json`. */
  loadConfig: () => { config: DispatcherConfig; path: string }
  /** Builds the backend for a config; the default resolves real credentials. */
  backend: (config: DispatcherConfig) => BoardBackend
  /** Reads the review delivery; the default reads the file GitHub wrote. */
  readEvent: () => ReviewEvent
  log: (line: string) => void
}

/**
 * Runs the sync for one review delivery.
 *
 * Each row the plan moves gets **two** writes, in this order: the state, then
 * a release. The release is not tidying - it is half of what "sent back for
 * changes" means. State says where a row sits in the human-facing pipeline;
 * the delegate says which agent phase it is in, and while the row is being
 * reviewed that delegate is the reviewer agent. Writing only the state leaves
 * `Changes Requested` with the reviewer still holding it, which is exactly the
 * shape the reviewer queue dispatches: the next firing spends a full AI review
 * round on work the owner has already reviewed and rejected, while their
 * change request waits. Releasing clears the delegate (and the assignee Linear
 * leaves behind with it), so the row reads as what it now is - rework nobody
 * is on - and the developer queue picks it up ahead of every `Ready` row.
 *
 * This mirrors the manual path exactly: `pr:request-changes` runs
 * `board state <ref> changes-requested` followed by `board release <ref>`.
 * The two must not drift, because they answer the same event.
 *
 * `release` is idempotent and tolerates half a claim, so the second write is a
 * cheap no-op on a row that carries no delegate (one already at human review,
 * say) and leaves a delegate the dispatcher does not run alone.
 */
export async function runReviewStatusSync(deps: ReviewSyncDeps): Promise<void> {
  const { config, path: configPath } = deps.loadConfig()
  const event = deps.readEvent()
  const decision = shouldAct(event, config.botUserIds)
  if (!decision.act) {
    deps.log(`no action: ${decision.reason} (review by ${event.reviewerLogin} on PR #${event.prNumber})`)
    return
  }

  deps.log(`change request by ${event.reviewerLogin} on PR #${event.prNumber}; board: ${config.platform} (${configPath})`)
  const board = deps.backend(config)
  const issues = await board.resolvePullRequest({
    number: event.prNumber, url: event.prUrl, headRef: event.headRef, title: event.title, body: event.body,
  })
  if (issues.length === 0) {
    deps.log(`no linked issue found for PR #${event.prNumber}; nothing to move`)
    return
  }
  for (const issue of issues) {
    deps.log(`linked ${issue.ref} (${issue.state}${issue.agent === null ? "" : `, ${issue.agent}`}) via ${issue.via}`)
  }

  const rows: LinkedRow[] = issues.map((issue) => ({
    ref: issue.ref, state: issue.state, stateRole: issue.stateRole, closed: issue.closed, agent: issue.agent,
  }))
  const plan = planRollback(rows)
  for (const skip of plan.skips) {
    deps.log(`skip  ${skip.ref}  (${skip.reason}, state ${skip.state})`)
  }

  for (const move of plan.moves) {
    const change = await board.setState(move.ref, "changesRequested")
    const released = await board.release(move.ref)
    const claim = released.released === null ? "no claim" : `released ${released.released.role}:${released.released.sessionId}`
    deps.log(`moved ${move.ref}  ${change.from} -> ${change.to}, agent handed back (${claim})`)
  }

  deps.log(`done: ${plan.moves.length} moved, ${plan.skips.length} left alone`)
}

/** The real dependencies: the committed config, the live backend, the workflow's payload. */
const productionDeps: ReviewSyncDeps = {
  loadConfig: () => loadDispatcherConfig(),
  backend: (config) => createBoardBackend(config),
  readEvent: () => readReviewEvent(requireEnv("GITHUB_EVENT_PATH")),
  log: (line) => { console.log(line) },
}

/**
 * Runs the sync with the production dependencies, mapping failure to a
 * non-zero exit code so a broken sync shows as a red workflow run. Execution
 * belongs to main.ts alone - a module-level "am I the entrypoint" guard here
 * would misfire in the compiled binary, where bundling gives every module the
 * entry's `import.meta.url`.
 */
export async function runReviewStatusSyncFromProcess(): Promise<number> {
  try {
    await runReviewStatusSync(productionDeps)
    return 0
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}
