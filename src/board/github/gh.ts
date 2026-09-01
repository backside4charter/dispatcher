import { execFileSync } from "node:child_process"

/**
 * The GitHub API as the GitHub backend needs it: GraphQL for the Projects v2
 * board and issues, REST for comments, labels and milestones. Everything goes
 * through the `gh` CLI so the caller's auth (the owner's login, or `GH_TOKEN`
 * set to an app installation token) is honoured without this package
 * handling credentials.
 */
export interface GhRunner {
  /** Runs a GraphQL document and returns the `data` object. */
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>
  /** Calls a REST endpoint (`repos/owner/name/issues/1/comments`) and returns the parsed body. */
  rest(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<unknown>
}

/**
 * Runs `gh` as a child process. Synchronous underneath (the CLI is
 * short-lived and sequential); the async signature keeps the interface
 * transport-agnostic.
 */
export class ExecGh implements GhRunner {
  constructor(private readonly repository: string) {}

  /**
   * Runs `gh` with the arguments, feeding `input` on stdin, and parses stdout as JSON.
   */
  private run(args: string[], input?: string): unknown {
    const stdout = execFileSync("gh", args, {
      encoding: "utf8",
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout.trim() === "" ? null : JSON.parse(stdout)
  }

  /**
   * `gh api graphql --input -` with `{query, variables}` on stdin; throws on
   * GraphQL errors.
   */
  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const payload = this.run(["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }))
    if (typeof payload !== "object" || payload === null) throw new Error("gh api graphql returned no object")
    const record = payload as Record<string, unknown>
    if (record.errors !== undefined) throw new Error(`GitHub GraphQL returned errors: ${JSON.stringify(record.errors)}`)
    return record.data
  }

  /**
   * `gh api -X <method> <path> --input -` (body as JSON on stdin when given).
   */
  async rest(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<unknown> {
    const args = ["api", "-X", method, "-H", "Accept: application/vnd.github+json", path]
    if (body !== undefined) args.push("--input", "-")
    return this.run(args, body === undefined ? undefined : JSON.stringify(body))
  }

  /**
   * The repository this runner was built for, for path building.
   */
  get repo(): string {
    return this.repository
  }
}
