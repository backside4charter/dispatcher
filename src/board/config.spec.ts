import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TEST_CONFIG } from "../testing/board-fixtures"
import { CONFIG_FILE_NAME, loadDispatcherConfig, parseDispatcherConfig, resolveConfigPath, stateNameFor } from "./config"

describe("parseDispatcherConfig", () => {
  it("accepts a config naming both platforms and defaults the claim window", () => {
    const { claimStaleMinutes: _omitted, ...withoutWindow } = TEST_CONFIG
    const config = parseDispatcherConfig(withoutWindow)
    expect(config.platform).toBe("linear")
    expect(config.claimStaleMinutes).toBe(90)
  })

  it("accepts a config for one platform only, and rejects selecting the missing one", () => {
    const { github: _github, ...linearOnly } = TEST_CONFIG
    expect(parseDispatcherConfig(linearOnly).platform).toBe("linear")
    expect(() => parseDispatcherConfig({ ...linearOnly, platform: "github" }))
      .toThrow('platform is "github" but no "github" section is configured')
  })

  it("reports every missing state role at once, naming the path", () => {
    const broken = {
      ...TEST_CONFIG,
      linear: { ...TEST_CONFIG.linear, states: { ready: "Ready" } },
    }
    expect(() => parseDispatcherConfig(broken, "dispatcher.config.json")).toThrow(/linear\.states\.backlog/)
    expect(() => parseDispatcherConfig(broken)).toThrow(/linear\.states\.done/)
  })

  it("rejects a repository that is not owner/name", () => {
    expect(() => parseDispatcherConfig({ ...TEST_CONFIG, repository: "widgets" })).toThrow("repository must be owner/name")
  })

  it("requires both agent apps when the githubApps section is present", () => {
    const { githubApps: _apps, ...withoutApps } = TEST_CONFIG
    expect(parseDispatcherConfig(withoutApps).githubApps).toBeUndefined()
    expect(() => parseDispatcherConfig({ ...TEST_CONFIG, githubApps: { developer: TEST_CONFIG.githubApps!.developer } }))
      .toThrow(/githubApps\.reviewer/)
  })

  it("accepts an optional listener section and rejects a nonsense port", () => {
    expect(parseDispatcherConfig(TEST_CONFIG).listener).toBeUndefined()
    const config = parseDispatcherConfig({ ...TEST_CONFIG, listener: { port: 48901 } })
    expect(config.listener?.port).toBe(48901)
    expect(() => parseDispatcherConfig({ ...TEST_CONFIG, listener: { port: 0 } })).toThrow(/listener\.port/)
  })

  it("requires both agent ids, since a claim cannot delegate without them", () => {
    const { agents: _agents, ...withoutAgents } = TEST_CONFIG.linear!
    expect(() => parseDispatcherConfig({ ...TEST_CONFIG, linear: withoutAgents })).toThrow(/linear\.agents/)
    expect(() => parseDispatcherConfig({ ...TEST_CONFIG, linear: { ...TEST_CONFIG.linear, agents: { developer: "u1" } } }))
      .toThrow(/linear\.agents\.reviewer/)
  })

  it("lets the frozen GitHub board omit the question column it can never gain", () => {
    // Every other role stays required: a missing entry there is a config error,
    // not a silent write to the wrong column.
    const config = parseDispatcherConfig(TEST_CONFIG)
    expect(config.github?.states.question).toBeUndefined()
    const { humanReview: _humanReview, ...missingRequired } = TEST_CONFIG.github!.states
    expect(() => parseDispatcherConfig({ ...TEST_CONFIG, github: { ...TEST_CONFIG.github, states: missingRequired } }))
      .toThrow(/github\.states\.humanReview/)
  })
})

describe("loading", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dispatcher-config-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("finds the config above the working directory, and lets an explicit path or the environment win", () => {
    const file = path.join(dir, CONFIG_FILE_NAME)
    writeFileSync(file, JSON.stringify(TEST_CONFIG))
    const nested = path.join(dir, "packages", "deep")
    mkdirSync(nested, { recursive: true })
    expect(resolveConfigPath(undefined, {}, nested)).toBe(file)

    const other = path.join(dir, "other.json")
    writeFileSync(other, JSON.stringify(TEST_CONFIG))
    expect(resolveConfigPath(other, {}, nested)).toBe(path.resolve(other))
    expect(resolveConfigPath(undefined, { DISPATCHER_CONFIG: other }, nested)).toBe(path.resolve(other))
  })

  it("applies a platform override from the command line or the environment", () => {
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify(TEST_CONFIG))
    expect(loadDispatcherConfig({ cwd: dir, env: {} }).config.platform).toBe("linear")
    expect(loadDispatcherConfig({ cwd: dir, env: { DISPATCHER_BOARD_PLATFORM: "github" } }).config.platform).toBe("github")
    expect(loadDispatcherConfig({ cwd: dir, env: { DISPATCHER_BOARD_PLATFORM: "github" }, platformOverride: "linear" }).config.platform).toBe("linear")
    expect(() => loadDispatcherConfig({ cwd: dir, env: {}, platformOverride: "jira" })).toThrow("platform")
  })

  it("fails loudly, naming the fixes, when no config exists above the working directory", () => {
    expect(() => resolveConfigPath(undefined, {}, dir)).toThrow(CONFIG_FILE_NAME)
    expect(() => resolveConfigPath(undefined, {}, dir)).toThrow("DISPATCHER_CONFIG")
  })
})

describe("stateNameFor", () => {
  it("names a role in the configured platform's terms", () => {
    expect(stateNameFor(TEST_CONFIG, "humanReview")).toBe("Human Review")
    expect(stateNameFor({ ...TEST_CONFIG, platform: "github" }, "humanReview")).toBe("User Review")
    expect(stateNameFor({ ...TEST_CONFIG, platform: "github" }, "backlog")).toBe("Hold")
  })

  it("says so rather than inventing a name when the platform has no state for the role", () => {
    expect(stateNameFor(TEST_CONFIG, "question")).toBe("Question")
    expect(() => stateNameFor({ ...TEST_CONFIG, platform: "github" }, "question"))
      .toThrow('the github board has no state for the "question" role')
  })
})
