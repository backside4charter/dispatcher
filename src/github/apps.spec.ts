import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import path, { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { findMainWorktreeRoot } from "../board/linear/client"
import { TEST_CONFIG } from "../testing/board-fixtures"
import { botGitEmail, DEFAULT_APP, getAgentApp, resolveAppRoleFromArgv, resolvePrivateKeyPath } from "./apps"

const specDir = dirname(fileURLToPath(import.meta.url))

/**
 * Compare two filesystem paths the way the host does - Windows paths differ
 * only by separator and case, so normalize both before asserting equality.
 */
function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => (
    process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value)
  )
  return normalize(left) === normalize(right)
}

/**
 * The two agent GitHub App identities, resolved from the config.
 *
 * The numeric ids are not decoration: they are what GitHub matches a commit's
 * noreply author address on and what tells the developer app apart from the
 * reviewer, and they survive an app rename that moves every display name. A
 * consuming project should pin its own committed config with a test like the
 * first two here.
 */
describe("agent app identities", () => {
  it("resolves the developer app, the installation that commits and opens pull requests", () => {
    const developer = getAgentApp(TEST_CONFIG, "developer")

    expect(developer.appId).toBe(111111)
    expect(developer.installationId).toBe(10000001)
    expect(developer.botUserId).toBe(100000001)
    expect(developer.slug).toBe("acme-developer")
    expect(developer.botLogin).toBe("acme-developer[bot]")
    expect(developer.keyFile).toBe("acme-developer.private-key.pem")
    expect(developer.keyEnvVar).toBe("DISPATCHER_GITHUB_APP_KEY_DEVELOPER")
  })

  it("resolves the reviewer app as a different installation and bot account", () => {
    const reviewer = getAgentApp(TEST_CONFIG, "reviewer")

    expect(reviewer.appId).toBe(222222)
    expect(reviewer.installationId).toBe(10000002)
    expect(reviewer.botUserId).toBe(100000002)
    expect(reviewer.slug).toBe("acme-reviewer")
    expect(reviewer.botLogin).toBe("acme-reviewer[bot]")
    expect(reviewer.keyFile).toBe("acme-reviewer.private-key.pem")
    expect(reviewer.keyEnvVar).toBe("DISPATCHER_GITHUB_APP_KEY_REVIEWER")

    expect(reviewer.botUserId).not.toBe(getAgentApp(TEST_CONFIG, "developer").botUserId)
    expect(reviewer.keyFile).not.toBe(getAgentApp(TEST_CONFIG, "developer").keyFile)
  })

  it("lists both bot user ids in botUserIds, so their reviews never drive the board", () => {
    expect(TEST_CONFIG.botUserIds).toContain(getAgentApp(TEST_CONFIG, "developer").botUserId)
    expect(TEST_CONFIG.botUserIds).toContain(getAgentApp(TEST_CONFIG, "reviewer").botUserId)
  })

  it("defaults to the developer app, the one agent work is committed as", () => {
    expect(DEFAULT_APP).toBe("developer")
    expect(getAgentApp(TEST_CONFIG).role).toBe("developer")
    expect(getAgentApp(TEST_CONFIG, undefined).role).toBe("developer")
  })

  it("rejects an unknown app rather than silently falling back to the developer", () => {
    expect(() => getAgentApp(TEST_CONFIG, "revewier")).toThrow(/Unknown app "revewier"/)
    expect(() => getAgentApp(TEST_CONFIG, "revewier")).toThrow(/developer, reviewer/)
  })

  it("fails loudly when the config declares no apps at all", () => {
    const { githubApps: _apps, ...withoutApps } = TEST_CONFIG
    expect(() => getAgentApp(withoutApps)).toThrow(/no "githubApps" section/)
  })

  it("derives the key file and override variable from the identity when omitted", () => {
    const developer = getAgentApp(TEST_CONFIG, "developer")
    expect(developer.keyFile).toBe("acme-developer.private-key.pem")
    expect(developer.keyEnvVar).toBe("DISPATCHER_GITHUB_APP_KEY_DEVELOPER")

    const generic = getAgentApp({
      ...TEST_CONFIG,
      githubApps: {
        developer: { appId: 1, installationId: 2, slug: "acme-dev", botLogin: "acme-dev[bot]", botUserId: 3 },
        reviewer: { appId: 4, installationId: 5, slug: "acme-rev", botLogin: "acme-rev[bot]", botUserId: 6 },
      },
    }, "reviewer")
    expect(generic.keyFile).toBe("acme-rev.private-key.pem")
    expect(generic.keyEnvVar).toBe("DISPATCHER_GITHUB_APP_KEY_REVIEWER")
  })

  it("builds the noreply commit address GitHub matches attribution on", () => {
    expect(botGitEmail(getAgentApp(TEST_CONFIG, "developer")))
      .toBe("100000001+acme-developer[bot]@users.noreply.github.com")
  })
})

