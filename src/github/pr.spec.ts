import { describe, expect, it } from "vitest"
import { TEST_CONFIG } from "../testing/board-fixtures"
import { getAgentApp } from "./apps"
import {
  findUnattributedCommits,
  formatAttributionLines,
  formatOpenedByLine,
  hasFlag,
  parseArgs,
  parseCommitSummaries,
  parseOwnerRepo,
  parsePullRequest,
  parseRepoArg,
  stringArg,
} from "./pr"

const developer = getAgentApp(TEST_CONFIG, "developer")

/**
 * Build a commit summary the way `parseCommitSummaries` would.
 */
function commit(sha: string, authorId: number | undefined, login?: string, email?: string) {
  return { sha, authorId, authorLogin: login, authorEmail: email }
}

describe("command line parsing", () => {
  it("reads --flag value pairs and bare flags", () => {
    const args = parseArgs(["--title", "Fix the thing", "--body-file", "pr-body.md", "--draft"])

    expect(stringArg(args, "title")).toBe("Fix the thing")
    expect(stringArg(args, "body-file")).toBe("pr-body.md")
    expect(hasFlag(args, "draft")).toBe(true)
    expect(hasFlag(args, "title")).toBe(false)
    expect(stringArg(args, "draft")).toBeUndefined()
  })

  it("treats a flag followed by another flag as bare", () => {
    const args = parseArgs(["--draft", "--base", "beta"])

    expect(hasFlag(args, "draft")).toBe(true)
    expect(stringArg(args, "base")).toBe("beta")
  })

  it("treats a trailing flag as bare", () => {
    expect(hasFlag(parseArgs(["--base", "main", "--draft"]), "draft")).toBe(true)
  })

  it("ignores positional arguments that are not flags", () => {
    const args = parseArgs(["stray", "--title", "T"])

    expect(stringArg(args, "title")).toBe("T")
    expect(args.has("stray")).toBe(false)
  })

  it("reports nothing for an absent flag", () => {
    const args = parseArgs([])

    expect(stringArg(args, "title")).toBeUndefined()
    expect(hasFlag(args, "draft")).toBe(false)
  })

  it("keeps an empty value distinct from an absent one", () => {
    const args = parseArgs(["--body", ""])

    expect(stringArg(args, "body")).toBe("")
    expect(stringArg(args, "title")).toBeUndefined()
  })
})

describe("resolving the target repository", () => {
  it("parses the SSH, HTTPS and host-alias forms of the origin URL", () => {
    expect(parseOwnerRepo("git@github.com:acme/widgets.git"))
      .toEqual({ owner: "acme", repo: "widgets" })
    expect(parseOwnerRepo("https://github.com/acme/widgets.git"))
      .toEqual({ owner: "acme", repo: "widgets" })
    expect(parseOwnerRepo("https://github.com/acme/widgets"))
      .toEqual({ owner: "acme", repo: "widgets" })
    expect(parseOwnerRepo("git@github.com-someuser:acme/widgets.git"))
      .toEqual({ owner: "acme", repo: "widgets" })
  })

  it("fails loudly on an origin URL it cannot read", () => {
    expect(() => parseOwnerRepo("not-a-remote")).toThrow(/Could not parse owner\/repo/)
  })

  it("reads an explicit --repo, and rejects a malformed one", () => {
    expect(parseRepoArg("acme/widgets")).toEqual({ owner: "acme", repo: "widgets" })
    expect(() => parseRepoArg("widgets")).toThrow(/<owner>\/<name>/)
    expect(() => parseRepoArg("acme/widgets/extra")).toThrow(/<owner>\/<name>/)
    expect(() => parseRepoArg("/widgets")).toThrow(/<owner>\/<name>/)
  })
})

describe("reading the created pull request", () => {
  it("reads the URL and the account GitHub recorded as its author", () => {
    expect(parsePullRequest({
      html_url: "https://github.com/acme/widgets/pull/523",
      commits_url: "https://api.github.com/repos/acme/widgets/pulls/523/commits",
      user: { id: 100000001, login: "acme-developer[bot]", type: "Bot" },
    })).toEqual({
      htmlUrl: "https://github.com/acme/widgets/pull/523",
      commitsUrl: "https://api.github.com/repos/acme/widgets/pulls/523/commits",
      authorId: 100000001,
      authorLogin: "acme-developer[bot]",
      authorType: "Bot",
    })
  })

  it("tolerates a missing author but not a missing URL", () => {
    expect(parsePullRequest({
      html_url: "https://github.com/acme/widgets/pull/523",
      commits_url: "https://api.github.com/repos/acme/widgets/pulls/523/commits",
      user: null,
    })?.authorId).toBeUndefined()

    expect(parsePullRequest({ commits_url: "https://api.github.com/x" })).toBeUndefined()
    expect(parsePullRequest({ html_url: "https://github.com/x" })).toBeUndefined()
    expect(parsePullRequest("created")).toBeUndefined()
    expect(parsePullRequest(null)).toBeUndefined()
  })
})

