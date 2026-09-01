import type { GitHubConfig } from "../board/config"
import type { GhRunner } from "../board/github/gh"
import { TEST_CONFIG } from "./board-fixtures"

/**
 * Test doubles for the GitHub API as the GitHub backend uses it. Nothing here
 * is imported by production code.
 */

/** The GitHub section of the test config. */
export const GITHUB_TEST_CONFIG: GitHubConfig = TEST_CONFIG.github!

/** One recorded call to the fake runner. */
export type GhCall =
  | { kind: "graphql"; query: string; variables: Record<string, unknown> }
  | { kind: "rest"; method: string; path: string; body?: Record<string, unknown> }

/**
 * A `GhRunner` double routing GraphQL documents by substring and REST calls
 * by method + path pattern.
 */
export class FakeGh implements GhRunner {
  readonly calls: GhCall[] = []

  private readonly graphqlHandlers: { match: string; respond: (variables: Record<string, unknown>) => unknown }[] = []

  private readonly restHandlers: { method: string; path: RegExp; respond: (path: string, body?: Record<string, unknown>) => unknown }[] = []

  /**
   * Registers a GraphQL handler matched on a substring of the document.
   */
  onGraphql(match: string, respond: (variables: Record<string, unknown>) => unknown): this {
    this.graphqlHandlers.unshift({ match, respond })
    return this
  }

  /**
   * Registers a REST handler.
   */
  onRest(method: string, pattern: RegExp, respond: (path: string, body?: Record<string, unknown>) => unknown): this {
    this.restHandlers.unshift({ method, path: pattern, respond })
    return this
  }

  async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ kind: "graphql", query, variables })
    const handler = this.graphqlHandlers.find((candidate) => query.includes(candidate.match))
    if (handler === undefined) throw new Error(`FakeGh: no GraphQL handler for:\n${query}`)
    return handler.respond(variables)
  }

  async rest(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ kind: "rest", method, path, body })
    const handler = this.restHandlers.find((candidate) => candidate.method === method && candidate.path.test(path))
    if (handler === undefined) throw new Error(`FakeGh: no REST handler for ${method} ${path}`)
    return handler.respond(path, body)
  }

  /**
   * The GraphQL calls whose document contains the substring.
   */
  graphqlCalls(substring: string): { query: string; variables: Record<string, unknown> }[] {
    const calls: { query: string; variables: Record<string, unknown> }[] = []
    for (const call of this.calls) {
      if (call.kind === "graphql" && call.query.includes(substring)) calls.push(call)
    }
    return calls
  }
}

/** A project item as the board queries return it. */
export function makeProjectItem(overrides: { id?: string; status?: { name: string; optionId: string } | null; claim?: { text: string } | null } = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? "PVTI_1",
    project: { number: 2 },
    status: overrides.status === undefined ? { name: "Ready", optionId: "f75ad846" } : overrides.status,
    claim: overrides.claim ?? null,
  }
}

/** Fields of a fixture issue that tests commonly vary. */
export interface GitHubIssueFixture {
  number: number
  title?: string
  state?: "OPEN" | "CLOSED"
  milestone?: string | null
  labels?: string[]
  assignees?: string[]
  blockedBy?: { number: number; state: "OPEN" | "CLOSED" }[]
  pullRequests?: number[]
  parent?: { number: number; milestone: string | null } | null
  subIssues?: { total: number; completed: number }
}

/**
 * Builds the issue content the board items query returns.
 */
export function makeIssueContent(fixture: GitHubIssueFixture): Record<string, unknown> {
  return {
    number: fixture.number,
    title: fixture.title ?? `Task #${fixture.number}`,
    url: `https://github.com/acme/widgets/issues/${fixture.number}`,
    state: fixture.state ?? "OPEN",
    repository: { nameWithOwner: "acme/widgets" },
    milestone: fixture.milestone === undefined ? { title: "v1.1.0" } : (fixture.milestone === null ? null : { title: fixture.milestone }),
    labels: { nodes: (fixture.labels ?? []).map((name) => ({ name })) },
    assignees: { nodes: (fixture.assignees ?? []).map((login) => ({ login })) },
    blockedBy: { nodes: fixture.blockedBy ?? [] },
    closedByPullRequestsReferences: {
      nodes: (fixture.pullRequests ?? []).map((number) => ({ number, url: `https://github.com/acme/widgets/pull/${number}` })),
    },
    parent: fixture.parent == null ? null : { number: fixture.parent.number, milestone: fixture.parent.milestone === null ? null : { title: fixture.parent.milestone } },
    subIssuesSummary: fixture.subIssues ?? { total: 0, completed: 0 },
  }
}