describe("selecting an app from the command line", () => {
  it("uses the developer app when no --app is given", () => {
    expect(resolveAppRoleFromArgv([])).toBe("developer")
    expect(resolveAppRoleFromArgv(["--info"])).toBe("developer")
  })

  it("reads the role that follows --app, wherever it sits", () => {
    expect(resolveAppRoleFromArgv(["--app", "reviewer"])).toBe("reviewer")
    expect(resolveAppRoleFromArgv(["--info", "--app", "reviewer"])).toBe("reviewer")
    expect(resolveAppRoleFromArgv(["--app", "reviewer", "--info"])).toBe("reviewer")
  })

  it("refuses a bare --app instead of quietly minting a developer token", () => {
    expect(() => resolveAppRoleFromArgv(["--app"])).toThrow(/--app needs a role/)
    expect(() => resolveAppRoleFromArgv(["--app", "--info"])).toThrow(/--app needs a role/)
  })
})

describe("private key resolution", () => {
  it("resolves to the main checkout's .secrets, which every linked worktree shares", () => {
    const app = getAgentApp(TEST_CONFIG, "developer")
    expect(samePath(
      resolvePrivateKeyPath(app, {}),
      join(findMainWorktreeRoot(), ".secrets", "acme-developer.private-key.pem"),
    )).toBe(true)
  })

  it("prefers the app's own environment variable when it is set", () => {
    const app = getAgentApp(TEST_CONFIG, "reviewer")
    expect(resolvePrivateKeyPath(app, { [app.keyEnvVar]: "/tmp/some-reviewer-key.pem" }))
      .toBe("/tmp/some-reviewer-key.pem")
  })

  it("finds the main worktree root, not the linked worktree this may be running in", () => {
    const listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: specDir,
      encoding: "utf8",
    })
    const mainWorktree = /^worktree (.+)$/m.exec(listing)?.[1]

    expect(mainWorktree).toBeDefined()
    expect(samePath(findMainWorktreeRoot(), mainWorktree ?? "")).toBe(true)
  })

  it("falls back to the derived .secrets path for a missing environment variable", () => {
    const app = getAgentApp(TEST_CONFIG, "developer")
    const expected = path.join(findMainWorktreeRoot(), ".secrets", app.keyFile)
    expect(samePath(resolvePrivateKeyPath(app, { [app.keyEnvVar]: "" }), expected)).toBe(true)
  })

  it("names the missing file and its settings page when the key is absent", async () => {
    const { createAppJwt } = await import("./token")
    const app = getAgentApp(TEST_CONFIG, "developer")
    const previous = process.env[app.keyEnvVar]
    const missing = join(tmpdir(), "dispatcher-no-such-key.pem")
    process.env[app.keyEnvVar] = missing

    try {
      expect(() => createAppJwt(app)).toThrow(missing)
      expect(() => createAppJwt(app)).toThrow(/acme-developer/)
    } finally {
      if (previous === undefined) delete process.env[app.keyEnvVar]
      else process.env[app.keyEnvVar] = previous
    }
  })
})
