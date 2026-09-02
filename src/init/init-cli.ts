/**
 * `dispatcher init` - the interactive per-repository setup wizard.
 *
 * One command takes a repo from nothing to dispatcher-ready: it creates
 * `dispatcher.config.json` (with Linear auto-discovery when an API key is on
 * the machine, so teams, projects and workflow states are pickers instead of
 * UUID entry), wires the Claude Code plugin into `.claude/settings.json`, and
 * ends with an honest checklist of the credentials and tools still missing.
 * Every step is idempotent: an existing config or settings entry is kept, not
 * overwritten.
 */
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CONFIG_FILE_NAME, parseDispatcherConfig } from "../board/config"
import type { DispatcherConfig, GitHubAppConfig } from "../board/config"
import { STATE_ROLES } from "../board/types"
import type { StateRole } from "../board/types"
import { LinearClient, resolveLinearApiKey } from "../board/linear/client"
import type { LinearGraphql } from "../board/linear/client"
import { formatChecks, runChecks } from "./checks"
import type { CommandProbe } from "./checks"
import { DEFAULT_STATE_NAMES, guessStateRoles, repositoryFromRemoteUrl } from "./config-builder"
import { discoverProjects, discoverStates, discoverTeams, discoverWorkspaceKey } from "./linear-discovery"
import { InitCancelledError, createClackPrompter } from "./prompter"
import type { Prompter } from "./prompter"
import { PLUGIN_ID, ensurePluginSettings } from "./settings"
import type { GithubCliIo } from "../github/token"

/** Everything init touches in the outside world, injectable for tests. */
export interface InitDeps {
  prompter: Prompter
  /** Repository root the config and settings are written under. */
  repoRoot: string
  /** Runs a probe command for the checks and the git-remote read. */
  probe: CommandProbe
  env: Record<string, string | undefined>
  /** Builds a Linear client for discovery; undefined disables discovery. */
  linearClient?: (apiKey: string) => LinearGraphql
}

/**
 * The default probe: runs the command and captures stdout, reporting failure
 * instead of throwing.
 */
export function defaultProbe(command: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    return { ok: true, stdout }
  } catch {
    return { ok: false, stdout: "" }
  }
}

/**
 * Maps each workflow role onto one of the board's real states: the guess is
 * offered as the default, and every role is confirmable from the actual state
 * list (plus "none" for the optional-feeling ones - though the schema needs
 * every role named, so "none" falls back to typing a name).
 */
async function mapStates(
  prompter: Prompter,
  stateNames: string[],
  guessed: Record<StateRole, string | undefined>,
): Promise<Record<StateRole, string>> {
  const result = {} as Record<StateRole, string>
  for (const role of STATE_ROLES) {
    const fallback = DEFAULT_STATE_NAMES[role]
    const guess = guessed[role]
    if (stateNames.length === 0) {
      result[role] = await prompter.ask(`State name for the "${role}" role`, guess ?? fallback)
      continue
    }
    const choices = stateNames.map((name) => ({ label: name, value: name }))
    const defaultIndex = guess !== undefined ? Math.max(0, stateNames.indexOf(guess)) : 0
    result[role] = await prompter.choose(`Which state plays the "${role}" role?`, choices, defaultIndex)
  }
  return result
}

/**
 * Asks for one agent GitHub App's identity.
 */
async function askApp(prompter: Prompter, role: string): Promise<GitHubAppConfig> {
  prompter.note(
    `The ${role} app's ids are on its GitHub App settings page\n(Settings > Developer settings > GitHub Apps).`,
    `${role} app`,
  )
  const appId = Number(await prompter.ask(`${role} app id`))
  const installationId = Number(await prompter.ask(`${role} org installation id`))
  const slug = await prompter.ask(`${role} app slug`)
  const botLogin = await prompter.ask(`${role} bot login`, `${slug}[bot]`)
  const botUserId = Number(await prompter.ask(`${role} bot account's numeric user id`))
  return { appId, installationId, slug, botLogin, botUserId }
}