describe("reading the pull request's commits", () => {
  it("reads the author id and the raw commit email of each commit", () => {
    expect(parseCommitSummaries([
      {
        sha: "0123456789abcdef",
        author: { id: 100000001, login: "acme-developer[bot]" },
        commit: { author: { email: "100000001+acme-developer[bot]@users.noreply.github.com" } },
      },
    ])).toEqual([
      commit(
        "0123456789abcdef",
        100000001,
        "acme-developer[bot]",
        "100000001+acme-developer[bot]@users.noreply.github.com",
      ),
    ])
  })

  it("keeps a commit GitHub could not attribute, with no author id", () => {
    const summaries = parseCommitSummaries([
      { sha: "deadbeefcafe", author: null, commit: { author: { email: "owner@example.com" } } },
    ])

    expect(summaries?.[0]?.authorId).toBeUndefined()
    expect(summaries?.[0]?.authorEmail).toBe("owner@example.com")
  })

  it("skips entries with no sha and reports a non-list payload as unreadable", () => {
    expect(parseCommitSummaries([{ author: { id: 1 } }])).toEqual([])
    expect(parseCommitSummaries({ message: "Not Found" })).toBeUndefined()
    expect(parseCommitSummaries(null)).toBeUndefined()
  })
})

/**
 * The live guard on the agent commit identity.
 *
 * A commit whose author email is not the bot's noreply address comes back from
 * GitHub with `author: null`, so it renders as a plain name with no avatar -
 * and, far more importantly, it means the commit identity has drifted and the
 * work is no longer attributable to the app that opened the pull request.
 * Comparing ids rather than logins is deliberate: the id is what GitHub
 * matches the noreply address on and the only part of the identity that
 * survives an app rename.
 */
describe("the commit attribution guard", () => {
  it("passes a pull request whose commits are all the bot's", () => {
    const commits = [
      commit("0123456789abcdef", 100000001, "acme-developer[bot]", "bot@users.noreply.github.com"),
      commit("fedcba9876543210", 100000001, "acme-developer[bot]", "bot@users.noreply.github.com"),
    ]

    expect(findUnattributedCommits(commits, developer.botUserId)).toEqual([])
    expect(formatAttributionLines(commits, developer))
      .toEqual(["all commits attributed to acme-developer[bot]"])
  })

  it("catches a commit GitHub attributed to nobody", () => {
    const commits = [
      commit("0123456789abcdef", 100000001, "acme-developer[bot]", "bot@users.noreply.github.com"),
      commit("deadbeefcafe0000", undefined, undefined, "owner@example.com"),
    ]

    expect(findUnattributedCommits(commits, developer.botUserId).map((entry) => entry.sha))
      .toEqual(["deadbeefcafe0000"])

    const lines = formatAttributionLines(commits, developer)
    expect(lines[0]).toContain("WARNING: 1 commit(s) not attributed to acme-developer[bot].")
    expect(lines[0]).toContain("100000001+acme-developer[bot]@users.noreply.github.com")
    expect(lines[1]).toBe("  deadbeef author=unattributed email=owner@example.com")
  })

  it("catches a commit attributed to a different account, including the reviewer bot", () => {
    const commits = [commit("aaaabbbbcccc", 100000002, "acme-reviewer[bot]", "reviewer@example.com")]

    const lines = formatAttributionLines(commits, developer)
    expect(lines[0]).toContain("WARNING: 1 commit(s) not attributed")
    expect(lines[1]).toBe("  aaaabbbb author=acme-reviewer[bot] email=reviewer@example.com")
  })
})

describe("the pull request author line", () => {
  it("reports the bot as the author with no warning", () => {
    const pull = {
      htmlUrl: "https://github.com/acme/widgets/pull/523",
      commitsUrl: "https://api.github.com/repos/acme/widgets/pulls/523/commits",
      authorId: 100000001,
      authorLogin: "acme-developer[bot]",
      authorType: "Bot",
    }

    expect(formatOpenedByLine(pull, developer)).toBe("opened by: acme-developer[bot] (Bot)")
  })

  it("warns when anyone else opened it, because the owner could not then review it", () => {
    const pull = {
      htmlUrl: "https://github.com/acme/widgets/pull/523",
      commitsUrl: "https://api.github.com/repos/acme/widgets/pulls/523/commits",
      authorId: 12345,
      authorLogin: "repo-owner",
      authorType: "User",
    }

    expect(formatOpenedByLine(pull, developer)).toBe(
      "opened by: repo-owner (User) - WARNING: expected acme-developer[bot], "
      + "so the owner cannot approve this PR",
    )
  })
})
