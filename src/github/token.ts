/**
 * Mint short-lived installation access tokens for the agent GitHub Apps, and
 * report what an installation is allowed to do.
 *
 * Auth flow (standard GitHub App server-to-server), identical for both apps:
 * 1. Sign a short RS256 JWT with the app's private key (issuer = app id).
 * 2. Exchange it for an installation access token scoped to the org install.
 *
 * Tokens expire after one hour, so nothing caches them: mint one per push, PR
 * or review call. Minting is a single API round-trip.
 */
import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { loadDispatcherConfig } from "../board/config"
import { botGitEmail, getAgentApp, resolveAppRoleFromArgv, resolvePrivateKeyPath } from "./apps"
import type { AgentApp } from "./apps"

/** Output sinks, injectable for tests. */
export interface GithubCliIo {
  out: (line: string) => void
  err: (line: string) => void
}

/**
 * Read an app's PEM private key from disk, with a clear error if it is absent.
 */
function readPrivateKey(app: AgentApp): string {
  const keyPath = resolvePrivateKeyPath(app)
  try {
    return readFileSync(keyPath, "utf8")
  } catch {
    throw new Error(
      `${app.role} GitHub App private key not found at ${keyPath}.\n`
        + `Generate one on the app's settings page (slug ${app.slug}: Private keys > Generate a `
        + `private key), save it there, or point ${app.keyEnvVar} at it.`,
    )
  }
}

/**
 * Base64url-encode a buffer or string, per JWT encoding rules.
 */
export function base64url(input: Buffer | string): string {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Build a signed RS256 JWT proving we hold the app's private key.
 *
 * Backdates `iat` by 60s so minor clock skew between this machine and GitHub
 * cannot reject the token, and expires it in 9 minutes (GitHub caps it at 10).
 */
export function createAppJwt(app: AgentApp): string {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.appId }))
  const signer = createSign("RSA-SHA256")
  signer.update(`${header}.${payload}`)
  signer.end()
  return `${header}.${payload}.${base64url(signer.sign(readPrivateKey(app)))}`
}

/**
 * Headers every call to the GitHub REST API carries, for a given bearer token.
 */
export function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "dispatcher",
  }
}

/**
 * Whether a decoded JSON value is a plain object we can read named fields from.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Keep the permission entries that are `name -> level` strings.
 *
 * GitHub only ever sends string levels here, so anything else is a payload we
 * do not understand and would rather drop than render as `[object Object]`.
 */
function readPermissions(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const permissions: Record<string, string> = {}
  for (const [name, level] of Object.entries(value)) {
    if (typeof level === "string") permissions[name] = level
  }
  return permissions
}

/** A minted installation access token and what it can do. */
export interface InstallationToken {
  /** The token itself - short-lived, never cached, never logged. */
  readonly token: string
  /** ISO timestamp the token stops working at. */
  readonly expiresAt: string
  /** The permissions the installation granted it. */
  readonly permissions: Record<string, string>
}

/**
 * Read a token out of an access-tokens response, or nothing if there isn't one.
 *
 * A response without a usable token is treated as no token at all, so callers
 * fail on the missing credential rather than on a later 401.
 */
export function parseInstallationToken(value: unknown): InstallationToken | undefined {
  if (!isRecord(value)) return undefined
  const token = value.token
  if (typeof token !== "string" || token.length === 0) return undefined
  const expiresAt = value.expires_at
  return {
    token,
    expiresAt: typeof expiresAt === "string" ? expiresAt : "unknown",
    permissions: readPermissions(value.permissions),
  }
}

/** What an app's org installation looks like, as far as diagnostics care. */
export interface Installation {
  /** The installation's own id. */
  readonly id: number | undefined
  /** The installed app's numeric id. */
  readonly appId: number | undefined
  /** The installed app's slug. */
  readonly appSlug: string | undefined
  /** The org or user the app is installed on. */
  readonly account: string | undefined
  /** Whether the install covers all repositories or a selection. */
  readonly repositorySelection: string | undefined
  /** The permissions granted to the installation. */
  readonly permissions: Record<string, string>
}

