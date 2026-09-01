import type { z } from "zod"
import type { LinearConfig } from "../board/config"
import type { LinearGraphql } from "../board/linear/client"
import type { IssueNode } from "../board/linear/queries"
import { TEST_CONFIG } from "./board-fixtures"

/**
 * Test doubles for the Linear API, shared by the specs that exercise the
 * Linear backend, its links resolver, the poller and the listener. Nothing
 * here is imported by production code.
 */

/** The Linear section of the test config. */
export const LINEAR_TEST_CONFIG: LinearConfig = TEST_CONFIG.linear!

/** One recorded call to the fake client. */
export interface RecordedCall {
  document: string
  variables: Record<string, unknown>
}

/** A canned response: `match` picks the handler, `respond` builds the data. */
export interface FakeHandler {
  match: (document: string, variables: Record<string, unknown>) => boolean
  respond: (variables: Record<string, unknown>, callIndex: number) => unknown
}

/**
 * A `LinearGraphql` double that routes each document to the first matching
 * handler and validates the canned response against the caller's schema, so
 * a fixture that drifts from the real shape fails the test instead of
 * silently passing a wrong shape through.
 */
export class FakeLinear implements LinearGraphql {
  readonly calls: RecordedCall[] = []

  private readonly handlers: FakeHandler[] = []

  /**
   * Registers a handler; later registrations take precedence.
   */
  on(match: FakeHandler["match"], respond: FakeHandler["respond"]): this {
    this.handlers.unshift({ match, respond })
    return this
  }

  /**
   * Registers a handler matched on a substring of the document.
   */
  onDocument(substring: string, respond: FakeHandler["respond"]): this {
    return this.on((document) => document.includes(substring), respond)
  }

  /**
   * Runs one document against the registered handlers.
   */
  async query<T>(document: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    this.calls.push({ document, variables })
    const handler = this.handlers.find((candidate) => candidate.match(document, variables))
    if (handler === undefined) throw new Error(`FakeLinear: no handler for document:\n${document}`)
    const matching = this.calls.filter((call) => handler.match(call.document, call.variables)).length - 1
    return schema.parse(handler.respond(variables, matching))
  }

  /**
   * The calls whose document contains the substring.
   */
  callsTo(substring: string): RecordedCall[] {
    return this.calls.filter((call) => call.document.includes(substring))
  }
}

/** Fields of a fixture issue that tests commonly vary. */
export interface IssueFixture {
  id?: string
  identifier?: string
  title?: string
  sortOrder?: number
  updatedAt?: string
  state?: { name: string; type: string }
  assignee?: string | null
  delegate?: { id: string; displayName: string } | null
  labels?: string[]
  milestone?: string | null
  parent?: { identifier: string; milestone: string | null } | null
  children?: { identifier: string; state: { name: string; type: string } }[]
  blockers?: { identifier: string; state: { name: string; type: string } }[]
  attachments?: { id?: string; url: string; title?: string | null; subtitle?: string | null; updatedAt?: string }[]
}

/**
 * Builds a schema-valid issue node from a handful of overrides.
 */
export function makeIssueNode(fixture: IssueFixture = {}): IssueNode {
  const identifier = fixture.identifier ?? "ACM-1"
  const updatedAt = fixture.updatedAt ?? "2026-08-27T10:00:00.000Z"
  return {
    id: fixture.id ?? `id-${identifier}`,
    identifier,
    title: fixture.title ?? `Task ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    sortOrder: fixture.sortOrder ?? 10,
    updatedAt,
    state: fixture.state ?? { name: "Ready", type: "unstarted" },
    assignee: fixture.assignee == null ? null : { displayName: fixture.assignee },
    delegate: fixture.delegate ?? null,
    labels: { nodes: (fixture.labels ?? []).map((name) => ({ name })) },
    projectMilestone: fixture.milestone === undefined ? { name: "v1.1.0" } : (fixture.milestone === null ? null : { name: fixture.milestone }),
    parent: fixture.parent == null
      ? null
      : { identifier: fixture.parent.identifier, projectMilestone: fixture.parent.milestone === null ? null : { name: fixture.parent.milestone } },
    children: { nodes: fixture.children ?? [] },
    inverseRelations: { nodes: (fixture.blockers ?? []).map((blocker) => ({ type: "blocks", issue: blocker })) },
    attachments: {
      nodes: (fixture.attachments ?? []).map((attachment, index) => ({
        id: attachment.id ?? `att-${identifier}-${index}`,
        url: attachment.url,
        title: attachment.title ?? null,
        subtitle: attachment.subtitle ?? null,
        updatedAt: attachment.updatedAt ?? updatedAt,
      })),
    },
  }
}

/**
 * Wraps issue nodes as one (unpaginated) page of the issues query.
 */
export function issuePage(nodes: IssueNode[]): unknown {
  return { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
}

/** The team's workflow states as the fixtures know them. */
export const FIXTURE_STATES = [
  { id: "st-backlog", name: "Backlog", type: "backlog", position: 0 },
  { id: "st-ready", name: "Ready", type: "unstarted", position: 1 },
  { id: "st-in-progress", name: "In Progress", type: "started", position: 3 },
  { id: "st-changes", name: "Changes Requested", type: "started", position: 3.5 },
  { id: "st-question", name: "Question", type: "started", position: 3.75 },
  { id: "st-human-review", name: "Human Review", type: "started", position: 5 },
  { id: "st-done", name: "Done", type: "completed", position: 6 },
  { id: "st-canceled", name: "Canceled", type: "canceled", position: 7 },
]

/**
 * Registers the team-states query on a fake client.
 */
export function withTeamStates(fake: FakeLinear): FakeLinear {
  return fake.onDocument("states { nodes", () => ({ team: { states: { nodes: FIXTURE_STATES } } }))
}

/**
 * Registers the single-issue reference query the write methods use.
 */
export function withIssueRef(fake: FakeLinear, fixture: IssueFixture): FakeLinear {
  const node = makeIssueNode(fixture)
  return fake.onDocument("state { name type } parent { identifier }", () => ({
    issue: {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      url: node.url,
      state: node.state,
      parent: node.parent === null ? null : { identifier: node.parent.identifier },
    },
  }))
}

/** A comment on a fixture issue, as the claim lookup reads it: id and body, nothing else. */
export interface CommentFixture {
  id?: string
  body: string
}

/**
 * Registers the claim-state query the claim, assign and release methods use:
 * who holds the issue, who it is assigned to, and its comments.
 */
export function withClaimState(fake: FakeLinear, fixture: IssueFixture & { comments?: CommentFixture[] }): FakeLinear {
  const node = makeIssueNode(fixture)
  return fake.onDocument("delegate { id displayName }\n    comments", () => ({
    issue: {
      id: node.id,
      identifier: node.identifier,
      assignee: node.assignee === null ? null : { id: "user-owner", displayName: node.assignee.displayName },
      delegate: node.delegate,
      comments: {
        nodes: (fixture.comments ?? []).map((comment, index) => ({
          id: comment.id ?? `c-${node.identifier}-${index}`,
          body: comment.body,
        })),
      },
    },
  }))
}
