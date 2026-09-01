import { describe, expect, it } from "vitest"
import { LINEAR_TEST_CONFIG, makeIssueNode } from "../../testing/linear-fixtures"
import { formatClaimComment } from "../claim-comment"
import { agentForDelegateId, findClaimComment, roleForStateName, toBoardRow } from "./queries"

describe("findClaimComment", () => {
  it("picks the claim comment out of a conversation and takes its heartbeat from the body", () => {
    expect(findClaimComment([
      { id: "c1", body: "**[developer]**\n\nPR is up" },
      { id: "c-claim", body: formatClaimComment("dev", "sess-1", new Date("2026-08-27T11:30:00Z")) },
      { id: "c2", body: "Owner reply" },
    ])).toEqual({
      role: "dev",
      sessionId: "sess-1",
      // Minute precision, which is what renders in a status line.
      stampedAt: "2026-08-27T11:30Z",
      commentId: "c-claim",
    })
  })

  it("reads the heartbeat with nothing but the comment body to go on", () => {
    // The node carries no timestamp at all - the query does not even select
    // one. Everything the claim says comes out of the text a worker wrote, so
    // the heartbeat cannot silently depend on how Linear timestamps a comment
    // it edits in place.
    expect(findClaimComment([
      { id: "c-claim", body: formatClaimComment("review", "sess-2", new Date("2026-08-27T11:45:00Z")) },
    ])).toEqual({ role: "review", sessionId: "sess-2", stampedAt: "2026-08-27T11:45Z", commentId: "c-claim" })
  })

  it("reports no claim on an issue that has only conversation", () => {
    expect(findClaimComment([{ id: "c1", body: "Just talking" }])).toBeNull()
    expect(findClaimComment([])).toBeNull()
  })
})

describe("agentForDelegateId", () => {
  it("maps the configured agent ids, and reports anyone else as not ours", () => {
    const agents = LINEAR_TEST_CONFIG.agents
    expect(agentForDelegateId(agents, agents.developer)).toBe("developer")
    expect(agentForDelegateId(agents, agents.reviewer)).toBe("reviewer")
    expect(agentForDelegateId(agents, "some-other-user")).toBeNull()
    expect(agentForDelegateId(agents, null)).toBeNull()
    expect(agentForDelegateId(agents, undefined)).toBeNull()
  })
})

describe("roleForStateName", () => {
  it("maps the configured names to roles, case-insensitively, and unknown names to null", () => {
    expect(roleForStateName(LINEAR_TEST_CONFIG, "human review")).toBe("humanReview")
    expect(roleForStateName(LINEAR_TEST_CONFIG, "Backlog")).toBe("backlog")
    expect(roleForStateName(LINEAR_TEST_CONFIG, "Canceled")).toBeNull()
  })
})

describe("toBoardRow", () => {
  it("reduces an issue to the fields dispatch decisions need", () => {
    const row = toBoardRow(makeIssueNode({
      identifier: "ACM-12",
      title: "Fix scroll pinning",
      sortOrder: 120,
      state: { name: "Changes Requested", type: "started" },
      assignee: null,
      labels: ["UI", "Bug"],
      milestone: "v1.1.0",
      parent: { identifier: "ACM-3", milestone: "v1.1.0" },
      children: [
        { identifier: "ACM-13", state: { name: "Done", type: "completed" } },
        { identifier: "ACM-14", state: { name: "Ready", type: "unstarted" } },
      ],
      blockers: [
        { identifier: "ACM-5", state: { name: "Human Review", type: "started" } },
        { identifier: "ACM-6", state: { name: "Done", type: "completed" } },
      ],
      delegate: { id: LINEAR_TEST_CONFIG.agents.reviewer, displayName: "acme-reviewer" },
      attachments: [
        { url: "https://github.com/acme/widgets/issues/480" },
        { url: "https://github.com/acme/widgets/pull/521" },
      ],
    }), LINEAR_TEST_CONFIG, { role: "review", sessionId: "s", stampedAt: "2026-08-27T10:00Z" })

    expect(row.ref).toBe("ACM-12")
    expect(row.url).toBe("https://linear.app/acme/issue/ACM-12")
    expect(row.state).toBe("Changes Requested")
    expect(row.stateRole).toBe("changesRequested")
    expect(row.closed).toBe(false)
    expect(row.labels).toEqual(["UI", "Bug"])
    // Only an OPEN blocker blocks; a merged one has stopped mattering.
    expect(row.openBlockers).toEqual(["ACM-5"])
    expect(row.pullRequests).toEqual([521])
    expect(row.parent).toEqual({ ref: "ACM-3", milestone: "v1.1.0" })
    expect(row.children).toEqual({ closed: 1, total: 2 })
    expect(row.githubIssue).toBe(480)
    expect(row.claim).toEqual({ role: "review", sessionId: "s", stampedAt: "2026-08-27T10:00Z" })
    expect(row.delegate).toBe("acme-reviewer")
  })

  it("reports no claim when the poll's second query found none, which is how a queued row looks", () => {
    const row = toBoardRow(makeIssueNode({
      identifier: "ACM-12",
      delegate: { id: LINEAR_TEST_CONFIG.agents.developer, displayName: "acme-developer" },
    }), LINEAR_TEST_CONFIG)
    expect(row.delegate).toBe("acme-developer")
    expect(row.claim).toBeNull()
  })

  it("reports no children and no GitHub issue for a task created natively in Linear, and closed for a done one", () => {
    const row = toBoardRow(makeIssueNode({ identifier: "ACM-300", attachments: [], state: { name: "Done", type: "completed" } }), LINEAR_TEST_CONFIG)
    expect(row.children).toBeNull()
    expect(row.githubIssue).toBeNull()
    expect(row.pullRequests).toEqual([])
    expect(row.closed).toBe(true)
    expect(row.stateRole).toBe("done")
  })
})
