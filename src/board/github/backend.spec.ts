import { describe, expect, it } from "vitest"
import { FakeGh, GITHUB_TEST_CONFIG, makeIssueContent, makeProjectItem } from "../../testing/github-fixtures"
import { GitHubBoard } from "./backend"

const NOW = new Date("2026-08-27T12:00:00Z")

/**
 * Builds a backend over a fake gh runner.
 */
function board(fake: FakeGh): GitHubBoard {
  return new GitHubBoard(GITHUB_TEST_CONFIG, "acme/widgets", fake)
}

/**
 * The Status field's options, as GitHub returns them.
 *
 * The frozen board still carries its `AI Review` column, which the config no
 * longer maps to any role, so it stands in here for a column the workflow has
 * stopped using and must not be routed to.
 */
const statusOptions = {
  node: {
    options: Object.values(GITHUB_TEST_CONFIG.states)
      .map((state) => ({ id: state.optionId, name: state.name }))
      .concat([{ id: "7d74af81", name: "AI Review" }, { id: "zz", name: "Parked" }]),
  },
}

/**
 * Registers the issue-item query for one issue.
 */
function withIssueItem(fake: FakeGh, number: number, options: { parent?: boolean; item?: Record<string, unknown> | null; state?: string } = {}): FakeGh {
  return fake.onGraphql("parent { number }\n      projectItems", (variables) => {
    if (variables.number !== number) throw new Error(`Could not resolve to an Issue with the number of ${String(variables.number)}.`)
    return {
      repository: {
        issue: {
          number,
          title: `Task #${number}`,
          url: `https://github.com/acme/widgets/issues/${number}`,
          state: options.state ?? "OPEN",
          parent: options.parent === true ? { number: 402 } : null,
          projectItems: { nodes: options.item === null ? [] : [options.item ?? makeProjectItem()] },
        },
      },
    }
  })
}

