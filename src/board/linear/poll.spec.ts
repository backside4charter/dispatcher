import { describe, expect, it } from "vitest"
import type { BoardEvent } from "../../board-events"
import { FakeLinear, issuePage, makeIssueNode } from "../../testing/linear-fixtures"
import { formatClaimComment } from "../claim-comment"
import { createLinearPoller, describeChanges, diffSnapshots, latestOf, snapshotOf, summarizeComment } from "./poll"
import type { LinearPollState } from "./poll"
import { LEGACY_CLAIM_URL_PREFIX } from "./queries"

describe("snapshotOf", () => {
  it("captures the routed fields and ignores a leftover claim attachment from the old mechanism", () => {
    const snapshot = snapshotOf(makeIssueNode({
      identifier: "ACM-4",
      labels: ["UI", "Bug"],
      attachments: [
        { url: `${LEGACY_CLAIM_URL_PREFIX}ACM-4`, subtitle: "dev:s@2026-08-27T10:00Z" },
        { url: "https://github.com/acme/widgets/pull/9" },
      ],
    }))
    expect(snapshot.labels).toEqual(["Bug", "UI"])
    expect(snapshot.links).toEqual(["https://github.com/acme/widgets/pull/9"])
    expect(snapshot.closed).toBe(false)
  })
})

describe("diffSnapshots", () => {
  const ready = snapshotOf(makeIssueNode({ identifier: "ACM-4", title: "Widget" }))

  it("reports an unknown issue as created with its state", () => {
    const diff = diffSnapshots(new Map(), [ready])
    expect(diff.summaries).toEqual(["linear ACM-4 created (Ready): Widget"])
    expect(diff.next.get(ready.id)).toEqual(ready)
  })

  it("reports a state change and carries the new snapshot forward", () => {
    const cache = new Map([[ready.id, ready]])
    const moved = snapshotOf(makeIssueNode({ identifier: "ACM-4", title: "Widget", state: { name: "In Progress", type: "started" } }))
    const diff = diffSnapshots(cache, [moved])
    expect(diff.summaries).toEqual(["linear ACM-4 state Ready -> In Progress: Widget"])
    expect(diff.next.get(ready.id)?.state).toBe("In Progress")
  })

  it("caches an unknown closed issue silently - the baseline only holds open ones", () => {
    const done = snapshotOf(makeIssueNode({ identifier: "ACM-9", state: { name: "Done", type: "completed" } }))
    const diff = diffSnapshots(new Map(), [done])
    expect(diff.summaries).toEqual([])
    expect(diff.next.has(done.id)).toBe(true)
  })

  it("stays silent when only a leftover claim attachment changed, so tidying one up is not a link change", () => {
    const cache = new Map([[ready.id, ready]])
    const restamped = snapshotOf(makeIssueNode({
      identifier: "ACM-4",
      title: "Widget",
      updatedAt: "2026-08-27T11:00:00.000Z",
      attachments: [{ url: `${LEGACY_CLAIM_URL_PREFIX}ACM-4`, subtitle: "dev:s@2026-08-27T11:00Z" }],
    }))
    expect(diffSnapshots(cache, [restamped]).summaries).toEqual([])
  })

  it("names every routed field that changed in one summary", () => {
    const after = snapshotOf(makeIssueNode({
      identifier: "ACM-4", title: "Widget", assignee: "Lars", labels: ["Question"], milestone: "v1.2.0", sortOrder: 5,
    }))
    expect(describeChanges(ready, after)).toEqual([
      "assignee - -> Lars",
      "labels Question",
      "milestone v1.1.0 -> v1.2.0",
      "reordered",
    ])
  })
})

describe("latestOf", () => {
  it("follows the timestamps and never lets the local-clock fallback outrun them", () => {
    expect(latestOf([], "2026-08-27T12:00:00.000Z")).toBe("2026-08-27T12:00:00.000Z")
    // A local clock ahead of Linear's must not advance the cursor past real updates.
    expect(latestOf(["2026-08-27T09:00:00.000Z", "2026-08-27T09:31:00.000Z"], "2026-08-27T12:00:00.000Z")).toBe("2026-08-27T09:31:00.000Z")
  })
})

describe("summarizeComment", () => {
  it("uses the first non-empty line, truncated, with the author and issue", () => {
    const body = `\n\n**[dispatcher]**\n\n${"x".repeat(200)}`
    const summary = summarizeComment({ body, user: { displayName: "Lars" }, issue: { identifier: "ACM-4" } })
    expect(summary).toBe("linear comment on ACM-4 by Lars: **[dispatcher]**")
    const long = summarizeComment({ body: "y".repeat(200), user: null, issue: null })
    expect(long).toBe(`linear comment on ? by unknown: ${"y".repeat(77)}...`)
  })
})

