import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { consumePendingEvents, isListenerUp, readListenerHeartbeat, readPendingEvents } from "./event-log"
import { startListener } from "./listener"
import type { ListenerHandle } from "./listener"
import { FakeLinear, issuePage, makeIssueNode } from "./testing/linear-fixtures"

/** A GitHub-board Status edit, only meaningful on the GitHub platform. */
const boardStatusEditPayload = {
  action: "edited",
  projects_v2_item: { content_type: "Issue" },
  changes: {
    field_value: { field_name: "Status", field_type: "single_select", from: { name: "Ready" }, to: { name: "In Progress" } },
  },
  sender: { login: "the-owner", type: "User" },
}

/** Response body shape of the /webhook endpoint. */
const webhookResponseSchema = z.object({
  accepted: z.boolean(),
  summary: z.string().optional(),
  reason: z.string().optional(),
})

/** A pull_request opened payload as GitHub delivers it (trimmed to relevant fields). */
const prOpenedPayload = {
  action: "opened",
  pull_request: {
    number: 521,
    title: "Unity plugin foundation",
    merged: false,
    draft: false,
  },
  repository: { full_name: "acme/widgets" },
  sender: { login: "the-owner", type: "User" },
}

/** A synchronize payload - every push fires one, and none of them should wake the dispatcher. */
const prSynchronizePayload = {
  action: "synchronize",
  pull_request: { number: 521, title: "Unity plugin foundation", merged: false, draft: false },
  repository: { full_name: "acme/widgets" },
  sender: { login: "the-owner", type: "User" },
}

/**
 * Posts a webhook delivery to the listener the way `gh webhook forward` does.
 */
async function postDelivery(port: number, event: string, payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      ...headers,
    },
    body: JSON.stringify(payload),
  })
}

