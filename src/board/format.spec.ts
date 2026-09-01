import { describe, expect, it } from "vitest"
import { makeRow } from "../testing/board-fixtures"
import { ROW_TSV_HEADER, formatRowTsv, renderIssueMarkdown, sortRows } from "./format"

const now = new Date("2026-08-27T12:00:00Z")

describe("sortRows", () => {
  it("orders by the board's manual order, top of the board first", () => {
    const rows = [
      makeRow({ ref: "ACM-2", sortIndex: 300 }),
      makeRow({ ref: "ACM-9", sortIndex: 10 }),
      makeRow({ ref: "ACM-5", sortIndex: 120 }),
    ]
    expect(sortRows(rows).map((row) => row.ref)).toEqual(["ACM-9", "ACM-5", "ACM-2"])
  })
})

describe("formatRowTsv", () => {
  it("prints every column, with - for empty cells, so lines always align with the header", () => {
    const line = formatRowTsv(makeRow({ ref: "ACM-7", title: "Bare task", milestone: null }), now)
    expect(line.split("\t")).toHaveLength(ROW_TSV_HEADER.split("\t").length)
    expect(line).toBe("-\tReady\t-\t-\tACM-7\t-\t-\t-\t-\t-\t-\tBare task")
  })

  it("fills every column from the row", () => {
    const line = formatRowTsv(makeRow({
      ref: "#480",
      title: "Scroll pinning",
      state: "Changes Requested",
      labels: ["ui", "bug"],
      assignee: "someuser",
      delegate: "acme-developer",
      claim: { role: "dev", sessionId: "sess", stampedAt: "2026-08-27T11:15Z" },
      openBlockers: ["#12"],
      pullRequests: [521, 522],
      parent: { ref: "#402", milestone: "v1.1.0" },
      children: { closed: 1, total: 3 },
    }), now)
    expect(line).toBe(
      "v1.1.0\tChanges Requested\tacme-developer\tdev:sess@2026-08-27T11:15Z(45m)"
      + "\t#480\tui,bug\tsomeuser\t#12\t#521,#522\t#402\t1/3\tScroll pinning",
    )
  })
})

describe("renderIssueMarkdown assignment", () => {
  const detail = (row: Partial<Parameters<typeof makeRow>[0]>): Parameters<typeof renderIssueMarkdown>[0] => ({
    ...makeRow({ ref: "ACM-9", ...row }),
    description: null,
    blockers: [],
    childIssues: [],
    pullRequestUrls: [],
    comments: [],
    commentCount: 0,
  })

  it("calls a row with an assignee and no delegate human-owned", () => {
    const text = renderIssueMarkdown(detail({ assignee: "someuser" }), now, 0).join("\n")
    expect(text).toContain("- Assignee: someuser (human-owned, agents skip)")
    expect(text).toContain("- Delegate: -")
  })

  it("calls a delegated row agent-workable even though delegation assigned it", () => {
    // Delegating always sets an assignee, so the assignee alone would make
    // every claimed row look like a human's.
    const text = renderIssueMarkdown(detail({ assignee: "someuser", delegate: "acme-developer" }), now, 0).join("\n")
    expect(text).toContain("- Assignee: someuser (agent-workable)")
    expect(text).toContain("- Delegate: acme-developer")
  })

  it("calls an unassigned row agent-workable", () => {
    expect(renderIssueMarkdown(detail({}), now, 0).join("\n")).toContain("- Assignee: - (agent-workable)")
  })
})

describe("renderIssueMarkdown", () => {
  it("renders the header, sub-issues, description and the last N comments", () => {
    const lines = renderIssueMarkdown({
      ...makeRow({ ref: "ACM-3", title: "Unity Plugin", state: "Human Review", stateRole: "humanReview", labels: ["Plugins"], githubIssue: 402 }),
      description: "Add support for Unity.\n\n- [x] generator\n- [ ] docs",
      blockers: [{ ref: "ACM-6", title: "Bun", state: "Done" }],
      childIssues: [{ ref: "ACM-208", title: "Docs", state: "Ready", openBlockers: ["ACM-207"] }],
      pullRequestUrls: ["https://github.com/acme/widgets/pull/521"],
      comments: [
        { author: "unknown", createdAt: "2026-08-27T10:00:00.000Z", body: "First" },
        { author: "Lars", createdAt: "2026-08-27T11:00:00.000Z", body: "Second" },
      ],
      commentCount: 2,
    }, now, 1)
    const text = lines.join("\n")
    expect(text).toContain("# ACM-3 Unity Plugin")
    expect(text).toContain("- State: Human Review")
    expect(text).toContain("- GitHub issue: #402")
    expect(text).toContain("- Pull requests: https://github.com/acme/widgets/pull/521")
    expect(text).toContain("- Blocked by: ACM-6 (Done)")
    expect(text).toContain("| ACM-208 | Docs | Ready | ACM-207 |")
    expect(text).toContain("- [ ] docs")
    expect(text).toContain("## Comments (2 total, showing last 1)")
    expect(text).toContain("### Lars at 2026-08-27T11:00:00.000Z")
    expect(text).not.toContain("First")
  })
})