describe("createLinearPoller", () => {
  /**
   * Wires a poller to a fake client and captures its output.
   */
  function harness(fake: FakeLinear): { events: BoardEvent[]; states: LinearPollState[]; poller: ReturnType<typeof createLinearPoller> } {
    const events: BoardEvent[] = []
    const states: LinearPollState[] = []
    const poller = createLinearPoller({
      client: fake,
      projectId: "proj",
      intervalMs: 60_000,
      onEvent: (event) => { events.push(event) },
      onState: (state) => { states.push(state) },
      now: () => new Date("2026-08-27T12:00:00Z"),
    })
    return { events, states, poller }
  }

  it("snapshots the baseline silently, then reports only what changed after it", async () => {
    const baseline = makeIssueNode({ identifier: "ACM-1", updatedAt: "2026-08-27T09:00:00.000Z" })
    const fake = new FakeLinear()
      .on((document, variables) => document.includes("issues(") && "state" in (variables.filter as Record<string, unknown>), () => issuePage([baseline]))
      .on((document, variables) => document.includes("issues(") && "updatedAt" in (variables.filter as Record<string, unknown>), (_variables, callIndex) => (callIndex === 0
        ? issuePage([
          makeIssueNode({ identifier: "ACM-1", updatedAt: "2026-08-27T09:30:00.000Z", state: { name: "In Progress", type: "started" } }),
          makeIssueNode({ identifier: "ACM-2", updatedAt: "2026-08-27T09:31:00.000Z" }),
        ])
        : issuePage([])))
      .onDocument("comments(", (_variables, callIndex) => ({
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: callIndex === 0
            ? [{ id: "c1", body: "Go with option B.", createdAt: "2026-08-27T12:00:05.000Z", user: { displayName: "Lars" }, issue: { identifier: "ACM-1" } }]
            : [],
        },
      }))
    const { events, states, poller } = harness(fake)

    await poller.start()
    expect(events).toEqual([])

    await poller.pollOnce()
    // The first poll asks for what changed after the baseline's latest update, on Linear's clock.
    const firstPoll = fake.calls.find((call) => call.document.includes("issues(") && "updatedAt" in (call.variables.filter as Record<string, unknown>))
    expect((firstPoll?.variables.filter as { updatedAt: { gt: string } }).updatedAt.gt).toBe("2026-08-27T09:00:00.000Z")
    expect(events.map((event) => [event.event, event.summary])).toEqual([
      ["linear_issue", "linear ACM-1 state Ready -> In Progress: Task ACM-1"],
      ["linear_issue", "linear ACM-2 created (Ready): Task ACM-2"],
      ["linear_comment", "linear comment on ACM-1 by Lars: Go with option B."],
    ])
    // The second poll asks only for what changed after the latest updatedAt seen.
    await poller.pollOnce()
    const polls = fake.calls.filter((call) => call.document.includes("issues(") && "updatedAt" in (call.variables.filter as Record<string, unknown>))
    expect((polls[1]?.variables.filter as { updatedAt: { gt: string } }).updatedAt.gt).toBe("2026-08-27T09:31:00.000Z")
    expect(events).toHaveLength(3)
    expect(states.at(-1)?.polls).toBe(2)
    expect(states.at(-1)?.errors).toBe(0)
    poller.stop()
    expect(states.at(-1)?.running).toBe(false)
  })

  it("never reports the dispatcher's own claim comment, so the loop cannot wake on its own heartbeat", async () => {
    const fake = new FakeLinear()
      .onDocument("issues(", () => issuePage([]))
      .onDocument("comments(", (_variables, callIndex) => ({
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: callIndex === 0
            ? [
              {
                id: "c-claim",
                body: formatClaimComment("dev", "sess-1", new Date("2026-08-27T12:00:00Z")),
                createdAt: "2026-08-27T12:00:05.000Z",
                user: { displayName: "someuser" },
                issue: { identifier: "ACM-1" },
              },
              {
                id: "c-real",
                body: "Go with option B.",
                createdAt: "2026-08-27T12:00:06.000Z",
                user: { displayName: "Lars" },
                issue: { identifier: "ACM-1" },
              },
            ]
            : [],
        },
      }))
    const { events, poller } = harness(fake)

    await poller.start()
    await poller.pollOnce()

    expect(events.map((event) => event.summary)).toEqual(["linear comment on ACM-1 by Lars: Go with option B."])
  })

  it("records a failed poll and keeps going rather than crashing the listener", async () => {
    let fail = true
    const fake = new FakeLinear()
      .onDocument("issues(", () => {
        if (fail) throw new Error("Linear responded 502")
        return issuePage([])
      })
      .onDocument("comments(", () => ({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }))
    const { states, poller } = harness(fake)

    await poller.start()
    expect(states.at(-1)?.errors).toBe(1)
    expect(states.at(-1)?.lastError).toContain("502")

    fail = false
    await poller.pollOnce()
    expect(states.at(-1)?.polls).toBe(1)
    poller.stop()
  })
})
