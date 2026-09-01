import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { STATE_ROLES } from "./types"
import type { BoardPlatform, StateRole } from "./types"

/**
 * `dispatcher.config.json` - everything about the dispatcher that differs
 * between projects: which platform the board lives on, the identifiers of the
 * one project it works, what that platform calls each workflow state and
 * label, the repository pull requests land in, and the bot accounts whose
 * reviews never drive the board.
 *
 * It lives at the repository root, committed, so every worktree and CI run
 * reads the same file. The backends take their section from it rather than
 * carrying constants, which is what will let this package lift out as a
 * library: a new project writes its own config and picks its platform.
 */

/** File name looked for at the repository root. */
export const CONFIG_FILE_NAME = "dispatcher.config.json"

/** Environment variable naming an explicit config path. */
export const CONFIG_PATH_ENV = "DISPATCHER_CONFIG"

/** Environment variable overriding the configured platform (for trying the alternate). */
export const PLATFORM_ENV = "DISPATCHER_BOARD_PLATFORM"

const labelsSchema = z.object({
  confirmWithUser: z.string().min(1),
  ui: z.string().min(1),
})

/**
 * Every role must be named, so a missing entry is a config error rather than
 * a silent "unknown state" at a decision point.
 */
const roleNamesSchema = z.object(Object.fromEntries(STATE_ROLES.map((role) => [role, z.string().min(1)])) as Record<StateRole, z.ZodString>)

const githubStateSchema = z.object({ name: z.string().min(1), optionId: z.string().min(1) })

/**
 * The GitHub board's Status options, one per workflow role.
 *
 * Spelled out rather than derived from `STATE_ROLES` because the roles do not
 * all have the same optionality here, and `satisfies` still makes leaving one
 * out a compile error. `question` is the one optional role, accommodating a
 * legacy or frozen board that predates the parked-question state and cannot
 * gain a column. Asking for a role the board has no column for fails loudly
 * at the write, naming the role, instead of writing to the wrong column; a
 * live GitHub board would map it like any other role.
 *
 * The mirror image holds too: a column no role claims reads as role `null`,
 * and the review-to-board sync leaves such rows alone rather than rolling
 * them back to `Changes Requested` - the right behaviour for a column nothing
 * should be writing to.
 */
const githubStatesShape = {
  backlog: githubStateSchema,
  ready: githubStateSchema,
  changesRequested: githubStateSchema,
  inProgress: githubStateSchema,
  question: githubStateSchema.optional(),
  humanReview: githubStateSchema,
  done: githubStateSchema,
} satisfies Record<StateRole, z.ZodTypeAny>

const githubStatesSchema = z.object(githubStatesShape)

/**
 * The Linear user ids of the agent app users work is delegated to.
 *
 * Not secret - they are user ids, and the OAuth credentials the apps
 * authenticate with are somewhere else entirely. The board CLI never needs
 * those: the owner's own API key can set a delegate to an app user, which is
 * what makes the claim a one-call write.
 */
const linearAgentsSchema = z.object({
  developer: z.string().min(1),
  reviewer: z.string().min(1),
})

export const linearConfigSchema = z.object({
  /** The workspace's URL key. */
  workspace: z.string().min(1),
  teamId: z.string().min(1),
  /** The team key that prefixes identifiers (`ELD` in `ACM-12`). */
  teamKey: z.string().min(1),
  projectId: z.string().min(1),
  projectUrl: z.string().url(),
  /** What the team calls each workflow role. */
  states: roleNamesSchema,
  /** The app users a claim delegates to, by Linear user id. */
  agents: linearAgentsSchema,
  labels: labelsSchema,
})

export const githubConfigSchema = z.object({
  /** The organization (or user) that owns the Projects v2 board. */
  owner: z.string().min(1),
  projectNumber: z.number().int().positive(),
  projectId: z.string().min(1),
  statusFieldId: z.string().min(1),
  claimedByFieldId: z.string().min(1),
  /** Each workflow role's Status option: its display name and the stable option id. */
  states: githubStatesSchema,
  labels: labelsSchema,
})

/**
 * Optional event-listener tuning. The port matters when several
 * dispatcher-enabled repositories run listeners on one machine - each needs
 * its own. Command-line flags override these.
 */
export const listenerConfigSchema = z.object({
  /** Loopback port the listener binds. */
  port: z.number().int().min(1).max(65535),
})

/**
 * One agent GitHub App: who it is on GitHub and where its private key lives.
 *
 * `botUserId` is the load-bearing identifier: GitHub matches a noreply
 * commit-author address on that numeric prefix, and unlike the login or the
 * slug it survives an app rename. Treat every name here as display-only.
 */
export const githubAppSchema = z.object({
  /** The GitHub App's numeric id, used as the JWT issuer. */
  appId: z.number().int().positive(),
  /** The org installation tokens are scoped to. */
  installationId: z.number().int().positive(),
  /** The app's URL slug, fixed at creation and unchanged by renames. */
  slug: z.string().min(1),
  /** The bot account's login, fixed at creation and display-only. */
  botLogin: z.string().min(1),
  /** The bot account's numeric user id - the stable identifier. */
  botUserId: z.number().int().positive(),
  /** File name of the app's private key inside `.secrets/`; defaults to `<slug>.private-key.pem`. */
  keyFile: z.string().min(1).optional(),
  /** Environment variable that overrides the private key path; defaults to `DISPATCHER_GITHUB_APP_KEY_<ROLE>`. */
  keyEnvVar: z.string().min(1).optional(),
})

