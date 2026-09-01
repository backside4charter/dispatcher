import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"

/** Linear's single GraphQL endpoint. */
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"

/**
 * The gitignored file the owner keeps third-party API keys in, next to the
 * GitHub App private keys. Shape: `{ "Linear": "lin_api_..." }`.
 */
export const API_KEYS_FILE = path.join(".secrets", "api-keys.json")

/** Environment variable that overrides the on-disk key (used by CI). */
export const LINEAR_API_KEY_ENV = "LINEAR_API_KEY"

const apiKeysSchema = z.object({ Linear: z.string().min(1) }).passthrough()

/**
 * A GraphQL call that came back with `errors`, or a transport failure.
 *
 * Carries the raw error list so a caller can tell a rate limit (Linear answers
 * 429 / `RATELIMITED`) from a bad query without parsing the message.
 */
export class LinearError extends Error {
  constructor(message: string, public readonly errors: unknown[] = []) {
    super(message)
    this.name = "LinearError"
  }
}

/**
 * Absolute path to the main working tree's root, which is where `.secrets/` is.
 *
 * `.secrets/` is gitignored, so it exists in the main checkout only. Every
 * linked worktree points back at the main checkout's `.git` directory, which is
 * what `--git-common-dir` reports, so its parent is the main checkout no matter
 * which worktree the caller runs from. Falls back to the current directory
 * outside a git checkout so the error message below can still name the file.
 */
export function findMainWorktreeRoot(cwd = process.cwd()): string {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return path.dirname(commonDir)
  } catch {
    return cwd
  }
}

/**
 * Resolves the Linear API key: the `LINEAR_API_KEY` environment variable when
 * set (CI, or a one-off override), otherwise the `Linear` entry of the main
 * checkout's `.secrets/api-keys.json`.
 *
 * Fails loudly with the path it looked at - a fresh clone has no `.secrets/`
 * and the fix is to put the file there, not to guess.
 */
export function resolveLinearApiKey(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string {
  const fromEnv = env[LINEAR_API_KEY_ENV]
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv
  const file = path.join(findMainWorktreeRoot(cwd), API_KEYS_FILE)
  if (!existsSync(file)) {
    throw new Error(
      `no Linear API key: set ${LINEAR_API_KEY_ENV} or add {"Linear": "lin_api_..."} to ${file} `
      + "(create a personal API key under Linear > Settings > Account > Security & access)",
    )
  }
  const parsed = apiKeysSchema.safeParse(JSON.parse(readFileSync(file, "utf8")))
  if (!parsed.success) throw new Error(`${file} has no "Linear" key`)
  return parsed.data.Linear
}

/** The subset of `fetch` the client needs, injectable for tests. */
export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body: string
}) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/** Something that can run a Linear GraphQL document - the real client or a test double. */
export interface LinearGraphql {
  /** Runs one query or mutation and returns its `data`, validated against `schema`. */
  query<T>(document: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T>
}

const responseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
})

/**
 * Minimal Linear GraphQL client over `fetch`.
 *
 * Features:
 * - One method: post a document plus variables, get back `data` validated by
 *   the caller's zod schema, so every call site works with a typed result
 *   rather than `unknown` casts.
 * - Any `errors` in the response, a non-2xx status, or a payload that does not
 *   match the schema throws a `LinearError` - a board write that half-failed
 *   must never read as success.
 * - No SDK dependency: Linear's API is a single endpoint and the dispatcher
 *   uses a dozen documents, so a client is thirty lines and one fewer package
 *   to pin.
 */
export class LinearClient implements LinearGraphql {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  /**
   * Runs one GraphQL document and returns its validated `data`.
   */
  async query<T>(document: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetchImpl(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: this.apiKey,
        "content-type": "application/json",
        "user-agent": "dispatcher-dispatcher",
      },
      body: JSON.stringify({ query: document, variables }),
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new LinearError(`Linear responded ${response.status} with a non-JSON body: ${text.slice(0, 200)}`)
    }
    const parsed = responseSchema.safeParse(payload)
    if (!parsed.success) throw new LinearError(`Linear responded ${response.status} with an unexpected payload`)
    if (parsed.data.errors !== undefined && parsed.data.errors.length > 0) {
      throw new LinearError(`Linear returned errors: ${JSON.stringify(parsed.data.errors)}`, parsed.data.errors)
    }
    if (!response.ok) throw new LinearError(`Linear responded ${response.status}: ${text.slice(0, 200)}`)
    const data = schema.safeParse(parsed.data.data)
    if (!data.success) {
      throw new LinearError(`Linear data did not match the expected shape: ${data.error.message}`)
    }
    return data.data
  }
}
