import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ensurePluginSettings, mergePluginSettings } from "./settings"

describe("mergePluginSettings", () => {
  it("adds the marketplace and plugin to an empty settings object", () => {
    const { merged, changed } = mergePluginSettings({})
    expect(changed).toBe(true)
    expect(merged.extraKnownMarketplaces).toEqual({
      dispatcher: { source: { source: "github", repo: "backside4charter/dispatcher" } },
    })
    expect(merged.enabledPlugins).toEqual({ "dispatcher@dispatcher": true })
  })

  it("preserves unrelated settings and existing marketplaces", () => {
    const { merged } = mergePluginSettings({
      permissions: { allow: ["Bash(ls *)"] },
      extraKnownMarketplaces: { other: { source: { source: "github", repo: "acme/other" } } },
      enabledPlugins: { "other@other": true },
    })
    expect(merged.permissions).toEqual({ allow: ["Bash(ls *)"] })
    const marketplaces = merged.extraKnownMarketplaces as Record<string, unknown>
    expect(Object.keys(marketplaces).sort()).toEqual(["dispatcher", "other"])
    expect(merged.enabledPlugins).toEqual({ "other@other": true, "dispatcher@dispatcher": true })
  })

  it("reports no change when everything is already in place", () => {
    const first = mergePluginSettings({})
    const second = mergePluginSettings(first.merged)
    expect(second.changed).toBe(false)
  })
})

describe("ensurePluginSettings", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dispatcher-init-settings-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("creates .claude/settings.json when absent", () => {
    expect(ensurePluginSettings(dir)).toBe(true)
    const written: unknown = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"))
    expect((written as Record<string, unknown>).enabledPlugins).toEqual({ "dispatcher@dispatcher": true })
  })

  it("merges into an existing file and is idempotent", () => {
    const settingsPath = path.join(dir, ".claude")
    rmSync(settingsPath, { recursive: true, force: true })
    expect(ensurePluginSettings(dir)).toBe(true)
    writeFileSync(path.join(dir, ".claude", "settings.json"), readFileSync(path.join(dir, ".claude", "settings.json")))
    expect(ensurePluginSettings(dir)).toBe(false)
  })
})
