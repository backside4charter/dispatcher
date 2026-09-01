/**
 * Prerequisite and credential checks for `dispatcher init` - each one names
 * what it checked, whether it passed, and what to do when it did not, so the
 * wizard can end with an honest checklist instead of a shrug.
 */
import { existsSync } from "node:fs"
import type { DispatcherConfig } from "../board/config"
import { getAgentApp } from "../github/apps"
import { resolveLinearApiKey } from "../board/linear/client"
import { resolvePrivateKeyPath } from "../github/apps"

/** One line of the final checklist. */
export interface CheckResult {
  label: string
  ok: boolean
  /** What to do when not ok; empty when ok. */
  hint: string
}

/** Runs a command and reports success, injectable for tests. */
export type CommandProbe = (command: string, args: string[]) => { ok: boolean; stdout: string }

/**
 * Runs every check that applies to the config and returns the checklist.
 */
export function runChecks(
  config: DispatcherConfig,
  probe: CommandProbe,
  env: Record<string, string | undefined> = process.env,
): CheckResult[] {
  const results: CheckResult[] = []

  const gh = probe("gh", ["--version"])
  results.push({
    label: "GitHub CLI (gh)",
    ok: gh.ok,
    hint: gh.ok ? "" : "install from https://cli.github.com and run `gh auth login`",
  })

  const extension = gh.ok ? probe("gh", ["extension", "list"]) : { ok: false, stdout: "" }
  const hasWebhook = extension.ok && extension.stdout.includes("gh-webhook")
  results.push({
    label: "gh webhook extension (event channel)",
    ok: hasWebhook,
    hint: hasWebhook ? "" : "optional - `gh extension install cli/gh-webhook` and `gh auth refresh -h github.com -s admin:org_hook`",
  })

  const claude = probe("claude", ["--version"])
  results.push({
    label: "Claude Code CLI",
    ok: claude.ok,
    hint: claude.ok ? "" : "install from https://claude.com/claude-code to run the dispatcher loop",
  })

  if (config.platform === "linear") {
    let hasKey = true
    let keyHint = ""
    try {
      resolveLinearApiKey(env)
    } catch (error) {
      hasKey = false
      keyHint = error instanceof Error ? error.message : String(error)
    }
    results.push({ label: "Linear API key", ok: hasKey, hint: keyHint })
  }

  if (config.githubApps !== undefined) {
    for (const role of ["developer", "reviewer"] as const) {
      const app = getAgentApp(config, role)
      const keyPath = resolvePrivateKeyPath(app, env)
      const present = env[app.keyEnvVar] !== undefined && env[app.keyEnvVar] !== "" ? true : existsSync(keyPath)
      results.push({
        label: `${role} app private key`,
        ok: present,
        hint: present ? "" : `generate one on the app's settings page (slug ${app.slug}) and save it as ${keyPath}, or set ${app.keyEnvVar}`,
      })
    }
  }

  return results
}

/**
 * Renders the checklist as printable lines.
 */
export function formatChecks(results: CheckResult[]): string[] {
  return results.map((result) => (result.ok
    ? `[ok]      ${result.label}`
    : `[missing] ${result.label} - ${result.hint}`))
}
