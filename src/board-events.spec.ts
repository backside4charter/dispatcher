import { describe, expect, it } from "vitest"
import { PULL_REQUEST_FORWARD_EVENTS, forwardEventsFor, mapWebhookDelivery } from "./board-events"

/** The repository owner as a webhook `sender` object. */
const owner = { login: "the-owner", type: "User" }

/** The agent GitHub App's bot account as a webhook `sender` object. */
const bot = { login: "acme-developer[bot]", type: "Bot" }

describe("forwardEventsFor", () => {
  it("subscribes only the pull request events on Linear, and the board's own events too on GitHub", () => {
    // Every event name mapWebhookDelivery accepts for a platform must be in
    // that platform's subscription, or its deliveries never reach the
    // listener at all; and nothing extra, since unmapped deliveries are noise.
    expect([...PULL_REQUEST_FORWARD_EVENTS].sort()).toEqual(["pull_request", "pull_request_review"])
    expect(forwardEventsFor("linear").sort()).toEqual(["pull_request", "pull_request_review"])
    expect(forwardEventsFor("github").sort()).toEqual([
      "issue_comment", "issues", "projects_v2_item", "pull_request", "pull_request_review", "sub_issues",
    ])
  })
})

describe("mapWebhookDelivery", () => {
  it("ignores deliveries from bot senders (agent PR pushes and reviews)", () => {
    const result = mapWebhookDelivery("pull_request", {
      action: "opened",
      pull_request: { number: 452, title: "feat: something", merged: false },
      repository: { full_name: "acme/widgets" },
      sender: bot,
    })
    expect(result).toEqual({ accepted: false, reason: "bot sender" })
  })

  it("ignores senders whose login ends in [bot] even when the type field is missing", () => {
    const result = mapWebhookDelivery("projects_v2_item", {
      action: "edited",
      sender: { login: "github-project-automation[bot]" },
    }, "github")
    expect(result).toEqual({ accepted: false, reason: "bot sender" })
  })

  it("accepts a merged pull request with the short repo name in the summary", () => {
    const result = mapWebhookDelivery("pull_request", {
      action: "closed",
      pull_request: { number: 452, title: "Add emote palette", merged: true },
      repository: { full_name: "acme/widgets" },
      sender: owner,
    })
    expect(result).toEqual({
      accepted: true,
      action: "closed",
      summary: "PR #452 merged: Add emote palette [widgets]",
    })
  })

  it("distinguishes a closed-unmerged pull request from a merge", () => {
    const result = mapWebhookDelivery("pull_request", {
      action: "closed",
      pull_request: { number: 452, title: "Add emote palette", merged: false },
      repository: { full_name: "acme/widgets" },
      sender: owner,
    })
    expect(result).toEqual({
      accepted: true,
      action: "closed",
      summary: "PR #452 closed: Add emote palette [widgets]",
    })
  })

  it("accepts pull request lifecycle actions the dispatcher routes on", () => {
    const result = mapWebhookDelivery("pull_request", {
      action: "ready_for_review",
      pull_request: { number: 460, title: "Fix widget", merged: false },
      repository: { full_name: "acme/widgets" },
      sender: owner,
    })
    expect(result).toEqual({
      accepted: true,
      action: "ready_for_review",
      summary: "PR #460 ready_for_review: Fix widget [widgets]",
    })
  })

  it("ignores noisy pull request actions like synchronize", () => {
    const result = mapWebhookDelivery("pull_request", {
      action: "synchronize",
      pull_request: { number: 452, title: "Add emote palette", merged: false },
      sender: owner,
    })
    expect(result).toEqual({ accepted: false, reason: "unsupported pull_request action: synchronize" })
  })

  it("accepts a submitted pull request review and ignores other review actions", () => {
    expect(mapWebhookDelivery("pull_request_review", {
      action: "submitted",
      review: { state: "commented", user: { login: "the-owner" } },
      pull_request: { number: 452, title: "Add emote palette" },
      repository: { full_name: "acme/widgets" },
      sender: owner,
    })).toEqual({
      accepted: true,
      action: "submitted",
      summary: "PR #452 review submitted (commented) by the-owner [widgets]",
    })
    expect(mapWebhookDelivery("pull_request_review", {
      action: "dismissed",
      review: { state: "changes_requested", user: { login: "the-owner" } },
      pull_request: { number: 452, title: "Add emote palette" },
      sender: owner,
    })).toEqual({ accepted: false, reason: "unsupported pull_request_review action: dismissed" })
  })

  it("maps the GitHub board's events only when GitHub is the platform", () => {
    const statusEdit = {
      action: "edited",
      changes: { field_value: { field_name: "Status", field_type: "single_select", from: { name: "Ready" }, to: { name: "In Progress" } } },
      sender: owner,
    }
    expect(mapWebhookDelivery("projects_v2_item", statusEdit, "github")).toEqual({
      accepted: true, action: "edited", summary: "board item edited: Status (Ready -> In Progress)",
    })
    expect(mapWebhookDelivery("projects_v2_item", statusEdit, "linear")).toEqual({ accepted: false, reason: "unsupported event: projects_v2_item" })
    expect(mapWebhookDelivery("projects_v2_item", statusEdit)).toEqual({ accepted: false, reason: "unsupported event: projects_v2_item" })
  })

  it("ignores webhook events no platform has a use for", () => {
    expect(mapWebhookDelivery("star", { action: "created", sender: owner }, "github")).toEqual({ accepted: false, reason: "unsupported event: star" })
  })

  it("ignores payloads that are not objects", () => {
    const result = mapWebhookDelivery("pull_request", "not an object")
    expect(result).toEqual({ accepted: false, reason: "malformed payload" })
  })

  it("ignores event payloads missing the fields their event requires", () => {
    const result = mapWebhookDelivery("pull_request", { action: "closed", sender: owner })
    expect(result).toEqual({ accepted: false, reason: "malformed payload" })
  })
})
