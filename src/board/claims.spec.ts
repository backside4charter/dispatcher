import { describe, expect, it } from "vitest"
import { claimAgeMinutes, formatClaim, formatClaimStamp, formatClaimText, isClaimStale, parseClaimText, resolveSessionId } from "./claims"
import type { Claim } from "./types"

const now = new Date("2026-08-27T12:00:00Z")

/**
 * Builds a claim as a backend would read it back, aged by the given minutes.
 */
function claimAgedMinutes(minutes: number, sessionId = "abc-123"): Claim {
  return {
    role: "dev",
    sessionId,
    stampedAt: formatClaimStamp(new Date(now.getTime() - minutes * 60_000)),
  }
}

describe("claim text", () => {
  it("formats a claim as role:session@minute-precision-UTC and parses it back", () => {
    const text = formatClaim("review", "46298788-3dfa-491d-b771-c104feedb236", new Date("2026-07-28T14:05:42Z"))
    expect(text).toBe("review:46298788-3dfa-491d-b771-c104feedb236@2026-07-28T14:05Z")
    expect(parseClaimText(text)).toEqual({
      role: "review",
      sessionId: "46298788-3dfa-491d-b771-c104feedb236",
      stampedAt: "2026-07-28T14:05Z",
    })
    expect(formatClaimText(claimAgedMinutes(0))).toBe("dev:abc-123@2026-08-27T12:00Z")
  })

  it("rejects text that is not a claim rather than guessing at it", () => {
    expect(parseClaimText(null)).toBeNull()
    expect(parseClaimText("")).toBeNull()
    expect(parseClaimText("GitHub #12")).toBeNull()
    expect(parseClaimText("owner:abc@2026-01-01T00:00Z")).toBeNull()
  })
})

describe("staleness", () => {
  it("measures age on the stamp the claim carries, which the re-stamp refreshes", () => {
    expect(claimAgeMinutes(claimAgedMinutes(42), now)).toBe(42)
  })

  it("reads the age out of the claim text alone, with no help from the platform", () => {
    // The heartbeat must not depend on how a tracker timestamps a record it
    // edits in place: that behaviour is unverified on Linear, and if an
    // in-place edit did not move it, a live claim would age past the window
    // and a second dispatcher would steal a row somebody is working.
    const parsed = parseClaimText(formatClaim("dev", "abc-123", new Date("2026-08-27T11:18:44Z")))

    expect(parsed).not.toBeNull()
    expect(parsed === null ? -1 : claimAgeMinutes(parsed, now)).toBe(42)
  })

  it("treats a claim from another session as stale after the window, never sooner", () => {
    expect(isClaimStale(claimAgedMinutes(89), now)).toBe(false)
    expect(isClaimStale(claimAgedMinutes(90), now)).toBe(true)
    expect(isClaimStale(claimAgedMinutes(500), now)).toBe(true)
    // The window is configurable per project.
    expect(isClaimStale(claimAgedMinutes(31), now, undefined, 30)).toBe(true)
  })

  it("never treats this session's own claim as stale - that worker is still running", () => {
    expect(isClaimStale(claimAgedMinutes(500, "me"), now, "me")).toBe(false)
    expect(isClaimStale(claimAgedMinutes(500, "someone-else"), now, "me")).toBe(true)
  })
})

describe("resolveSessionId", () => {
  it("prefers an explicit id, then the Claude Code session, then a marked unknown", () => {
    expect(resolveSessionId("given", { CLAUDE_CODE_SESSION_ID: "env" })).toBe("given")
    expect(resolveSessionId(undefined, { CLAUDE_CODE_SESSION_ID: "env" })).toBe("env")
    expect(resolveSessionId(undefined, {})).toMatch(/^unknown-[a-z0-9]+$/)
  })
})
