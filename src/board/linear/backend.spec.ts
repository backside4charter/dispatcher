import { describe, expect, it } from "vitest"
import {
  FakeLinear,
  LINEAR_TEST_CONFIG,
  issuePage,
  makeIssueNode,
  withClaimState,
  withIssueRef,
  withTeamStates,
} from "../../testing/linear-fixtures"
import { formatClaimComment } from "../claim-comment"
import { LinearBoard } from "./backend"

const DEVELOPER = { id: "agent-developer", displayName: "acme-developer" }
const REVIEWER = { id: "agent-reviewer", displayName: "acme-reviewer" }

/**
 * Registers the delegate and claim-comment mutations, so a claim write can be
 * inspected without also asserting the responses.
 */
function withClaimWrites(fake: FakeLinear): FakeLinear {
  return fake
    .onDocument("issueUpdate(id: $id, input: { delegateId: $delegateId })", () => ({
      issueUpdate: { success: true, issue: { identifier: "ACM-12", assignee: { displayName: "someuser" }, delegate: DEVELOPER } },
    }))
    .onDocument("issueUpdate(id: $id, input: { delegateId: null, assigneeId: null })", () => ({
      issueUpdate: { success: true, issue: { identifier: "ACM-12", assignee: null, delegate: null } },
    }))
    .onDocument("commentCreate", (variables) => ({
      commentCreate: {
        success: true,
        comment: { id: "c-claim", body: String((variables.input as { body: string }).body), updatedAt: "2026-08-27T12:00:00.000Z" },
      },
    }))
    .onDocument("commentUpdate", (variables) => ({
      commentUpdate: {
        success: true,
        comment: { id: String(variables.id), body: String((variables.input as { body: string }).body), updatedAt: "2026-08-27T12:00:00.000Z" },
      },
    }))
    .onDocument("commentDelete", () => ({ commentDelete: { success: true } }))
}

const NOW = new Date("2026-08-27T12:00:00Z")

/**
 * Builds a backend over a fake client.
 */
function board(fake: FakeLinear): LinearBoard {
  return new LinearBoard(LINEAR_TEST_CONFIG, "acme/widgets", fake)
}