/**
 * Builds the dispatcher config interactively (Linear discovery when possible)
 * and returns it validated.
 */
async function buildConfig(deps: InitDeps): Promise<DispatcherConfig> {
  const { prompter } = deps

  const remote = deps.probe("git", ["remote", "get-url", "origin"])
  const derivedRepository = remote.ok ? repositoryFromRemoteUrl(remote.stdout) : undefined
  const repository = await prompter.ask("GitHub repository (owner/name) pull requests land in", derivedRepository)

  const platform = await prompter.choose<"linear" | "github">("Which platform is the task board on?", [
    { label: "Linear", value: "linear" },
    { label: "GitHub Projects v2", value: "github" },
  ])

  const raw: Record<string, unknown> = { platform, repository, botUserIds: [] }

  if (platform === "linear") {
    let client: LinearGraphql | undefined
    if (deps.linearClient !== undefined) {
      try {
        client = deps.linearClient(resolveLinearApiKey(deps.env))
      } catch {
        prompter.note("No Linear API key found, so teams and states cannot be listed for you.\nValues can be entered by hand and corrected in dispatcher.config.json later.", "manual entry")
      }
    }

    if (client !== undefined) {
      const workspace = await discoverWorkspaceKey(client)
      const teams = await discoverTeams(client)
      const team = await prompter.choose("Which team owns the tasks?", teams.map((entry) => ({
        label: `${entry.name} (${entry.key})`,
        value: entry,
      })))
      const projects = await discoverProjects(client, team.id)
      const project = await prompter.choose("Which project is the board?", projects.map((entry) => ({
        label: entry.name,
        value: entry,
      })))
      const states = await discoverStates(client, team.id)
      const mapped = await mapStates(prompter, states.map((entry) => entry.name), guessStateRoles(states))
      raw.linear = {
        workspace,
        teamId: team.id,
        teamKey: team.key,
        projectId: project.id,
        projectUrl: project.url,
        states: mapped,
        agents: { developer: "TODO", reviewer: "TODO" },
        labels: {
          confirmWithUser: await prompter.ask("Label for tasks needing a user check-in first", "Confirm with user"),
          ui: await prompter.ask("Label for design-sensitive work", "UI"),
        },
      }
      prompter.note(
        "The linear.agents ids (the app users task rows are delegated to) are set to TODO -\nfill them in once your Linear agent apps exist. Claims still work without them\nonly by failing loudly, so the dispatcher will tell you if they are needed first.",
        "delegation",
      )
    } else {
      const workspace = await prompter.ask("Linear workspace URL key (the `acme` in linear.app/acme)")
      const teamKey = await prompter.ask("Team key (the ABC in ABC-12)")
      const mapped = await mapStates(prompter, [], DEFAULT_STATE_NAMES)
      raw.linear = {
        workspace,
        teamId: await prompter.ask("Team id (UUID)", "TODO-team-id"),
        teamKey,
        projectId: await prompter.ask("Project id (UUID)", "TODO-project-id"),
        projectUrl: `https://linear.app/${workspace}/projects`,
        states: mapped,
        agents: { developer: "TODO", reviewer: "TODO" },
        labels: {
          confirmWithUser: await prompter.ask("Label for tasks needing a user check-in first", "Confirm with user"),
          ui: await prompter.ask("Label for design-sensitive work", "UI"),
        },
      }
    }
  } else {
    prompter.note(
      "GitHub Projects v2 needs ids the API only hands out per board (project id, field ids,\nstatus option ids). Placeholders are written; fill them from the GraphQL API.",
      "manual follow-up",
    )
    const stateEntries = Object.fromEntries(STATE_ROLES.map((role) => [
      role,
      { name: DEFAULT_STATE_NAMES[role], optionId: "TODO" },
    ]))
    raw.github = {
      owner: repository.split("/")[0] ?? "TODO",
      projectNumber: Number(await prompter.ask("Projects v2 board number", "1")),
      projectId: "TODO-project-id",
      statusFieldId: "TODO-status-field-id",
      claimedByFieldId: "TODO-claimed-by-field-id",
      states: stateEntries,
      labels: {
        confirmWithUser: await prompter.ask("Label for tasks needing a user check-in first", "confirm-with-user"),
        ui: await prompter.ask("Label for design-sensitive work", "ui"),
      },
    }
  }

  if (await prompter.confirm("Configure the two agent GitHub Apps (bot commits, PRs, reviews) now?", false)) {
    const developer = await askApp(prompter, "developer")
    const reviewer = await askApp(prompter, "reviewer")
    raw.githubApps = { developer, reviewer }
    raw.botUserIds = [developer.botUserId, reviewer.botUserId]
  } else {
    prompter.note(
      "Skipped. The board commands work without them; `dispatcher commit` / `pr` / `token` /\n`identity` need the githubApps section in dispatcher.config.json - see the README.",
      "agent apps",
    )
  }

  return parseDispatcherConfig(raw, "the answers given")
}

