import { describe, expect, it } from "vitest"
import { DEFAULT_STATE_NAMES, guessStateRoles, repositoryFromRemoteUrl } from "./config-builder"
import type { DiscoveredState } from "./linear-discovery"

/**
 * Builds a discovered state at the next position.
 */
function state(name: string, type: string, position: number): DiscoveredState {
  return { name, type, position }
}

describe("guessStateRoles", () => {
  it("maps a standard board by name", () => {
    const guessed = guessStateRoles([
      state("Backlog", "backlog", 0),
      state("Ready", "unstarted", 1),
      state("Changes Requested", "unstarted", 2),
      state("In Progress", "started", 3),
      state("Question", "started", 4),
      state("Human Review", "started", 5),
      state("Done", "completed", 6),
    ])
    expect(guessed).toEqual(DEFAULT_STATE_NAMES)
  })

  it("maps renamed states by fragment and category, without reusing a state", () => {
    const guessed = guessStateRoles([
      state("Icebox", "backlog", 0),
      state("Todo", "unstarted", 1),
      state("Doing", "started", 2),
      state("In Review", "started", 3),
      state("Shipped", "completed", 4),
    ])
    expect(guessed.backlog).toBe("Icebox")
    expect(guessed.ready).toBe("Todo")
    expect(guessed.inProgress).toBe("Doing")
    expect(guessed.humanReview).toBe("In Review")
    expect(guessed.done).toBe("Shipped")
    // No plausible match: left undefined so the flow asks instead of guessing.
    expect(guessed.changesRequested).toBeUndefined()
    expect(guessed.question).toBeUndefined()
  })

  it("prefers the more specific name when fragments overlap", () => {
    const guessed = guessStateRoles([
      state("Changes Requested", "unstarted", 0),
      state("In Progress", "started", 1),
    ])
    expect(guessed.changesRequested).toBe("Changes Requested")
    expect(guessed.inProgress).toBe("In Progress")
  })
})

describe("repositoryFromRemoteUrl", () => {
  it("parses SSH, HTTPS and host-alias remotes", () => {
    expect(repositoryFromRemoteUrl("git@github.com:acme/widgets.git")).toBe("acme/widgets")
    expect(repositoryFromRemoteUrl("https://github.com/acme/widgets")).toBe("acme/widgets")
    expect(repositoryFromRemoteUrl("git@github.com-alias:acme/widgets.git")).toBe("acme/widgets")
  })

  it("reports nothing for an unreadable remote", () => {
    expect(repositoryFromRemoteUrl("not-a-remote")).toBeUndefined()
    expect(repositoryFromRemoteUrl("")).toBeUndefined()
  })
})