describe("GitHubBoard", () => {
  it("normalizes issue numbers in every accepted spelling and rejects other repositories", () => {
    const b = board(new FakeGh())
    expect(b.normalizeRef("480")).toBe("#480")
    expect(b.normalizeRef("#480")).toBe("#480")
    expect(b.normalizeRef("acme/widgets#480")).toBe("#480")
    expect(() => b.normalizeRef("acme/other#480")).toThrow("not in the configured repository")
    expect(() => b.normalizeRef("ACM-12")).toThrow("expected an issue number like #480")
    expect(b.labels.ui).toBe("ui")
  })

  it("reads the Status options with the role each option id plays", async () => {
    const fake = new FakeGh().onGraphql("ProjectV2SingleSelectField", () => statusOptions)
    const states = await board(fake).states()
    expect(states.map((state) => [state.name, state.role, state.closed, state.id])).toEqual([
      ["Hold", "backlog", false, "c6c58d18"],
      ["Ready", "ready", false, "f75ad846"],
      ["Changes Requested", "changesRequested", false, "cbe4dc71"],
      ["In Progress", "inProgress", false, "47fc9ee4"],
      ["User Review", "humanReview", false, "b2bb70ee"],
      ["Done", "done", true, "98236657"],
      // The frozen board still carries this column; nothing maps to it now.
      ["AI Review", null, false, "7d74af81"],
      ["Parked", null, false, "zz"],
    ])
  })

  it("refuses a role the frozen board has no column for, rather than routing it somewhere else", async () => {
    const fake = new FakeGh().onGraphql("ProjectV2SingleSelectField", () => statusOptions)
    await expect(board(fake).setState("480", "question")).rejects.toThrow('the GitHub board has no column for the "question" role')
  })

  it("has no agent delegation to hand a row to", async () => {
    await expect(board(new FakeGh()).assign("480", "reviewer")).rejects.toThrow("no agent delegation")
  })

  it("lists open milestones with their open-issue counts over REST", async () => {
    const fake = new FakeGh().onRest("GET", /milestones/, () => [{ title: "v1.1.0", open_issues: 12 }, { title: "v1.0.1", open_issues: 3 }])
    expect(await board(fake).milestones()).toEqual([{ name: "v1.1.0", open: 12 }, { name: "v1.0.1", open: 3 }])
  })

  it("polls the board in position order, filtering by milestone and dropping drafts and other repositories", async () => {
    const fake = new FakeGh().onGraphql("orderBy: {field: POSITION", (variables) => (variables.after === null
      ? {
        organization: {
          projectV2: {
            items: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [
                { ...makeProjectItem({ id: "PVTI_a", status: { name: "User Review", optionId: "b2bb70ee" }, claim: { text: "dev:sess@2026-08-27T10:00Z" } }), content: makeIssueContent({ number: 1, milestone: "v1.1.0", pullRequests: [521], blockedBy: [{ number: 5, state: "OPEN" }, { number: 6, state: "CLOSED" }], subIssues: { total: 3, completed: 1 }, parent: { number: 402, milestone: "v1.1.0" } }) },
                { ...makeProjectItem({ id: "PVTI_draft" }), content: {} },
                { ...makeProjectItem({ id: "PVTI_other" }), content: { ...makeIssueContent({ number: 9 }), repository: { nameWithOwner: "acme/other" } } },
              ],
            },
          },
        },
      }
      : {
        organization: {
          projectV2: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { ...makeProjectItem({ id: "PVTI_b" }), content: makeIssueContent({ number: 2, milestone: "v1.2.0" }) },
                { ...makeProjectItem({ id: "PVTI_c", status: { name: "Done", optionId: "98236657" } }), content: makeIssueContent({ number: 3, state: "CLOSED" }) },
              ],
            },
          },
        },
      }))

    const rows = await board(fake).poll({ milestones: ["v1.1.0"], includeClosed: false })
    expect(rows.map((row) => row.ref)).toEqual(["#1"])
    const [row] = rows
    expect(row).toMatchObject({
      state: "User Review",
      stateRole: "humanReview",
      closed: false,
      milestone: "v1.1.0",
      openBlockers: ["#5"],
      pullRequests: [521],
      parent: { ref: "#402", milestone: "v1.1.0" },
      children: { closed: 1, total: 3 },
      githubIssue: 1,
      claim: { role: "dev", sessionId: "sess", stampedAt: "2026-08-27T10:00Z" },
    })

    // Position counts tasks only - drafts and other repositories' items are not rows.
    const all = await board(fake).poll({ milestones: "all", includeClosed: true })
    expect(all.map((entry) => [entry.ref, entry.sortIndex, entry.closed])).toEqual([["#1", 0, false], ["#2", 1, false], ["#3", 2, true]])
  })

  describe("setState", () => {
    it("writes the option id for a role or a name onto the issue's project item", async () => {
      const fake = withIssueItem(new FakeGh().onGraphql("ProjectV2SingleSelectField", () => statusOptions), 480)
        .onGraphql("singleSelectOptionId", () => ({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } }))
      expect(await board(fake).setState("480", "inProgress")).toEqual({ ref: "#480", from: "Ready", to: "In Progress", changed: true })
      expect(fake.graphqlCalls("singleSelectOptionId")[0]?.variables).toEqual({
        project: "PVT_exampleProject01", item: "PVTI_1", field: "PVTSSF_status", option: "47fc9ee4",
      })
      expect(await board(fake).setState("#480", "User Review")).toMatchObject({ to: "User Review", changed: true })
      expect(await board(fake).setState("#480", "ready")).toMatchObject({ changed: false })
    })

    it("refuses to complete a top-level task, completes a sub-issue, and explains an off-board issue", async () => {
      const top = withIssueItem(new FakeGh().onGraphql("ProjectV2SingleSelectField", () => statusOptions), 480)
      await expect(board(top).setState("480", "done")).rejects.toThrow("refusing to set #480 to Done")

      const child = withIssueItem(new FakeGh().onGraphql("ProjectV2SingleSelectField", () => statusOptions), 504, { parent: true })
        .onGraphql("singleSelectOptionId", () => ({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } }))
      expect(await board(child).setState("504", "done")).toMatchObject({ to: "Done", changed: true })

      const off = withIssueItem(new FakeGh().onGraphql("ProjectV2SingleSelectField", () => statusOptions), 7, { item: null })
      await expect(board(off).setState("7", "ready")).rejects.toThrow("gh project item-add 2 --owner acme")
    })
  })

  it("claims through the text field and releases by clearing it", async () => {
    const fake = withIssueItem(new FakeGh(), 480, { item: makeProjectItem({ claim: { text: "review:old@2026-08-27T08:00Z" } }) })
      .onGraphql("value: { text: $text }", () => ({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } }))
      .onGraphql("clearProjectV2ItemFieldValue", () => ({ clearProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } }))
    const b = board(fake)
    const claimed = await b.claim("480", "dev", "sess-me", NOW)
    expect(claimed).toEqual({
      ref: "#480",
      claim: "dev:sess-me@2026-08-27T12:00Z",
      replaced: { role: "review", sessionId: "old", stampedAt: "2026-08-27T08:00Z" },
    })
    expect(fake.graphqlCalls("value: { text: $text }")[0]?.variables).toEqual({
      project: "PVT_exampleProject01", item: "PVTI_1", field: "PVTF_claim", text: "dev:sess-me@2026-08-27T12:00Z",
    })
    const released = await b.release("480")
    expect(released.released?.sessionId).toBe("old")
    expect(fake.graphqlCalls("clearProjectV2ItemFieldValue")[0]?.variables).toEqual({ project: "PVT_exampleProject01", item: "PVTI_1", field: "PVTF_claim" })
  })

  it("comments and edits labels over REST", async () => {
    const fake = new FakeGh()
      .onRest("POST", /issues\/480\/comments$/, () => ({ html_url: "https://github.com/acme/widgets/issues/480#issuecomment-1" }))
      .onRest("POST", /issues\/480\/labels$/, () => [])
      .onRest("DELETE", /issues\/480\/labels\/bug$/, () => null)
      .onRest("GET", /issues\/480\/labels/, () => [{ name: "ui" }, { name: "bug" }])
    const b = board(fake)
    expect(await b.comment("480", "**[dispatcher]**\n\nhello")).toEqual({ ref: "#480", url: "https://github.com/acme/widgets/issues/480#issuecomment-1" })
    expect(fake.calls[0]).toMatchObject({ kind: "rest", method: "POST", path: "repos/acme/widgets/issues/480/comments", body: { body: "**[dispatcher]**\n\nhello" } })
    expect(await b.label("480", "add", "bug")).toEqual(["ui", "bug"])
    expect(fake.calls[1]).toMatchObject({ kind: "rest", method: "POST", body: { labels: ["bug"] } })
    await b.label("480", "remove", "bug")
    expect(fake.calls[3]).toMatchObject({ kind: "rest", method: "DELETE", path: "repos/acme/widgets/issues/480/labels/bug" })
    // The retired label is refused on both boards, not just the live one.
    await expect(b.label("480", "add", "question")).rejects.toThrow('refusing to write the "question" label')
  })

  it("resolves a pull request through its closing references plus its branch and body", async () => {
    const fake = withIssueItem(new FakeGh().onGraphql("closingIssuesReferences(first: 25)", () => ({
      repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 402 }] } } },
    })), 402, { item: makeProjectItem({ status: { name: "User Review", optionId: "b2bb70ee" } }) })
    // The second issue named by the body has its own item query.
    fake.onGraphql("parent { number }\n      projectItems", (variables) => ({
      repository: {
        issue: {
          number: variables.number,
          title: `Task #${String(variables.number)}`,
          url: `https://github.com/acme/widgets/issues/${String(variables.number)}`,
          state: variables.number === 504 ? "CLOSED" : "OPEN",
          parent: null,
          projectItems: { nodes: [makeProjectItem({ status: variables.number === 504 ? { name: "Done", optionId: "98236657" } : { name: "User Review", optionId: "b2bb70ee" } })] },
        },
      },
    }))
    const issues = await board(fake).resolvePullRequest({
      number: 521, url: "https://github.com/acme/widgets/pull/521", headRef: "task/402-unity-plugin", title: "Unity", body: "Fixes #402\nFixes #504",
    })
    expect(issues.map((issue) => [issue.ref, issue.via, issue.stateRole, issue.closed])).toEqual([
      ["#402", "closing-reference", "humanReview", false],
      ["#504", "branch-or-body", "done", true],
    ])
  })

  it("explains that GitHub links pull requests through closing keywords", async () => {
    await expect(board(new FakeGh()).linkPullRequest("480", "https://github.com/acme/widgets/pull/1"))
      .rejects.toThrow('add "Fixes #480" to the body')
  })
})