describe("LinearBoard", () => {
  it("normalizes identifiers and rejects anything else", () => {
    const b = board(new FakeLinear())
    expect(b.normalizeRef("acm-12")).toBe("ACM-12")
    expect(() => b.normalizeRef("480")).toThrow("expected an issue identifier like ACM-12")
    expect(b.labels.ui).toBe("UI")
  })

  it("reads the team's states with the role each plays", async () => {
    const states = await board(withTeamStates(new FakeLinear())).states()
    expect(states.map((state) => [state.name, state.role, state.closed])).toEqual([
      ["Backlog", "backlog", false],
      ["Ready", "ready", false],
      ["In Progress", "inProgress", false],
      ["Changes Requested", "changesRequested", false],
      ["Question", "question", false],
      ["Human Review", "humanReview", false],
      ["Done", "done", true],
      ["Canceled", null, true],
    ])
  })

  it("counts open issues per milestone", async () => {
    const fake = new FakeLinear()
      .onDocument("projectMilestones", () => ({ project: { projectMilestones: { nodes: [{ id: "m1", name: "v1.1.0" }, { id: "m2", name: "v1.2.0" }] } } }))
      .onDocument("issues(first: 250", () => ({
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ projectMilestone: { name: "v1.1.0" } }, { projectMilestone: { name: "v1.1.0" } }, { projectMilestone: null }],
        },
      }))
    expect(await board(fake).milestones()).toEqual([
      { name: "v1.1.0", open: 2 },
      { name: "v1.2.0", open: 0 },
      { name: "(none)", open: 1 },
    ])
  })

  it("polls with a server-side filter on the whole milestone set, open issues only by default", async () => {
    const fake = new FakeLinear().onDocument("issues(first: 50", () => issuePage([makeIssueNode({ identifier: "ACM-1" })]))
    const rows = await board(fake).poll({ milestones: ["v1.1.0", "v1.0.1"], includeClosed: false })
    expect(rows.map((row) => row.ref)).toEqual(["ACM-1"])
    expect(fake.calls[0]?.variables.filter).toEqual({
      project: { id: { eq: "proj-1" } },
      projectMilestone: { name: { in: ["v1.1.0", "v1.0.1"] } },
      state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    })
    await board(fake).poll({ milestones: "all", includeClosed: true })
    expect(fake.calls[1]?.variables.filter).toEqual({ project: { id: { eq: "proj-1" } } })
  })

  describe("the poll's claim lookup", () => {
    it("asks for no comments at all when nothing on the board is delegated", async () => {
      const fake = new FakeLinear().onDocument("issues(first: 50", () => issuePage([
        makeIssueNode({ identifier: "ACM-1" }),
        makeIssueNode({ identifier: "ACM-2" }),
      ]))
      const rows = await board(fake).poll({ milestones: "all", includeClosed: false })

      expect(rows.map((row) => row.claim)).toEqual([null, null])
      expect(rows.map((row) => row.delegate)).toEqual([null, null])
      // The whole point of splitting the query: an undelegated board costs one
      // round trip, and no comment body crosses the wire.
      expect(fake.callsTo("comments")).toHaveLength(0)
    })

    it("fetches comments for the delegated rows only, and never for the rest", async () => {
      const fake = new FakeLinear()
        .onDocument("issues(first: 50", () => issuePage([
          makeIssueNode({ identifier: "ACM-1" }),
          makeIssueNode({ identifier: "ACM-2", delegate: DEVELOPER }),
          makeIssueNode({ identifier: "ACM-3", delegate: REVIEWER }),
        ]))
        .onDocument("id: { in: $ids }", () => ({
          issues: {
            nodes: [
              {
                id: "id-ACM-2",
                comments: {
                  nodes: [
                    { id: "c-other", body: "**[developer]**\n\nPR is up", updatedAt: "2026-08-27T11:00:00.000Z" },
                    { id: "c-claim", body: formatClaimComment("dev", "sess-2", new Date("2026-08-27T11:45:00Z")), updatedAt: "2026-08-27T11:45:00.000Z" },
                  ],
                },
              },
              { id: "id-ACM-3", comments: { nodes: [] } },
            ],
          },
        }))
      const rows = await board(fake).poll({ milestones: "all", includeClosed: false })

      expect(fake.callsTo("id: { in: $ids }")).toHaveLength(1)
      // `first` is passed explicitly and covers the whole id set: without it
      // the selection silently takes Linear's default page of 50, and every
      // delegated row past the fiftieth reads as unclaimed and stealable.
      expect(fake.callsTo("id: { in: $ids }")[0]?.variables).toEqual({ ids: ["id-ACM-2", "id-ACM-3"], first: 2 })

      const byRef = new Map(rows.map((row) => [row.ref, row]))
      expect(byRef.get("ACM-1")?.claim).toBeNull()
      expect(byRef.get("ACM-2")?.claim).toEqual({ role: "dev", sessionId: "sess-2", stampedAt: "2026-08-27T11:45Z" })
      expect(byRef.get("ACM-2")?.delegate).toBe("acme-developer")
      // Delegated but unclaimed: queued for the reviewer, nobody working it.
      expect(byRef.get("ACM-3")?.claim).toBeNull()
      expect(byRef.get("ACM-3")?.delegate).toBe("acme-reviewer")
    })
  })

  it("follows pagination cursors", async () => {
    const fake = new FakeLinear().onDocument("issues(first: 50", (variables) => (variables.after === null
      ? { issues: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [makeIssueNode({ identifier: "ACM-1" })] } }
      : issuePage([makeIssueNode({ identifier: "ACM-2" })])))
    const rows = await board(fake).poll({ milestones: "all", includeClosed: false })
    expect(rows.map((row) => row.ref)).toEqual(["ACM-1", "ACM-2"])
  })

  it("reads an issue in full, with comments oldest first", async () => {
    const node = makeIssueNode({ identifier: "ACM-3", title: "Unity Plugin", state: { name: "Human Review", type: "started" } })
    const fake = new FakeLinear().onDocument("comments(first: 100)", () => ({
      issue: {
        ...node,
        description: "Add support for Unity.",
        parent: null,
        children: {
          nodes: [{
            identifier: "ACM-208",
            title: "Docs",
            state: { name: "Ready", type: "unstarted" },
            inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ACM-207", state: { type: "unstarted" } } }] },
          }],
        },
        inverseRelations: { nodes: [{ type: "blocks", issue: { identifier: "ACM-6", title: "Bun", state: { name: "Done", type: "completed" } } }] },
        comments: {
          nodes: [
            { id: "c2", body: "Second", createdAt: "2026-08-27T11:00:00.000Z", updatedAt: "2026-08-27T11:00:00.000Z", user: { displayName: "Lars" } },
            { id: "c1", body: "First", createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z", user: null },
          ],
        },
      },
    }))
    const issue = await board(fake).issue("acm-3")
    expect(fake.calls[0]?.variables.id).toBe("ACM-3")
    expect(issue.stateRole).toBe("humanReview")
    expect(issue.description).toBe("Add support for Unity.")
    expect(issue.blockers).toEqual([{ ref: "ACM-6", title: "Bun", state: "Done" }])
    expect(issue.childIssues).toEqual([{ ref: "ACM-208", title: "Docs", state: "Ready", openBlockers: ["ACM-207"] }])
    expect(issue.comments.map((comment) => [comment.author, comment.body])).toEqual([["unknown", "First"], ["Lars", "Second"]])
    expect(issue.commentCount).toBe(2)
  })

  it("reads the claim off the comments and keeps it out of the conversation", async () => {
    const node = makeIssueNode({ identifier: "ACM-12", delegate: REVIEWER })
    const fake = new FakeLinear().onDocument("comments(first: 100)", () => ({
      issue: {
        ...node,
        description: null,
        parent: null,
        children: { nodes: [] },
        inverseRelations: { nodes: [] },
        comments: {
          nodes: [
            { id: "c1", body: "Owner says hello", createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z", user: { displayName: "Lars" } },
            {
              id: "c-claim",
              body: formatClaimComment("review", "sess-live", new Date("2026-08-27T11:50:00Z")),
              createdAt: "2026-08-27T11:00:00.000Z",
              updatedAt: "2026-08-27T11:50:00.000Z",
              user: { displayName: "someuser" },
            },
          ],
        },
      },
    }))
    const issue = await board(fake).issue("ACM-12")

    expect(issue.claim).toEqual({ role: "review", sessionId: "sess-live", stampedAt: "2026-08-27T11:50Z" })
    expect(issue.delegate).toBe("acme-reviewer")
    // Bookkeeping, not conversation: a worker prompt must not read the claim
    // as something the owner said.
    expect(issue.comments.map((comment) => comment.body)).toEqual(["Owner says hello"])
    expect(issue.commentCount).toBe(1)
  })

  describe("setState", () => {
    it("moves an issue by role or by display name, resolving against the live team", async () => {
      const fake = withIssueRef(withTeamStates(new FakeLinear()), { identifier: "ACM-12" })
        .onDocument("issueUpdate(id: $id, input: { stateId: $stateId })", () => ({
          issueUpdate: { success: true, issue: { identifier: "ACM-12", state: { name: "In Progress" } } },
        }))
      expect(await board(fake).setState("ACM-12", "inProgress")).toEqual({ ref: "ACM-12", from: "Ready", to: "In Progress", changed: true })
      expect(fake.callsTo("issueUpdate")[0]?.variables).toEqual({ id: "id-ACM-12", stateId: "st-in-progress" })
      expect(await board(fake).setState("ACM-12", "in progress")).toMatchObject({ to: "In Progress", changed: true })
    })

    it("is a no-op when the issue is already there", async () => {
      const fake = withIssueRef(withTeamStates(new FakeLinear()), { identifier: "ACM-12" })
      expect(await board(fake).setState("ACM-12", "ready")).toEqual({ ref: "ACM-12", from: "Ready", to: "Ready", changed: false })
      expect(fake.callsTo("issueUpdate")).toHaveLength(0)
    })

    it("refuses to complete a top-level task but completes a sub-issue", async () => {
      const top = withIssueRef(withTeamStates(new FakeLinear()), { identifier: "ACM-12" })
      await expect(board(top).setState("ACM-12", "done")).rejects.toThrow("refusing to set ACM-12 to Done")
      expect(top.callsTo("issueUpdate")).toHaveLength(0)

      const child = withIssueRef(withTeamStates(new FakeLinear()), { identifier: "ACM-204", parent: { identifier: "ACM-3", milestone: "v1.1.0" } })
        .onDocument("issueUpdate(id: $id, input: { stateId: $stateId })", () => ({
          issueUpdate: { success: true, issue: { identifier: "ACM-204", state: { name: "Done" } } },
        }))
      expect(await board(child).setState("ACM-204", "Done")).toMatchObject({ to: "Done", changed: true })
    })

    it("names the team's states when the requested one does not exist", async () => {
      await expect(board(withTeamStates(new FakeLinear())).setState("ACM-12", "User Review"))
        .rejects.toThrow('unknown state "User Review"; the team has: Backlog, Ready')
    })
  })

  describe("claims", () => {
    it("delegates to the role's agent and posts the claim comment", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), { identifier: "ACM-12" }))
      const result = await board(fake).claim("ACM-12", "dev", "sess-me", NOW)

      expect(result).toEqual({ ref: "ACM-12", claim: "dev:sess-me@2026-08-27T12:00Z", replaced: null })
      expect(fake.callsTo("delegateId: $delegateId")[0]?.variables).toEqual({ id: "id-ACM-12", delegateId: "agent-developer" })
      expect(fake.callsTo("commentCreate")[0]?.variables).toEqual({
        input: { issueId: "id-ACM-12", body: "**[developer]** claimed 2026-08-27T12:00Z · `claude --resume sess-me`" },
      })
      // The delegate is written before the comment, so a half-written claim
      // leaves a row that looks held rather than one that looks free.
      expect(fake.calls.findIndex((call) => call.document.includes("delegateId: $delegateId")))
        .toBeLessThan(fake.calls.findIndex((call) => call.document.includes("commentCreate")))
    })

    it("delegates cleanup work to the developer, since one agent covers both roles", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), { identifier: "ACM-12" }))
      await board(fake).claim("ACM-12", "cleanup", "sess-me", NOW)
      expect(fake.callsTo("delegateId: $delegateId")[0]?.variables).toEqual({ id: "id-ACM-12", delegateId: "agent-developer" })
      // The role the delegate cannot carry survives in the comment.
      expect(fake.callsTo("commentCreate")[0]?.variables).toMatchObject({
        input: { body: "**[cleaner]** claimed 2026-08-27T12:00Z · `claude --resume sess-me`" },
      })
    })

    it("re-stamps by editing the existing comment, so a heartbeat is not a new comment", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), {
        identifier: "ACM-12",
        delegate: DEVELOPER,
        comments: [{ id: "c-old", body: formatClaimComment("dev", "dead-session", new Date("2026-08-27T08:00:00Z")) }],
      }))
      const claimed = await board(fake).claim("ACM-12", "review", "sess-me", NOW)

      expect(claimed.replaced).toEqual({ role: "dev", sessionId: "dead-session", stampedAt: "2026-08-27T08:00Z" })
      expect(fake.callsTo("commentCreate")).toHaveLength(0)
      expect(fake.callsTo("commentUpdate")[0]?.variables).toEqual({
        id: "c-old",
        input: { body: "**[reviewer]** claimed 2026-08-27T12:00Z · `claude --resume sess-me`" },
      })
      expect(fake.callsTo("delegateId: $delegateId")[0]?.variables).toEqual({ id: "id-ACM-12", delegateId: "agent-reviewer" })
    })

    it("re-stamps a body that differs from the last one, so the write is never a no-op", async () => {
      // The heartbeat's whole point: an identical body would leave staleness
      // resting on whether Linear moves a comment's own timestamp for an
      // update that changes nothing.
      const fake = withClaimWrites(withClaimState(new FakeLinear(), {
        identifier: "ACM-12",
        delegate: DEVELOPER,
        comments: [{ id: "c-old", body: formatClaimComment("dev", "sess-me", new Date("2026-08-27T11:30:00Z")) }],
      }))
      await board(fake).claim("ACM-12", "dev", "sess-me", NOW)

      const written = fake.callsTo("commentUpdate")[0]?.variables as { input: { body: string } } | undefined
      expect(written?.input.body).toBe("**[developer]** claimed 2026-08-27T12:00Z · `claude --resume sess-me`")
      expect(written?.input.body).not.toBe(formatClaimComment("dev", "sess-me", new Date("2026-08-27T11:30:00Z")))
    })

    it("releases by clearing the delegate and the assignee, and deleting the comment", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), {
        identifier: "ACM-12",
        assignee: "someuser",
        delegate: DEVELOPER,
        comments: [{ id: "c-claim", body: formatClaimComment("dev", "sess-me", new Date("2026-08-27T11:30:00Z")) }],
      }))
      const released = await board(fake).release("ACM-12")

      expect(released.released?.sessionId).toBe("sess-me")
      // Linear leaves the assignee behind when a delegate is cleared, and a
      // row with an assignee and no delegate reads as human-owned - which
      // would make every worked row permanently undispatchable.
      expect(fake.callsTo("delegateId: null, assigneeId: null")).toHaveLength(1)
      expect(fake.callsTo("commentDelete")[0]?.variables).toEqual({ id: "c-claim" })
    })

    it("reports an unclaimed issue on release rather than failing, and writes nothing", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), { identifier: "ACM-12" }))
      expect(await board(fake).release("ACM-12")).toEqual({ ref: "ACM-12", released: null, delegate: null })
      expect(fake.callsTo("delegateId: null, assigneeId: null")).toHaveLength(0)
      expect(fake.callsTo("commentDelete")).toHaveLength(0)
    })

    it("tolerates half a claim in either direction", async () => {
      const orphanDelegate = withClaimWrites(withClaimState(new FakeLinear(), { identifier: "ACM-12", delegate: REVIEWER }))
      // The half-state the write ordering produces: an agent apparently holds
      // the row with no session on it. The release reports the delegate it
      // cleared, so a caller can say what actually happened.
      expect(await board(orphanDelegate).release("ACM-12")).toEqual({ ref: "ACM-12", released: null, delegate: "reviewer" })
      expect(orphanDelegate.callsTo("delegateId: null, assigneeId: null")).toHaveLength(1)
      expect(orphanDelegate.callsTo("commentDelete")).toHaveLength(0)

      const orphanComment = withClaimWrites(withClaimState(new FakeLinear(), {
        identifier: "ACM-12",
        comments: [{ id: "c-claim", body: formatClaimComment("review", "sess-gone", NOW) }],
      }))
      expect((await board(orphanComment).release("ACM-12")).released?.sessionId).toBe("sess-gone")
      expect(orphanComment.callsTo("delegateId: null, assigneeId: null")).toHaveLength(0)
      expect(orphanComment.callsTo("commentDelete")).toHaveLength(1)
    })

    it("leaves a delegate the dispatcher does not run alone, so an owner takeover survives release", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), {
        identifier: "ACM-12",
        assignee: "someuser",
        delegate: { id: "some-other-agent", displayName: "somebody-else" },
      }))
      expect(await board(fake).release("ACM-12")).toEqual({ ref: "ACM-12", released: null, delegate: null })
      expect(fake.callsTo("delegateId: null, assigneeId: null")).toHaveLength(0)
    })

    it("refuses to take over a delegate the dispatcher does not run, at both ends of the lifecycle", async () => {
      // `release` has always left a stranger's delegate alone. If `claim` and
      // `assign` overwrote one, the lifecycle would contradict itself: we
      // could take somebody else's agent's row and never hand it back. Failing
      // loudly also makes the poll's blind spot harmless - a board row carries
      // the delegate's display name, not its id, so the eligibility read is by
      // name and this is the backstop when that read goes wrong.
      const foreign = () => withClaimWrites(withClaimState(new FakeLinear(), {
        identifier: "ACM-12",
        assignee: "someuser",
        delegate: { id: "some-other-agent", displayName: "somebody-else" },
      }))

      const claiming = foreign()
      await expect(board(claiming).claim("ACM-12", "dev", "sess-me", NOW))
        .rejects.toThrow("refusing to claim ACM-12: it is delegated to somebody-else")
      expect(claiming.callsTo("delegateId: $delegateId")).toHaveLength(0)
      expect(claiming.callsTo("commentCreate")).toHaveLength(0)

      const assigning = foreign()
      await expect(board(assigning).assign("ACM-12", "reviewer"))
        .rejects.toThrow("refusing to hand to the reviewer ACM-12: it is delegated to somebody-else")
      expect(assigning.callsTo("delegateId: $delegateId")).toHaveLength(0)
    })

    it("still lets the dispatcher move its own agents' delegates between phases", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), { identifier: "ACM-12", delegate: REVIEWER }))
      await board(fake).claim("ACM-12", "dev", "sess-me", NOW)
      expect(fake.callsTo("delegateId: $delegateId")[0]?.variables).toEqual({ id: "id-ACM-12", delegateId: "agent-developer" })
    })
  })

  describe("assign", () => {
    it("hands the row to the next agent and clears the claim, without claiming a session", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), {
        identifier: "ACM-12",
        delegate: DEVELOPER,
        comments: [{ id: "c-claim", body: formatClaimComment("dev", "sess-done", NOW) }],
      }))
      const result = await board(fake).assign("ACM-12", "reviewer")

      expect(result).toMatchObject({ ref: "ACM-12", agent: "reviewer", previous: "developer" })
      expect(result.released?.sessionId).toBe("sess-done")
      expect(fake.callsTo("delegateId: $delegateId")[0]?.variables).toEqual({ id: "id-ACM-12", delegateId: "agent-reviewer" })
      expect(fake.callsTo("commentDelete")[0]?.variables).toEqual({ id: "c-claim" })
      // A handoff is not a claim: nothing holds the row until a session takes it.
      expect(fake.callsTo("commentCreate")).toHaveLength(0)
      expect(fake.callsTo("commentUpdate")).toHaveLength(0)
    })

    it("reports no previous agent on an undelegated row", async () => {
      const fake = withClaimWrites(withClaimState(new FakeLinear(), { identifier: "ACM-12" }))
      expect(await board(fake).assign("ACM-12", "developer")).toEqual({
        ref: "ACM-12", agent: "developer", previous: null, released: null,
      })
    })
  })

  it("posts comments, edits labels by name, and links pull requests", async () => {
    const fake = withIssueRef(new FakeLinear(), { identifier: "ACM-12" })
      .onDocument("commentCreate", () => ({ commentCreate: { success: true, comment: { id: "c1", url: "https://linear.app/c1" } } }))
      .onDocument("issueLabels(filter", (variables) => ({
        issueLabels: { nodes: variables.name === "UI" ? [{ id: "lbl-ui", name: "UI" }] : [] },
      }))
      .onDocument("issueUpdate(id: $id, input: $input)", () => ({
        issueUpdate: { success: true, issue: { identifier: "ACM-12", labels: { nodes: [{ name: "UI" }] } } },
      }))
      .onDocument("attachmentLinkGitHubPR", (variables) => ({
        attachmentLinkGitHubPR: { success: true, attachment: { id: "att-pr", url: String(variables.url) } },
      }))
    const b = board(fake)

    expect(await b.comment("ACM-12", "**[dispatcher]**\n\nPR link")).toEqual({ ref: "ACM-12", url: "https://linear.app/c1" })
    expect(fake.callsTo("commentCreate")[0]?.variables).toEqual({ input: { issueId: "id-ACM-12", body: "**[dispatcher]**\n\nPR link" } })

    expect(await b.label("ACM-12", "add", "UI")).toEqual(["UI"])
    expect(fake.callsTo("issueUpdate(id: $id, input: $input)")[0]?.variables).toEqual({ id: "id-ACM-12", input: { addedLabelIds: ["lbl-ui"] } })
    await expect(b.label("ACM-12", "remove", "Confirm with user")).rejects.toThrow('no label named "Confirm with user"')

    // The Question label became a state; writing it would let a worker believe
    // it had parked a task when it had not.
    await expect(b.label("ACM-12", "add", "Question")).rejects.toThrow('refusing to write the "Question" label')
    await expect(b.label("ACM-12", "remove", "question")).rejects.toThrow("board state <ref> question")

    await b.linkPullRequest("ACM-12", "https://github.com/acme/widgets/pull/600")
    expect(fake.callsTo("attachmentLinkGitHubPR")[0]?.variables).toEqual({ issueId: "id-ACM-12", url: "https://github.com/acme/widgets/pull/600" })
  })
})
