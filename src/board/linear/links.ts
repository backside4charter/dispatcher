import { z } from "zod"
import type { LinearConfig } from "../config"
import { githubIssueUrl, issueNumbersNamedBy } from "../github/links"
import type { LinkedIssue, PullRequestRef } from "../types"
import { LinearError } from "./client"
import type { LinearGraphql } from "./client"
import { agentForDelegateId, isClosedStateType, roleForStateName } from "./queries"

/**
 * How a pull request maps back to the Linear issue it belongs to.
 *
 * Three routes, tried in order, because the repo carries PRs from three eras:
 *
 * 1. **Linear's own link.** The GitHub integration attaches a PR to an issue
 *    when its branch name or body mentions the identifier (`ACM-123`), and
 *    `link-pr` attaches one by hand. `attachmentsForURL(<pr url>)` answers
 *    directly and is authoritative when it answers at all.
 * 2. **The identifier in the branch or body**, for a PR the integration has
 *    not linked yet (it can lag a push by a minute). Task branches are
 *    `task/acm-<n>-<slug>` and PR bodies carry `Fixes ACM-<n>`.
 * 3. **The GitHub issue number**, for PRs opened before the move to Linear:
 *    `task/<n>-<slug>` branches and `Fixes #<n>` bodies name a GitHub issue,
 *    and every imported Linear issue carries that GitHub issue's URL as an
 *    attachment, so `attachmentsForURL(<github issue url>)` finds it.
 */

const linkedIssueNodeSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  state: z.object({ name: z.string(), type: z.string() }),
  delegate: z.object({ id: z.string() }).nullable(),
})

type LinkedIssueNode = z.infer<typeof linkedIssueNodeSchema>

/** Issues attached to a URL (a PR, or an imported GitHub issue). */
export const ATTACHMENTS_FOR_URL_QUERY = `
query($url: String!) {
  attachmentsForURL(url: $url) {
    nodes { issue { id identifier title url state { name type } delegate { id } } }
  }
}`

const attachmentsForUrlSchema = z.object({
  attachmentsForURL: z.object({ nodes: z.array(z.object({ issue: linkedIssueNodeSchema.nullable() })) }),
})

/** One issue by identifier (`ACM-12`) or id. */
export const ISSUE_BY_ID_QUERY = `
query($id: String!) {
  issue(id: $id) { id identifier title url state { name type } delegate { id } }
}`

const issueByIdSchema = z.object({ issue: linkedIssueNodeSchema })

/** A linked issue plus the Linear id the backend needs to write it. */
export interface LinearLinkedIssue extends LinkedIssue {
  id: string
}

/**
 * Linear identifiers mentioned in a piece of text, upper-cased and
 * de-duplicated, in order of first appearance. Matches the team key only,
 * case-insensitively, so a lower-case branch name (`task/acm-12-foo`) counts.
 */
export function linearIdentifiersIn(text: string, teamKey: string): string[] {
  const pattern = new RegExp(`\\b${teamKey}-(\\d+)\\b`, "gi")
  const found: string[] = []
  for (const match of text.matchAll(pattern)) {
    const identifier = `${teamKey.toUpperCase()}-${match[1]}`
    if (!found.includes(identifier)) found.push(identifier)
  }
  return found
}

/**
 * Reduces a linked issue node to the shared shape.
 */
function toLinkedIssue(node: LinkedIssueNode, config: LinearConfig, via: string): LinearLinkedIssue {
  return {
    id: node.id,
    ref: node.identifier,
    title: node.title,
    url: node.url,
    state: node.state.name,
    stateRole: roleForStateName(config, node.state.name),
    closed: isClosedStateType(node.state.type),
    agent: agentForDelegateId(config.agents, node.delegate?.id),
    via,
  }
}

/**
 * Issues attached to a URL, tagged with the given route.
 */
async function issuesAttachedTo(client: LinearGraphql, config: LinearConfig, url: string, via: string): Promise<LinearLinkedIssue[]> {
  const result = await client.query(ATTACHMENTS_FOR_URL_QUERY, { url }, attachmentsForUrlSchema)
  const issues: LinearLinkedIssue[] = []
  for (const node of result.attachmentsForURL.nodes) {
    if (node.issue !== null) issues.push(toLinkedIssue(node.issue, config, via))
  }
  return issues
}

/**
 * Looks an issue up by identifier, or null when Linear has no such issue - a
 * branch can mention an identifier that was mistyped or since deleted, and
 * that is a miss, not a failure.
 */
export async function findIssueByIdentifier(client: LinearGraphql, config: LinearConfig, identifier: string): Promise<LinearLinkedIssue | null> {
  try {
    const result = await client.query(ISSUE_BY_ID_QUERY, { id: identifier }, issueByIdSchema)
    return toLinkedIssue(result.issue, config, "identifier")
  } catch (error) {
    if (error instanceof LinearError && /not found|Entity not found|Could not find/i.test(error.message)) return null
    throw error
  }
}

/**
 * Resolves the Linear issues a pull request belongs to, trying the three
 * routes described at the top of this file and merging their results
 * (de-duplicated by issue id, first route wins).
 *
 * Every route is tried even when an earlier one answered: a PR linked by the
 * integration to one issue may still name a second one in its body, and the
 * caller decides which of them are in the review conversation.
 */
export async function resolvePullRequestIssues(
  client: LinearGraphql,
  config: LinearConfig,
  repository: string,
  pr: PullRequestRef,
): Promise<LinearLinkedIssue[]> {
  const found = new Map<string, LinearLinkedIssue>()
  const add = (issue: LinearLinkedIssue): void => {
    if (!found.has(issue.id)) found.set(issue.id, issue)
  }

  for (const issue of await issuesAttachedTo(client, config, pr.url, "attachment")) add(issue)

  for (const identifier of linearIdentifiersIn(`${pr.headRef}\n${pr.title}\n${pr.body}`, config.teamKey)) {
    const issue = await findIssueByIdentifier(client, config, identifier)
    if (issue !== null) add(issue)
  }

  for (const number of issueNumbersNamedBy(pr)) {
    for (const issue of await issuesAttachedTo(client, config, githubIssueUrl(repository, number), "github-issue")) add(issue)
  }

  return [...found.values()]
}