/**
 * The two agent GitHub Apps, keyed by the role they play in the task workflow.
 * Two apps because GitHub refuses to let an account review its own pull
 * request: the developer commits and opens PRs, the reviewer reviews them.
 */
export const githubAppsSchema = z.object({
  developer: githubAppSchema,
  reviewer: githubAppSchema,
})

export const dispatcherConfigSchema = z.object({
  platform: z.enum(["linear", "github"]),
  /** `owner/name` of the repository pull requests are opened in. */
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "repository must be owner/name"),
  /** Numeric GitHub user ids of the agent bot accounts; their reviews never drive the board. */
  botUserIds: z.array(z.number().int().positive()),
  /** A claim older than this many minutes belongs to a dead session. */
  claimStaleMinutes: z.number().int().positive().default(90),
  listener: listenerConfigSchema.optional(),
  githubApps: githubAppsSchema.optional(),
  linear: linearConfigSchema.optional(),
  github: githubConfigSchema.optional(),
}).superRefine((config, context) => {
  if (config.platform === "linear" && config.linear === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'platform is "linear" but no "linear" section is configured', path: ["linear"] })
  }
  if (config.platform === "github" && config.github === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'platform is "github" but no "github" section is configured', path: ["github"] })
  }
})

export type DispatcherConfig = z.infer<typeof dispatcherConfigSchema>
export type LinearConfig = z.infer<typeof linearConfigSchema>
export type GitHubConfig = z.infer<typeof githubConfigSchema>
export type LinearAgents = z.infer<typeof linearAgentsSchema>
export type GitHubAppConfig = z.infer<typeof githubAppSchema>
export type GitHubAppsConfig = z.infer<typeof githubAppsSchema>

/**
 * Walks up from a directory looking for the config file.
 */
function findUpwards(start: string): string | null {
  let current = path.resolve(start)
  for (;;) {
    const candidate = path.join(current, CONFIG_FILE_NAME)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Locates the config file: an explicit path, then `DISPATCHER_CONFIG`, then
 * the nearest `dispatcher.config.json` at or above the working directory. The
 * walk starts from the working directory rather than this module because in a
 * compiled binary `import.meta.url` points inside the executable, not at any
 * repository.
 */
export function resolveConfigPath(
  explicitPath: string | undefined,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  if (explicitPath !== undefined && explicitPath !== "") return path.resolve(explicitPath)
  const fromEnv = env[CONFIG_PATH_ENV]
  if (fromEnv !== undefined && fromEnv !== "") return path.resolve(fromEnv)
  const nearCwd = findUpwards(cwd)
  if (nearCwd !== null) return nearCwd
  throw new Error(`no ${CONFIG_FILE_NAME} found above ${cwd}; set ${CONFIG_PATH_ENV} or pass --config`)
}

/**
 * Parses config JSON, reporting every schema violation at once.
 */
export function parseDispatcherConfig(raw: unknown, source = CONFIG_FILE_NAME): DispatcherConfig {
  const parsed = dispatcherConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    throw new Error(`${source} is invalid:\n  ${problems.join("\n  ")}`)
  }
  return parsed.data
}

/** How to load the config. */
export interface LoadConfigOptions {
  /** `--config` on the command line. */
  explicitPath?: string
  /** `--platform` on the command line; overrides the file and the environment. */
  platformOverride?: string
  env?: Record<string, string | undefined>
  cwd?: string
}

/**
 * Loads and validates the config, applying a platform override from the
 * command line or `DISPATCHER_BOARD_PLATFORM`. An override to a platform whose
 * section is missing is an error, like a config file in that state would be.
 */
export function loadDispatcherConfig(options: LoadConfigOptions = {}): { config: DispatcherConfig; path: string } {
  const env = options.env ?? process.env
  const configPath = resolveConfigPath(options.explicitPath, env, options.cwd)
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"))
  const override = options.platformOverride ?? env[PLATFORM_ENV]
  const withOverride = override === undefined || override === "" || typeof raw !== "object" || raw === null
    ? raw
    : { ...raw, platform: override }
  return { config: parseDispatcherConfig(withOverride, configPath), path: configPath }
}

/**
 * The owner half of the configured `owner/name` repository - the organization
 * (or user) whose webhooks the event listener forwards.
 */
export function repositoryOwner(config: DispatcherConfig): string {
  const owner = config.repository.split("/")[0]
  if (owner === undefined || owner === "") throw new Error(`repository "${config.repository}" has no owner`)
  return owner
}

/**
 * The display name of a role on the configured platform.
 *
 * Throws when the platform has no state for the role rather than inventing
 * one, so a board that cannot express a role says so instead of quietly
 * routing the work somewhere else.
 */
export function stateNameFor(config: DispatcherConfig, role: StateRole): string {
  const platform: BoardPlatform = config.platform
  if (platform === "linear") {
    if (config.linear === undefined) throw new Error("no linear section")
    return config.linear.states[role]
  }
  if (config.github === undefined) throw new Error("no github section")
  const state = config.github.states[role]
  if (state === undefined) throw new Error(`the github board has no state for the "${role}" role`)
  return state.name
}
