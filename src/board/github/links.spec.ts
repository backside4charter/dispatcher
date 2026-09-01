import { describe, expect, it } from "vitest"
import { closingIssueNumbersIn, githubIssueUrl, issueNumberFromBranch, issueNumbersNamedBy } from "./links"

describe("issueNumberFromBranch", () => {
  // Task branches are `task/<issue-number>-<slug>`, so the branch name is the
  // fallback when a PR body carries no closing keyword.
  it("reads the issue number out of a conventional task branch", () => {
    expect(issueNumberFromBranch("task/480-chat-events-scroll-pinning")).toBe(480)
  })

  it("returns null for a branch predating the convention, or a Linear-era one", () => {
    expect(issueNumberFromBranch("task/streaming-checklist-widget")).toBeNull()
    expect(issueNumberFromBranch("task/acm-480-chat-events-scroll-pinning")).toBeNull()
    expect(issueNumberFromBranch("main")).toBeNull()
  })

  it("does not mistake a slug's own digits for the issue id", () => {
    expect(issueNumberFromBranch("task/upgrade-bun-1-4")).toBeNull()
  })
})

describe("closingIssueNumbersIn", () => {
  it("reads closing keywords out of a PR body and ignores bare mentions", () => {
    expect(closingIssueNumbersIn("Fixes #402\n\nFixes #504\nSee #12 and fixes #402 again")).toEqual([402, 504])
    expect(closingIssueNumbersIn("relates to #12")).toEqual([])
  })
})

describe("issueNumbersNamedBy", () => {
  it("merges the body's closing keywords with the branch's number, once each", () => {
    expect(issueNumbersNamedBy({ headRef: "task/402-unity", body: "Fixes #402\nFixes #504" })).toEqual([402, 504])
    expect(issueNumbersNamedBy({ headRef: "task/7-x", body: "" })).toEqual([7])
  })

  it("builds the issue URL an imported Linear issue carries", () => {
    expect(githubIssueUrl("acme/widgets", 480)).toBe("https://github.com/acme/widgets/issues/480")
  })
})