/**
 * Read an installation response, tolerating fields GitHub happens to omit.
 *
 * Individual missing fields are reported as absent rather than guessed at - the
 * point of the diagnostic is to show what GitHub actually says.
 */
export function parseInstallation(value: unknown): Installation {
  if (!isRecord(value)) {
    throw new Error(`GitHub returned an unexpected installation payload: ${JSON.stringify(value)}`)
  }
  const id = value.id
  const appId = value.app_id
  const appSlug = value.app_slug
  const account = value.account
  const repositorySelection = value.repository_selection
  const accountLogin = isRecord(account) ? account.login : undefined
  return {
    id: typeof id === "number" ? id : undefined,
    appId: typeof appId === "number" ? appId : undefined,
    appSlug: typeof appSlug === "string" ? appSlug : undefined,
    account: typeof accountLogin === "string" ? accountLogin : undefined,
    repositorySelection: typeof repositorySelection === "string" ? repositorySelection : undefined,
    permissions: readPermissions(value.permissions),
  }
}

/**
 * Call the GitHub REST API with the given bearer token, throwing on failure.
 */
async function githubApi(path: string, token: string, method: "GET" | "POST" = "GET"): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: githubHeaders(token),
  })
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${path} failed: ${response.status} ${response.statusText}\n${await response.text()}`)
  }
  const payload: unknown = await response.json()
  return payload
}

/**
 * Mint an installation access token for one app's org installation.
 *
 * Returns the token string plus its expiry, so callers can report staleness.
 */
export async function mintInstallationToken(app: AgentApp): Promise<InstallationToken> {
  const jwt = createAppJwt(app)
  const result = parseInstallationToken(
    await githubApi(`/app/installations/${app.installationId}/access_tokens`, jwt, "POST"),
  )
  if (result === undefined) {
    throw new Error(
      `GitHub returned no installation access token for the ${app.role} app `
        + `(installation ${app.installationId}). Check that the app is still installed on the org `
        + `and that ${resolvePrivateKeyPath(app)} is a current private key.`,
    )
  }
  return result
}

/**
 * Render what an installation is allowed to do, for diagnosing permission gaps.
 *
 * The developer app's `botGitEmail` here must match the identity commits are
 * actually authored with. A bot's user id cannot be re-resolved from app
 * credentials (`GET /users/<slug>[bot]` needs a user token; an installation
 * token and an anonymous call both 404), so the real check on attribution is
 * the one the `pr` command runs against the pushed commits after opening a PR.
 */
export function formatInstallationInfo(app: AgentApp, installation: Installation, tokenExpiresAt: string): string {
  return JSON.stringify({
    role: app.role,
    app: installation.appSlug,
    appId: installation.appId,
    installationId: installation.id,
    account: installation.account,
    repositorySelection: installation.repositorySelection,
    permissions: installation.permissions,
    botLogin: app.botLogin,
    botGitEmail: botGitEmail(app),
    tokenExpiresAt,
  }, null, 2)
}

/**
 * `token [--app <role>]`: mint a token and print it, and nothing else, so the
 * output can be piped straight into GH_TOKEN.
 */
export async function runTokenFromProcess(argv: string[]): Promise<number> {
  const { config } = loadDispatcherConfig()
  const app = getAgentApp(config, resolveAppRoleFromArgv(argv))
  const { token } = await mintInstallationToken(app)
  process.stdout.write(token)
  return 0
}

/**
 * `identity [--app <role>]`: print the installation's granted permissions and
 * the bot identity the app expects, for diagnosing permission gaps.
 */
export async function runIdentityFromProcess(argv: string[]): Promise<number> {
  const { config } = loadDispatcherConfig()
  const app = getAgentApp(config, resolveAppRoleFromArgv(argv))
  const jwt = createAppJwt(app)
  const installation = parseInstallation(await githubApi(`/app/installations/${app.installationId}`, jwt))
  const { expiresAt } = await mintInstallationToken(app)
  process.stdout.write(`${formatInstallationInfo(app, installation, expiresAt)}\n`)
  return 0
}
