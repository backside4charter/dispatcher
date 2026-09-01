import { describe, expect, it } from "vitest"
import { planRollback, shouldAct } from "./review-status-sync"
import type { LinkedRow, ReviewEvent } from "./review-status-sync"
import { TEST_CONFIG } from "./testing/board-fixtures"

/**
 * Contract for the review-to-board sync that backs the `board-review-sync`
 * workflow.
 *
 * The gap it closes: promotion to human review is not the end of the review
 * conversation. The owner reviews the PR after it lands there, and until this
 * existed nothing was reading those reviews - so a "Request changes" left the
 * row sitting at review, looking like it awaited a merge the owner was in
 * fact waiting on the agents for. Three rows stranded that way on the GitHub
 * board, two of them for two days.
 *
 * Two things it has to get right, and both are asymmetric - the costs of the
 * two failure directions are nothing alike:
 *
 * - **Never roll back a row that is not in the review conversation.** Writing
 *   `Changes Requested` onto a done row would reopen finished work, and onto
 *   an in-progress row would erase the fact a developer is mid-fix. Only the
 *   AI-review and human-review roles are rollbackable, so an unrecognized
 *   state is left alone rather than guessed at.
 * - **Never act on a bot's review.** The reviewer app is forbidden from posting
 *   `CHANGES_REQUESTED` by policy, but policy is not a mechanism: if that ever
 *   changed, an AI verdict would silently drive the board without the owner.
 */
describe("shouldAct", () => {
  const ownerChangeRequest: ReviewEvent = {
    action: "submitted",
    reviewState: "changes_requested",
    reviewerLogin: "someuser",
    reviewerUserId: 12345,
    prNumber: 458,
    prUrl: "https://github.com/acme/widgets/pull/458",
    headRef: "task/streaming-checklist-widget",
    title: "Add streaming checklist widget",
    body: "Fixes #125",
  }
  const bots = TEST_CONFIG.botUserIds

  it("acts on a change request submitted by the owner", () => {
    expect(shouldAct(ownerChangeRequest, bots)).toEqual({ act: true })
  })

  it("ignores an approval, and ignores a plain comment", () => {
    expect(shouldAct({ ...ownerChangeRequest, reviewState: "approved" }, bots))
      .toEqual({ act: false, reason: "not-a-change-request" })
    expect(shouldAct({ ...ownerChangeRequest, reviewState: "commented" }, bots))
      .toEqual({ act: false, reason: "not-a-change-request" })
  })

  it("accepts the REST spelling of the state as well as the webhook one", () => {
    // The webhook payload lowercases `state`; the REST API returns it upper.
    // Routing on one spelling makes the sync silently dead against the other.
    expect(shouldAct({ ...ownerChangeRequest, reviewState: "CHANGES_REQUESTED" }, bots)).toEqual({ act: true })
  })

  it("ignores anything that is not a freshly submitted review", () => {
    // `edited` and `dismissed` also arrive on this event. A dismissed review is
    // the opposite of a change request and must never trigger a rollback.
    expect(shouldAct({ ...ownerChangeRequest, action: "dismissed" }, bots))
      .toEqual({ act: false, reason: "not-submitted" })
    expect(shouldAct({ ...ownerChangeRequest, action: "edited" }, bots))
      .toEqual({ act: false, reason: "not-submitted" })
  })

  it("ignores a change request from either agent app, matching on the configured user ids", () => {
    // Ids, not logins: an app rename moves the display name but never the id,
    // and the repo's tooling routes on ids everywhere else for that reason.
    for (const botUserId of bots) {
      expect(shouldAct({ ...ownerChangeRequest, reviewerUserId: botUserId, reviewerLogin: "whatever[bot]" }, bots))
        .toEqual({ act: false, reason: "bot-reviewer" })
    }
  })
})

describe("planRollback", () => {
  const row = (
    ref: string,
    state: string,
    stateRole: LinkedRow["stateRole"],
    closed = false,
    agent: LinkedRow["agent"] = null,
  ): LinkedRow => ({ ref, state, stateRole, closed, agent })

  it("rolls back a row sitting at human review, whatever the platform calls it", () => {
    expect(planRollback([row("ACM-125", "Human Review", "humanReview")]).moves).toEqual([{ ref: "ACM-125", from: "Human Review" }])
    expect(planRollback([row("#125", "User Review", "humanReview")]).moves).toEqual([{ ref: "#125", from: "User Review" }])
  })

  it("rolls back a row the agent reviewer is holding, since the owner outranks the AI verdict", () => {
    const plan = planRollback([row("ACM-189", "In Progress", "inProgress", false, "reviewer")])

    expect(plan.moves).toEqual([{ ref: "ACM-189", from: "In Progress" }])
  })

  it("leaves a row a developer is mid-fix on alone, even though it shares the reviewer's state", () => {
    // In Progress no longer says which phase a row is in; only the delegate
    // does. Rolling this one back would erase the fact somebody is part-way
    // through a fix round.
    const plan = planRollback([row("ACM-190", "In Progress", "inProgress", false, "developer")])

    expect(plan.moves).toEqual([])
    expect(plan.skips).toEqual([{ ref: "ACM-190", reason: "state-not-rollbackable", state: "In Progress" }])
  })

  it("leaves an unheld in-progress row alone", () => {
    expect(planRollback([row("ACM-191", "In Progress", "inProgress")]).moves).toEqual([])
  })

  it("never rolls back a done row, which would reopen finished work", () => {
    const plan = planRollback([row("ACM-350", "Done", "done", true)])

    expect(plan.moves).toEqual([])
    expect(plan.skips).toEqual([{ ref: "ACM-350", reason: "issue-closed", state: "Done" }])
  })

  it("leaves an in-progress row alone, because a developer is already on it", () => {
    const plan = planRollback([row("ACM-511", "In Progress", "inProgress")])

    expect(plan.moves).toEqual([])
    expect(plan.skips).toEqual([{ ref: "ACM-511", reason: "state-not-rollbackable", state: "In Progress" }])
  })

  it("is idempotent: a row already at Changes Requested is not rewritten", () => {
    // The same review can be redelivered, and a second change request on the
    // same PR is normal. Neither should produce a redundant write.
    const plan = planRollback([row("ACM-125", "Changes Requested", "changesRequested")])

    expect(plan.moves).toEqual([])
    expect(plan.skips).toEqual([
      { ref: "ACM-125", reason: "state-not-rollbackable", state: "Changes Requested" },
    ])
  })

  it("leaves a state with no workflow role alone rather than guessing", () => {
    const plan = planRollback([row("ACM-1", "Some Future State", null)])

    expect(plan.moves).toEqual([])
    expect(plan.skips[0]?.reason).toBe("state-not-rollbackable")
  })

  it("handles a PR linked to several issues, moving only the eligible ones", () => {
    // The parent task plus its legacy sub-issues. The sub-issues are Done;
    // only the parent should come back.
    const plan = planRollback([
      row("ACM-259", "Human Review", "humanReview"),
      row("ACM-260", "Done", "done", true),
      row("ACM-261", "Done", "done", true),
    ])

    expect(plan.moves).toEqual([{ ref: "ACM-259", from: "Human Review" }])
    expect(plan.skips).toHaveLength(2)
  })

  it("reports nothing to do for an empty set rather than throwing", () => {
    expect(planRollback([])).toEqual({ moves: [], skips: [] })
  })
})