/**
 * Polls until the condition returns true or the timeout elapses.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

describe("startListener", () => {
  let dir: string
  let handle: ListenerHandle | null = null

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dispatcher-"))
  })

  afterEach(async () => {
    if (handle) {
      await handle.stop()
      handle = null
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it("accepts relevant deliveries, appends them to the log, and consume drains them exactly once", async () => {
    handle = await startListener({ dir, port: 0, forward: false })

    const res = await postDelivery(handle.port, "pull_request", prOpenedPayload)
    expect(res.status).toBe(202)
    const body = webhookResponseSchema.parse(await res.json())
    expect(body.accepted).toBe(true)

    const pending = readPendingEvents(dir)
    expect(pending.events).toHaveLength(1)
    expect(pending.events[0]?.event).toBe("pull_request")
    expect(pending.events[0]?.action).toBe("opened")
    expect(pending.events[0]?.summary).toBe("PR #521 opened: Unity plugin foundation [widgets]")
    expect(Number.isNaN(Date.parse(pending.events[0]?.receivedAt ?? ""))).toBe(false)

    // Reading pending events does not advance the cursor; consuming does.
    expect(readPendingEvents(dir).events).toHaveLength(1)
    expect(consumePendingEvents(dir)).toHaveLength(1)
    expect(consumePendingEvents(dir)).toHaveLength(0)
    expect(readPendingEvents(dir).events).toHaveLength(0)
  })

  it("acknowledges but does not log irrelevant deliveries", async () => {
    handle = await startListener({ dir, port: 0, forward: false })

    const res = await postDelivery(handle.port, "pull_request", prSynchronizePayload)
    expect(res.status).toBe(200)
    const body = webhookResponseSchema.parse(await res.json())
    expect(body.accepted).toBe(false)
    expect(body.reason).toBe("unsupported pull_request action: synchronize")

    expect(readPendingEvents(dir).events).toHaveLength(0)
  })

  it("maps the board's own webhook events only on the GitHub platform", async () => {
    handle = await startListener({ dir, port: 0, forward: false })
    const onLinear = await postDelivery(handle.port, "projects_v2_item", boardStatusEditPayload)
    expect(webhookResponseSchema.parse(await onLinear.json())).toEqual({ accepted: false, reason: "unsupported event: projects_v2_item" })
    await handle.stop()

    handle = await startListener({ dir, port: 0, forward: false, platform: "github" })
    const onGitHub = await postDelivery(handle.port, "projects_v2_item", boardStatusEditPayload)
    expect(onGitHub.status).toBe(202)
    expect(readPendingEvents(dir).events.map((event) => event.summary)).toEqual(["board item edited: Status (Ready -> In Progress)"])
  })

  it("rejects deliveries without an event header or with an unparseable body", async () => {
    handle = await startListener({ dir, port: 0, forward: false })

    const noHeader = await fetch(`http://127.0.0.1:${handle.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prOpenedPayload),
    })
    expect(noHeader.status).toBe(400)

    const badJson = await fetch(`http://127.0.0.1:${handle.port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: "{not json",
    })
    expect(badJson.status).toBe(400)

    expect(readPendingEvents(dir).events).toHaveLength(0)
  })

  it("serves a health endpoint and maintains a live heartbeat file", async () => {
    handle = await startListener({ dir, port: 0, forward: false, linearDisabledReason: "no key in this test" })

    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`)
    expect(res.status).toBe(200)

    const heartbeat = readListenerHeartbeat(dir)
    expect(heartbeat).not.toBeNull()
    expect(heartbeat?.pid).toBe(process.pid)
    expect(heartbeat?.port).toBe(handle.port)
    expect(heartbeat?.forward.enabled).toBe(false)
    expect(heartbeat?.linear).toEqual({
      enabled: false, running: false, polls: 0, errors: 0, lastPollAt: null, lastError: "no key in this test",
    })

    const up = isListenerUp(dir)
    expect(up.up).toBe(true)
  })

  it("counts accepted and ignored deliveries in the heartbeat", async () => {
    handle = await startListener({ dir, port: 0, forward: false })

    await postDelivery(handle.port, "pull_request", prOpenedPayload)
    await postDelivery(handle.port, "pull_request", prSynchronizePayload)

    const heartbeat = readListenerHeartbeat(dir)
    expect(heartbeat?.eventsAccepted).toBe(1)
    expect(heartbeat?.eventsIgnored).toBe(1)
  })

  it("restarts the forward process when it exits, recording restarts in the heartbeat", async () => {
    handle = await startListener({
      dir,
      port: 0,
      forward: true,
      forwardCommand: () => ({ command: process.execPath, args: ["-e", "process.exit(1)"] }),
      restartBackoffMs: { initial: 20, max: 50 },
      heartbeatIntervalMs: 25,
    })

    await waitUntil(() => (readListenerHeartbeat(dir)?.forward.restarts ?? 0) >= 2)
    const heartbeat = readListenerHeartbeat(dir)
    expect(heartbeat?.forward.enabled).toBe(true)
    expect(heartbeat?.forward.lastError).toContain("exited")
  })

  it("degrades to a recorded error when the forward command cannot be spawned at all", async () => {
    handle = await startListener({
      dir,
      port: 0,
      forward: true,
      forwardCommand: () => ({ command: "dispatcher-no-such-command-xyz", args: [] }),
      restartBackoffMs: { initial: 20, max: 50 },
      heartbeatIntervalMs: 25,
    })

    await waitUntil(() => (readListenerHeartbeat(dir)?.forward.lastError ?? null) !== null)
    const heartbeat = readListenerHeartbeat(dir)
    expect(heartbeat?.forward.running).toBe(false)
    expect(heartbeat?.forward.lastError).toContain("ENOENT")

    // The HTTP side keeps serving even though the forward channel is broken.
    const res = await postDelivery(handle.port, "pull_request", prOpenedPayload)
    expect(res.status).toBe(202)
  })

  it("polls Linear and logs board changes as events alongside webhook deliveries", async () => {
    const fake = new FakeLinear()
      .on((document, variables) => document.includes("issues(") && "state" in (variables.filter as Record<string, unknown>), () => issuePage([
        makeIssueNode({ identifier: "ACM-1", updatedAt: "2026-08-27T09:00:00.000Z" }),
      ]))
      .on((document, variables) => document.includes("issues(") && "updatedAt" in (variables.filter as Record<string, unknown>), (_variables, callIndex) => (callIndex === 0
        ? issuePage([makeIssueNode({ identifier: "ACM-1", updatedAt: "2026-08-27T09:30:00.000Z", state: { name: "Ready", type: "unstarted" }, assignee: null, labels: ["Question"] })])
        : issuePage([])))
      .onDocument("comments(", () => ({ comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }))

    handle = await startListener({
      dir,
      port: 0,
      forward: false,
      linear: { client: fake, projectId: "proj", intervalMs: 30 },
      heartbeatIntervalMs: 25,
    })

    await waitUntil(() => readPendingEvents(dir).events.length >= 1)
    const pending = readPendingEvents(dir)
    expect(pending.events[0]?.event).toBe("linear_issue")
    expect(pending.events[0]?.summary).toBe("linear ACM-1 labels Question: Task ACM-1")

    await waitUntil(() => (readListenerHeartbeat(dir)?.linear?.polls ?? 0) >= 2)
    const heartbeat = readListenerHeartbeat(dir)
    expect(heartbeat?.linear?.enabled).toBe(true)
    expect(heartbeat?.linear?.running).toBe(true)
    expect(heartbeat?.eventsAccepted).toBe(1)
    // A poll that finds nothing new writes nothing.
    expect(readPendingEvents(dir).events).toHaveLength(1)
  })

  it("removes the heartbeat file on a graceful stop", async () => {
    handle = await startListener({ dir, port: 0, forward: false })
    await handle.stop()
    handle = null
    expect(readListenerHeartbeat(dir)).toBeNull()
    const up = isListenerUp(dir)
    expect(up.up).toBe(false)
  })
})