/**
 * Runs the wizard. Returns the process exit code.
 */
export async function runInitCli(deps: InitDeps, io: GithubCliIo): Promise<number> {
  const configPath = path.join(deps.repoRoot, CONFIG_FILE_NAME)
  try {
    if (existsSync(configPath)) {
      io.out(`${CONFIG_FILE_NAME} already exists - keeping it.`)
    } else {
      const config = await buildConfig(deps)
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
      io.out(`wrote ${configPath}`)
    }

    const wrote = ensurePluginSettings(deps.repoRoot)
    io.out(wrote
      ? `enabled the Claude Code plugin (${PLUGIN_ID}) in .claude/settings.json - a session restart picks it up`
      : `Claude Code plugin (${PLUGIN_ID}) already enabled in .claude/settings.json`)

    const rawConfig: unknown = JSON.parse(readFileSync(configPath, "utf8"))
    const config = parseDispatcherConfig(rawConfig, configPath)
    io.out("")
    io.out("checklist:")
    for (const line of formatChecks(runChecks(config, deps.probe, deps.env))) io.out(`  ${line}`)
    io.out("")
    io.out("next steps: run `dispatcher board config` to verify, `dispatcher listen` for the event")
    io.out("channel, and `/dispatcher:start <milestone>` in a Claude Code session to start the loop.")
    return 0
  } catch (error) {
    if (error instanceof InitCancelledError) {
      io.err("init cancelled - nothing was written beyond what was already reported")
      return 1
    }
    if (error instanceof InitNeedsTerminalError) {
      io.err("dispatcher init needs to ask questions to build dispatcher.config.json - run it in an interactive terminal")
      return 1
    }
    throw error
  } finally {
    deps.prompter.close()
  }
}

/** Thrown when a prompt is needed but stdin is not an interactive terminal. */
export class InitNeedsTerminalError extends Error {
  constructor() {
    super("init needs a terminal")
    this.name = "InitNeedsTerminalError"
  }
}

/**
 * A prompter for non-interactive stdin: every prompt fails loudly. The
 * idempotent paths (config exists, settings already wired, checklist) never
 * prompt, so `dispatcher init` doubles as a scriptable verifier - only a run
 * that actually has questions to ask demands a terminal.
 */
function failingPrompter(): Prompter {
  const fail = (): never => { throw new InitNeedsTerminalError() }
  return {
    ask: () => Promise.resolve(fail()),
    choose: () => Promise.resolve(fail()),
    confirm: () => Promise.resolve(fail()),
    note: () => {},
    close: () => {},
  }
}

/**
 * `init`: run the wizard against the real terminal, repository and Linear API.
 */
export async function runInitFromProcess(io: GithubCliIo): Promise<number> {
  const root = defaultProbe("git", ["rev-parse", "--show-toplevel"])
  const repoRoot = root.ok ? root.stdout.trim() : process.cwd()
  return runInitCli({
    prompter: process.stdin.isTTY ? createClackPrompter() : failingPrompter(),
    repoRoot,
    probe: defaultProbe,
    env: process.env,
    linearClient: (apiKey) => new LinearClient(apiKey),
  }, io)
}
