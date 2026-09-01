import { describe, expect, it } from "vitest"
import { GITHUB_BOARD_FORWARD_EVENTS, mapGitHubBoardDelivery } from "./webhook-events"

describe("GITHUB_BOARD_FORWARD_EVENTS", () => {
  it("names exactly the events the board mapper handles", () => {
    expect([...GITHUB_BOARD_FORWARD_EVENTS].sort()).toEqual(["issue_comment", "issues", "projects_v2_item", "sub_issues"])
    for (const eventName of GITHUB_BOARD_FORWARD_EVENTS) {
      expect(mapGitHubBoardDelivery(eventName, "nonsense", {})).not.toBeNull()
    }
    expect(mapGitHubBoardDelivery("star", "created", {})).toBeNull()
  })
})

describe("mapGitHubBoardDelivery", () => {
  it("accepts a board Status change with the from/to option names in the summary", () => {
    const result = mapGitHubBoardDelivery("projects_v2_item", "edited", {
      projects_v2_item: { content_type: "Issue" },
      changes: {
        field_value: {
          field_name: "Status",
          field_type: "single_select",
          from: { name: "Ready" },
          to: { name: "In Progress" },
        },
      },
    })
    expect(result).toEqual({ accepted: true, action: "edited", summary: "board item edited: Status (Ready -> In Progress)" })
  })

  it("accepts a board field edit without from/to values", () => {
    const result = mapGitHubBoardDelivery("projects_v2_item", "edited", {
      changes: { field_value: { field_name: "Priority", field_type: "single_select" } },
    })
    expect(result).toEqual({ accepted: true, action: "edited", summary: "board item edited: Priority" })
  })

  it("ignores Claimed By edits so the dispatcher's own claim heartbeats cannot wake it in a loop", () => {
    const result = mapGitHubBoardDelivery("projects_v2_item", "edited", {
      changes: { field_value: { field_name: "Claimed By", field_type: "text" } },
    })
    expect(result).toEqual({ accepted: false, reason: "Claimed By edit (dispatcher claim heartbeat)" })
  })

  it("accepts other board item lifecycle actions and ignores unknown ones", () => {
    expect(mapGitHubBoardDelivery("projects_v2_item", "created", { projects_v2_item: { content_type: "Issue" } }))
      .toEqual({ accepted: true, action: "created", summary: "board item created" })
    expect(mapGitHubBoardDelivery("projects_v2_item", "sparkled", {}))
      .toEqual({ accepted: false, reason: "unsupported projects_v2_item action: sparkled" })
  })

  it("accepts a new issue comment (the owner answering a parked question)", () => {
    const result = mapGitHubBoardDelivery("issue_comment", "created", {
      issue: { number: 444, title: "Get hooks set up" },
      comment: { user: { login: "the-owner" } },
      repository: { full_name: "acme/widgets" },
    })
    expect(result).toEqual({ accepted: true, action: "created", summary: "comment on #444 by the-owner [widgets]" })
  })

  it("accepts issue label and milestone changes with the detail in the summary", () => {
    expect(mapGitHubBoardDelivery("issues", "labeled", {
      issue: { number: 444, title: "Get hooks set up" },
      label: { name: "question" },
      repository: { full_name: "acme/widgets" },
    })).toEqual({ accepted: true, action: "labeled", summary: 'issue #444 labeled "question" [widgets]' })
    expect(mapGitHubBoardDelivery("issues", "milestoned", {
      issue: { number: 444, title: "Get hooks set up" },
      milestone: { title: "v1.1.0" },
      repository: { full_name: "acme/widgets" },
    })).toEqual({ accepted: true, action: "milestoned", summary: 'issue #444 milestoned "v1.1.0" [widgets]' })
  })

  it("accepts issue closed/reopened and ignores issue actions that carry no signal", () => {
    expect(mapGitHubBoardDelivery("issues", "reopened", { issue: { number: 400, title: "A task" }, repository: { full_name: "acme/widgets" } }))
      .toEqual({ accepted: true, action: "reopened", summary: "issue #400 reopened [widgets]" })
    expect(mapGitHubBoardDelivery("issues", "assigned", { issue: { number: 400, title: "A task" } }))
      .toEqual({ accepted: false, reason: "unsupported issues action: assigned" })
  })

  it("accepts sub-issue tree changes and rejects a malformed payload", () => {
    expect(mapGitHubBoardDelivery("sub_issues", "sub_issue_added", {
      parent_issue: { number: 400, title: "Parent" },
      sub_issue: { number: 401, title: "Child" },
      repository: { full_name: "acme/widgets" },
    })).toEqual({ accepted: true, action: "sub_issue_added", summary: "sub-issues sub_issue_added on #400 [widgets]" })
    expect(mapGitHubBoardDelivery("sub_issues", "sub_issue_added", {})).toEqual({ accepted: false, reason: "malformed payload" })
  })
})
