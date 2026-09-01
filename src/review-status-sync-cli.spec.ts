import { describe, expect, it } from "vitest"
import { runReviewStatusSync } from "./review-status-sync-cli"
import type { ReviewSyncDeps } from "./review-status-sync-cli"
import type { ReviewEvent } from "./review-status-sync"
import { MemoryBoard, TEST_CONFIG } from "./testing/board-fixtures"
import type { RowFixture } from "./testing/board-fixtures"
import type { LinkedIssue } from "./board/types"

/**
 * Contract for the write half of the review-to-board sync.
 *
 * `review-status-sync.spec.ts` covers the decision - which linked rows a
 * change request should send back. This covers what is actually written for
 * them, which is a separate thing and was where the bug lived: the CLI wrote
 * the state and stopped, leaving the row `Changes Requested` with the delegate
 * still on the reviewer agent. That row satisfies the reviewer queue's
 * selection rule verbatim, so the next dispatcher firing spends a whole AI
 * review round on a task the owner had just sent back for changes, while the
 * change request goes stale.
 *
 * The manual equivalent (`pr:request-changes`) has always done both halves -
 * `board state <ref> changes-requested` **and** `board release <ref>` - so the
 * automated path doing less than the documented manual one was an oversight
 * rather than a design choice.
 */
const OWNER_CHANGE_REQUEST: ReviewEvent = {
  action: "submitted",
  reviewState: "changes_requested",
  reviewerLogin: "someuser",
  reviewerUserId: 12345,
  prNumber: 525,
  prUrl: "https://github.com/acme/widgets/pull/525",
  headRef: "task/acm-12-widget",
  title: "Widget",
  body: "Fixes ACM-12",
}

/** A linked issue as `resolvePullRequest` reports it. */
function linked(overrides: Partial<LinkedIssue> & { ref: string }): LinkedIssue {
  return {
    title: `Task ${overrides.ref}`,
    url: `https://linear.app/acme/issue/${overrides.ref}`,
    state: "In Progress",
    stateRole: "inProgress",
    closed: false,
    agent: null,
    via: "branch",
    ...overrides,
  }
}

/**
 * Runs the sync against an in-memory board, returning the board and the log.
 */
async function run(
  rows: RowFixture[],
  linkedIssues: LinkedIssue[],
  event: ReviewEvent = OWNER_CHANGE_REQUEST,
): Promise<{ board: MemoryBoard; log: string[] }> {
  const board = new MemoryBoard(rows)
  board.linked = linkedIssues
  const log: string[] = []
  const deps: ReviewSyncDeps = {
    loadConfig: () => ({ config: TEST_CONFIG, path: "dispatcher.config.json" }),
    backend: () => board,
    readEvent: () => event,
    log: (line) => log.push(line),
  }
  await runReviewStatusSync(deps)
  return { board, log }
}

describe("runReviewStatusSync", () => {
  it("sends a reviewer-held row back AND releases it, in that order", async () => {
    const { board } = await run(
      [{
        ref: "ACM-12",
        state: "In Progress",
        stateRole: "inProgress",
        delegate: "acme-reviewer",
        assignee: "someuser",
      }],
      [linked({ ref: "ACM-12", agent: "reviewer" })],
    )

    // The exact sequence matters: the state write alone is what left the row
    // delegated to the reviewer and re-dispatchable as an AI review.
    expect(board.writes).toEqual([
      "state ACM-12 In Progress -> Changes Requested",
      "release ACM-12",
    ])
    const row = await board.issue("ACM-12")
    expect(row.state).toBe("Changes Requested")
    expect(row.delegate).toBeNull()
    // The assignee goes with the delegate, or the row reads as human-owned and
    // is never dispatched again.
    expect(row.assignee).toBeNull()
  })

  it("leaves no agent holding a row it sent back from human review either", async () => {
    const { board } = await run(
      [{ ref: "ACM-125", state: "Human Review", stateRole: "humanReview" }],
      [linked({ ref: "ACM-125", state: "Human Review", stateRole: "humanReview" })],
    )

    expect(board.writes).toEqual(["state ACM-125 Human Review -> Changes Requested"])
    expect((await board.issue("ACM-125")).state).toBe("Changes Requested")
  })

  it("writes nothing at all for a row that is not in the review conversation", async () => {
    const { board, log } = await run(
      [{ ref: "ACM-190", state: "In Progress", stateRole: "inProgress", delegate: "acme-developer" }],
      [linked({ ref: "ACM-190", agent: "developer" })],
    )

    // Releasing here would clear a claim a developer is working under.
    expect(board.writes).toEqual([])
    expect(log.join("\n")).toContain("skip  ACM-190")
  })

  it("moves only the eligible rows when a pull request links several", async () => {
    const { board } = await run(
      [
        { ref: "ACM-3", state: "In Progress", stateRole: "inProgress", delegate: "acme-reviewer" },
        { ref: "ACM-202", state: "Done", stateRole: "done", closed: true, parent: { ref: "ACM-3", milestone: "v1.1.0" } },
      ],
      [
        linked({ ref: "ACM-3", agent: "reviewer" }),
        linked({ ref: "ACM-202", state: "Done", stateRole: "done", closed: true }),
      ],
    )

    expect(board.writes).toEqual(["state ACM-3 In Progress -> Changes Requested", "release ACM-3"])
  })

  it("never reaches the board for a delivery it should not act on", async () => {
    const { board, log } = await run(
      [{ ref: "ACM-12", state: "Human Review", stateRole: "humanReview" }],
      [linked({ ref: "ACM-12", state: "Human Review", stateRole: "humanReview" })],
      { ...OWNER_CHANGE_REQUEST, reviewState: "approved" },
    )

    expect(board.writes).toEqual([])
    expect(log.join("\n")).toContain("no action: not-a-change-request")
  })

  it("never acts on an agent app's own review, matching on the configured bot ids", async () => {
    const botId = TEST_CONFIG.botUserIds[0] ?? -1
    const { board, log } = await run(
      [{ ref: "ACM-12", state: "Human Review", stateRole: "humanReview" }],
      [linked({ ref: "ACM-12", state: "Human Review", stateRole: "humanReview" })],
      { ...OWNER_CHANGE_REQUEST, reviewerUserId: botId, reviewerLogin: "acme-reviewer[bot]" },
    )

    expect(board.writes).toEqual([])
    expect(log.join("\n")).toContain("no action: bot-reviewer")
  })

  it("says so and writes nothing when the pull request names no board issue", async () => {
    const { board, log } = await run([{ ref: "ACM-12" }], [])

    expect(board.writes).toEqual([])
    expect(log.join("\n")).toContain("no linked issue found")
  })
})
