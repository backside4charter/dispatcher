/**
 * Wiring the Claude Code plugin into a repository's `.claude/settings.json`:
 * a read-merge-write that adds the dispatcher marketplace and enables the
 * plugin while preserving everything else in the file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/** The marketplace + plugin entries `dispatcher init` adds. */
export const MARKETPLACE_NAME = "dispatcher"
export const MARKETPLACE_REPO = "backside4charter/dispatcher"
export const PLUGIN_ID = "dispatcher@dispatcher"

/**
 * Whether a decoded JSON value is a plain object we can read named fields from.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Returns the settings object with the dispatcher marketplace and plugin
 * entries merged in, plus whether anything actually changed. Pure, so the
 * merge is testable without a filesystem.
 */
export function mergePluginSettings(settings: unknown): { merged: Record<string, unknown>; changed: boolean } {
  const base: Record<string, unknown> = isRecord(settings) ? { ...settings } : {}
  let changed = false

  const marketplaces = isRecord(base.extraKnownMarketplaces) ? { ...base.extraKnownMarketplaces } : {}
  if (!(MARKETPLACE_NAME in marketplaces)) {
    marketplaces[MARKETPLACE_NAME] = { source: { source: "github", repo: MARKETPLACE_REPO } }
    changed = true
  }
  base.extraKnownMarketplaces = marketplaces

  const plugins = isRecord(base.enabledPlugins) ? { ...base.enabledPlugins } : {}
  if (plugins[PLUGIN_ID] !== true) {
    plugins[PLUGIN_ID] = true
    changed = true
  }
  base.enabledPlugins = plugins

  return { merged: base, changed }
}

/**
 * Merges the plugin entries into `<repoRoot>/.claude/settings.json`, creating
 * the file if absent. Returns whether the file was written.
 */
export function ensurePluginSettings(repoRoot: string): boolean {
  const settingsPath = path.join(repoRoot, ".claude", "settings.json")
  const existing: unknown = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8"))
    : {}
  const { merged, changed } = mergePluginSettings(existing)
  if (!changed) return false
  mkdirSync(path.dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`)
  return true
}
