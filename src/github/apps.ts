/**
 * The agent GitHub App identities, resolved from `dispatcher.config.json`.
 *
 * There are two apps, because GitHub refuses to let an account approve or
 * review its own pull request:
 * - **developer** opens the PR and pushes the commits. A PR opened with the
 *   owner's own auth is one the owner could never review, which would defeat
 *   the review surface the task workflow is built on.
 * - **reviewer** posts the adversarial review on that PR. It has to be a
 *   *different* identity from the developer for the same reason - a review
 *   from the account that wrote the code is not an independent signal, and
 *   GitHub rejects it outright as a formal review event.
 *
 * The numeric ids are the load-bearing identifiers throughout: GitHub matches
 * a noreply commit-author address on the bot user id, and unlike the login or
 * the slug it survives an app rename. Treat every name as display-only and
 * compare ids.
 */
import path from "node:path"
import type { DispatcherConfig, GitHubAppConfig } from "../board/config"
import { findMainWorktreeRoot } from "../board/linear/client"

/** One agent GitHub App with its key locations fully resolved. */
export interface AgentApp {
  /** The role the app plays in the task workflow. */
  readonly role: string
  /** The GitHub App's numeric id, used as the JWT issuer. */
  readonly appId: number
  /** The org installation the token is scoped to. */
  readonly installationId: number
  /** The app's URL slug, fixed at creation and unchanged by renames. */
  readonly slug: string
  /** The bot account's login, fixed at creation and display-only. */
  readonly botLogin: string
  /** The bot account's numeric user id - the stable identifier. */
  readonly botUserId: number
  /** File name of the app's private key inside `.secrets/`. */
  readonly keyFile: string
  /** Environment variable that overrides the private key path. */
  readonly keyEnvVar: string
}

/** The roles the config can define an app for. */
export const AGENT_APP_ROLES = ["developer", "reviewer"] as const

/** The app used when a caller names none - the common case is agent dev work. */
export const DEFAULT_APP = "developer"

/**
 * Fills in an app's optional key locations from its identity: the key file
 * defaults to `<slug>.private-key.pem` and the override variable to
 * `DISPATCHER_GITHUB_APP_KEY_<ROLE>`.
 */
function resolveApp(role: string, app: GitHubAppConfig): AgentApp {
  return {
    role,
    appId: app.appId,
    installationId: app.installationId,
    slug: app.slug,
    botLogin: app.botLogin,
    botUserId: app.botUserId,
    keyFile: app.keyFile ?? `${app.slug}.private-key.pem`,
    keyEnvVar: app.keyEnvVar ?? `DISPATCHER_GITHUB_APP_KEY_${role.toUpperCase()}`,
  }
}

/**
 * Look up an agent app by role in the config, failing loudly when the config
 * declares no apps or the role is unknown.
 */
export function getAgentApp(config: DispatcherConfig, role: string = DEFAULT_APP): AgentApp {
  const apps = config.githubApps
  if (apps === undefined) {
    throw new Error('dispatcher.config.json has no "githubApps" section, so there is no agent identity to use')
  }
  if (role !== "developer" && role !== "reviewer") {
    throw new Error(`Unknown app "${role}". Expected one of: ${AGENT_APP_ROLES.join(", ")}.`)
  }
  return resolveApp(role, apps[role])
}

/**
 * Read the role that follows `--app`, defaulting to the developer app.
 *
 * A bare `--app` with no role is an error rather than a silent fall back to
 * the developer: the whole point of the two apps is that they are different
 * identities, so a typo must never hand a review the identity that wrote the
 * code.
 */
export function resolveAppRoleFromArgv(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--app")
  if (flagIndex === -1) return DEFAULT_APP
  const role = argv[flagIndex + 1]
  if (role === undefined || role.startsWith("--")) {
    throw new Error(`--app needs a role. Expected one of: ${AGENT_APP_ROLES.join(", ")}.`)
  }
  return role
}

/**
 * Commit identity that attributes a commit to an app's bot account.
 */
export function botGitEmail(app: AgentApp): string {
  return `${app.botUserId}+${app.botLogin}@users.noreply.github.com`
}

/**
 * Where an app's PEM private key is expected to be found: the app's own
 * environment variable when set, otherwise `.secrets/<keyFile>` in the main
 * working tree - `.secrets/` is gitignored so it exists in the main checkout
 * only, and every linked worktree resolves back to that one copy.
 */
export function resolvePrivateKeyPath(
  app: AgentApp,
  env: Record<string, string | undefined> = process.env,
): string {
  const fromEnv = env[app.keyEnvVar]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  return path.join(findMainWorktreeRoot(), ".secrets", app.keyFile)
}
