import { describe, expect, it } from "vitest"
import { FakeLinear, LINEAR_TEST_CONFIG } from "../../testing/linear-fixtures"
import { githubIssueUrl } from "../github/links"
import { LinearError } from "./client"
import { linearIdentifiersIn, resolvePullRequestIssues } from "./links"

const REPO = "acme/widgets"

/**
 * Builds the issue node the links queries return.
 */
function linkedIssue(
  identifier: string,
  state = "Human Review",
  type = "started",
  delegate: { id: string } | null = null,
): Record<string, unknown> {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Task ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    state: { name: state, type },
    delegate,
  }
}

describe("linearIdentifiersIn", () => {
  it("finds identifiers in any case, upper-cases and de-duplicates them in order of appearance", () => {
    expect(linearIdentifiersIn("task/acm-480-chat-scroll\nFixes ACM-480, see Acm-12", "ACM")).toEqual(["ACM-480", "ACM-12"])
  })

  it("does not match a longer word that merely ends in the team key", () => {
    expect(linearIdentifiersIn("FIACM-12 is not an issue; neither is ACM-", "ACM")).toEqual([])
  })
})

describe("resolvePullRequestIssues", () => {
  const prUrl = "https://github.com/acme/widgets/pull/600"

  it("reports which agent holds a linked issue, which is what marks review while In Progress", async () => {
    const underReview = linkedIssue("ACM-480", "In Progress", "started", { id: LINEAR_TEST_CONFIG.agents.reviewer })
    const fake = new FakeLinear()
      .onDocument("attachmentsForURL", (variables) => ({
        attachmentsForURL: { nodes: variables.url === prUrl ? [{ issue: underReview }] : [] },
      }))
      .onDocument("issue(id: $id)", () => ({ issue: underReview }))
    const issues = await resolvePullRequestIssues(fake, LINEAR_TEST_CONFIG, REPO, {
      number: 600, url: prUrl, headRef: "task/acm-480-scroll", title: "Fix scroll", body: "",
    })
    expect(issues.map((issue) => [issue.ref, issue.stateRole, issue.agent])).toEqual([["ACM-480", "inProgress", "reviewer"]])
  })

  it("prefers Linear's own attachment and merges the identifier route without duplicating", async () => {
    const fake = new FakeLinear()
      .onDocument("attachmentsForURL", (variables) => ({
        attachmentsForURL: { nodes: variables.url === prUrl ? [{ issue: linkedIssue("ACM-480") }] : [] },
      }))
      .onDocument("issue(id: $id)", (variables) => ({ issue: linkedIssue(String(variables.id)) }))

    const issues = await resolvePullRequestIssues(fake, LINEAR_TEST_CONFIG, REPO, {
      number: 600, url: prUrl, headRef: "task/acm-480-scroll", title: "Fix scroll", body: "Fixes ACM-480 and ACM-12",
    })

    expect(issues.map((issue) => [issue.ref, issue.via, issue.stateRole])).toEqual([
      ["ACM-480", "attachment", "humanReview"],
      ["ACM-12", "identifier", "humanReview"],
    ])
    expect(issues.map((issue) => issue.agent)).toEqual([null, null])
  })

  it("falls back to the GitHub issue number for a pre-Linear PR", async () => {
    const fake = new FakeLinear()
      .onDocument("attachmentsForURL", (variables) => ({
        attachmentsForURL: {
          nodes: variables.url === githubIssueUrl(REPO, 402) ? [{ issue: linkedIssue("ACM-3") }] : [],
        },
      }))

    const issues = await resolvePullRequestIssues(fake, LINEAR_TEST_CONFIG, REPO, {
      number: 521, url: prUrl, headRef: "task/402-unity-plugin", title: "Unity plugin", body: "Fixes #402\nFixes #504",
    })

    expect(issues.map((issue) => [issue.ref, issue.via])).toEqual([["ACM-3", "github-issue"]])
    // Both the body's numbers were looked up, plus the branch's (a duplicate of #402, so once).
    expect(fake.callsTo("attachmentsForURL").map((call) => call.variables.url)).toEqual([
      prUrl, githubIssueUrl(REPO, 402), githubIssueUrl(REPO, 504),
    ])
  })

  it("skips an identifier Linear has no issue for instead of failing the whole resolution", async () => {
    const fake = new FakeLinear()
      .onDocument("attachmentsForURL", () => ({ attachmentsForURL: { nodes: [] } }))
      .onDocument("issue(id: $id)", (variables) => {
        if (variables.id === "ACM-999") throw new LinearError("Linear returned errors: Entity not found: Issue")
        return { issue: linkedIssue(String(variables.id)) }
      })

    const issues = await resolvePullRequestIssues(fake, LINEAR_TEST_CONFIG, REPO, {
      number: 601, url: prUrl, headRef: "task/acm-999-typo", title: "", body: "Fixes ACM-12",
    })

    expect(issues.map((issue) => issue.ref)).toEqual(["ACM-12"])
  })

  it("propagates any other Linear failure, so a broken sync is loud", async () => {
    const fake = new FakeLinear()
      .onDocument("attachmentsForURL", () => { throw new LinearError("Linear responded 429: RATELIMITED") })

    await expect(resolvePullRequestIssues(fake, LINEAR_TEST_CONFIG, REPO, { number: 1, url: prUrl, headRef: "main", title: "", body: "" }))
      .rejects.toThrow("RATELIMITED")
  })
})
