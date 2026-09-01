import { describe, expect, it } from "vitest"
import { CLAIM_ROLE_TAGS, agentForClaimRole, formatClaimComment, isClaimComment, parseClaimComment } from "./claim-comment"
import { CLAIM_ROLES, claimAgeMinutes } from "./claims"

const AT_12_00 = new Date("2026-08-27T12:00:30.000Z")
const AT_12_01 = new Date("2026-08-27T12:01:05.000Z")

describe("formatClaimComment", () => {
  it("writes one line naming the role, when it was stamped, and the command that reopens the session", () => {
    expect(formatClaimComment("dev", "eded70f3-9199-411f-b7a0-62a6df8eabb4", AT_12_00))
      .toBe("**[developer]** claimed 2026-08-27T12:00Z · `claude --resume eded70f3-9199-411f-b7a0-62a6df8eabb4`")
    expect(formatClaimComment("review", "sess-1", AT_12_00)).toBe("**[reviewer]** claimed 2026-08-27T12:00Z · `claude --resume sess-1`")
    expect(formatClaimComment("cleanup", "sess-1", AT_12_00)).toBe("**[cleaner]** claimed 2026-08-27T12:00Z · `claude --resume sess-1`")
  })

  it("changes the body whenever the UTC minute has moved, so a re-stamp is never a no-op write", () => {
    // This is the whole reason the timestamp is in the body. Re-stamping used
    // to write a byte-identical string, which left the heartbeat resting on
    // whether Linear bumps a comment's `updatedAt` for an update that changes
    // nothing - unverified, and if it does not, a live claim ages past the
    // staleness window and a second dispatcher steals a row somebody is
    // working. The stamp is now what staleness is measured on, so no platform
    // field is involved at all.
    const first = formatClaimComment("dev", "sess-1", AT_12_00)
    const second = formatClaimComment("dev", "sess-1", AT_12_01)

    expect(second).not.toBe(first)
  })

  it("keeps the resume command at the end of the line, unbroken, so it can be copy-pasted", () => {
    expect(formatClaimComment("dev", "sess-1", AT_12_00)).toMatch(/`claude --resume sess-1`$/)
    expect(formatClaimComment("dev", "sess-1", AT_12_00)).not.toContain("\n")
  })
})

describe("parseClaimComment", () => {
  it("round-trips every claim role, carrying the stamp back out of the body", () => {
    for (const role of CLAIM_ROLES) {
      expect(parseClaimComment(formatClaimComment(role, "sess-42", AT_12_00)))
        .toEqual({ role, sessionId: "sess-42", stampedAt: "2026-08-27T12:00Z" })
    }
  })

  it("yields a stamp the staleness clock can read directly", () => {
    const parsed = parseClaimComment(formatClaimComment("dev", "sess-1", AT_12_00))

    expect(parsed).not.toBeNull()
    expect(claimAgeMinutes({ stampedAt: parsed?.stampedAt ?? "" }, new Date("2026-08-27T13:30:00.000Z"))).toBe(90)
  })

  it("ignores an ordinary role-tagged comment, which carries no `claimed` marker", () => {
    expect(parseClaimComment("**[developer]**\n\nPR is up: https://github.com/x/y/pull/1")).toBeNull()
    expect(parseClaimComment("**[dispatcher]**\n\nDispatched a developer.")).toBeNull()
    expect(parseClaimComment("**[reviewer]**\n\nCHANGES_REQUESTED")).toBeNull()
  })

  it("ignores the owner's own untagged comments and anything else", () => {
    expect(parseClaimComment("Looks good, merging.")).toBeNull()
    expect(parseClaimComment("")).toBeNull()
    expect(parseClaimComment(null)).toBeNull()
    expect(parseClaimComment("**[nobody]** claimed 2026-08-27T12:00Z · `claude --resume s`")).toBeNull()
  })

  it("rejects a claim line with no stamp, rather than inventing one", () => {
    // The pre-timestamp format. A body without a stamp has no heartbeat this
    // can trust, so it reads as "not a claim" and the row is claimable - which
    // is the safe direction: a dispatcher takes a row nobody is on, instead of
    // treating a claim of unknown age as live forever.
    expect(parseClaimComment("**[developer]** claimed · `claude --resume sess-1`")).toBeNull()
    expect(parseClaimComment("**[developer]** claimed yesterday · `claude --resume sess-1`")).toBeNull()
  })

  it("tolerates surrounding whitespace, since a body round-trips through Linear", () => {
    expect(parseClaimComment("\n  **[reviewer]** claimed 2026-08-27T12:00Z · `claude --resume sess-9`  \n"))
      .toEqual({ role: "review", sessionId: "sess-9", stampedAt: "2026-08-27T12:00Z" })
  })

  it("reads a claim whose session id is an `unknown-` marker", () => {
    expect(parseClaimComment(formatClaimComment("dev", "unknown-a1b2c3", AT_12_00)))
      .toEqual({ role: "dev", sessionId: "unknown-a1b2c3", stampedAt: "2026-08-27T12:00Z" })
  })
})

describe("isClaimComment", () => {
  it("separates the dispatcher's claim comment from every other comment on the issue", () => {
    expect(isClaimComment(formatClaimComment("dev", "s", AT_12_00))).toBe(true)
    expect(isClaimComment("**[developer]**\n\nDone.")).toBe(false)
  })
})

describe("agentForClaimRole", () => {
  it("maps both developer-side roles onto the developer agent, mirroring the GitHub apps", () => {
    expect(agentForClaimRole("dev")).toBe("developer")
    expect(agentForClaimRole("cleanup")).toBe("developer")
    expect(agentForClaimRole("review")).toBe("reviewer")
  })
})

describe("CLAIM_ROLE_TAGS", () => {
  it("uses the same role names `just board comment --as` tags a comment with", () => {
    expect(CLAIM_ROLE_TAGS).toEqual({ dev: "developer", review: "reviewer", cleanup: "cleaner" })
  })
})
