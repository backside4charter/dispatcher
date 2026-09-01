import { z } from "zod"
import { formatClaim, parseClaimText } from "../claims"
import type { GitHubConfig } from "../config"
import { assertLabelInUse, assertMayClose } from "../policy"
import { STATE_ROLES } from "../types"
import type {
  AgentRole,
  BoardBackend,
  BoardRow,
  Claim,
  ClaimRole,
  IssueDetail,
  LinkedIssue,
  PollOptions,
  PullRequestRef,
  StateChange,
  StateRole,
  WorkflowLabels,
  WorkflowState,
} from "../types"
import type { GhRunner } from "./gh"
import { issueNumbersNamedBy } from "./links"

/**
 * The GitHub Projects v2 implementation of the board - the flow the
 * dispatcher ran on from 2026-07-28 to 2026-08-27, preserved as a selectable
 * alternative to Linear.
 *
 * Features:
 * - Issues are addressed by number (`#480`) in the one configured repository.
 * - The board is an org-level Projects v2 project; Status is a single-select
 *   field routed on stable option ids, and the claim is a text field
 *   (`Claimed By`) whose value carries the shared claim text.
 * - Every board write needs the project *item* id, which is resolved from the
 *   issue on demand and never surfaces in a skill or a prompt.
 * - Pull requests link to issues through closing keywords (`Fixes #N`) and
 *   the `task/<n>-<slug>` branch convention; `link-pr` therefore has no
 *   meaning here and says so.
 * - All access goes through `gh`, so the caller's auth is what is used.
 */

const projectItemSchema = z.object({
  id: z.string(),
  project: z.object({ number: z.number() }),
  status: z.object({ name: z.string().nullish(), optionId: z.string().nullish() }).nullable(),
  claim: z.object({ text: z.string().nullish() }).nullable(),
})

type ProjectItem = z.infer<typeof projectItemSchema>

/** The project item fields every query selects; keep in sync with `projectItemSchema`. */
const PROJECT_ITEM_FIELDS = `
  id
  project { number }
  status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name optionId } }
  claim: fieldValueByName(name: "Claimed By") { ... on ProjectV2ItemFieldTextValue { text } }
`

const issueContentSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  repository: z.object({ nameWithOwner: z.string() }),
  milestone: z.object({ title: z.string() }).nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
  assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }),
  blockedBy: z.object({ nodes: z.array(z.object({ number: z.number(), state: z.string() })) }),
  closedByPullRequestsReferences: z.object({ nodes: z.array(z.object({ number: z.number(), url: z.string() })) }),
  parent: z.object({ number: z.number(), milestone: z.object({ title: z.string() }).nullable() }).nullable(),
  subIssuesSummary: z.object({ total: z.number(), completed: z.number() }),
})

type IssueContent = z.infer<typeof issueContentSchema>

/** The issue fields every query selects; keep in sync with `issueContentSchema`. */
const ISSUE_CONTENT_FIELDS = `
  number title url state
  repository { nameWithOwner }
  milestone { title }
  labels(first: 20) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  blockedBy(first: 20) { nodes { number state } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number url } }
  parent { number milestone { title } }
  subIssuesSummary { total completed }
`

const BOARD_ITEMS_QUERY = `
query($owner: String!, $number: Int!, $after: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      items(first: 100, after: $after, orderBy: {field: POSITION, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${PROJECT_ITEM_FIELDS}
          content { ... on Issue { ${ISSUE_CONTENT_FIELDS} } }
        }
      }
    }
  }
}`

const boardItemsSchema = z.object({
  organization: z.object({
    projectV2: z.object({
      items: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(projectItemSchema.extend({
          // Draft issues and pull requests come back as `{}`; only issues carry a number.
          content: issueContentSchema.partial().nullable(),
        })),
      }),
    }),
  }),
})

const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      ${ISSUE_CONTENT_FIELDS}
      body
      projectItems(first: 10) { nodes { ${PROJECT_ITEM_FIELDS} } }
      blockedByDetail: blockedBy(first: 20) { nodes { number title state
        projectItems(first: 10) { nodes { ${PROJECT_ITEM_FIELDS} } } } }
      subIssues(first: 50) { nodes { number title state
        blockedBy(first: 10) { nodes { number state } }
        projectItems(first: 10) { nodes { ${PROJECT_ITEM_FIELDS} } } } }
      comments(last: 100) { totalCount nodes { author { login } createdAt body } }
    }
  }
}`

const projectItemsSchema = z.object({ nodes: z.array(projectItemSchema) })

const issueSchema = z.object({
  repository: z.object({
    issue: issueContentSchema.extend({
      body: z.string().nullable(),
      projectItems: projectItemsSchema,
      blockedByDetail: z.object({
        nodes: z.array(z.object({ number: z.number(), title: z.string(), state: z.string(), projectItems: projectItemsSchema })),
      }),
      subIssues: z.object({
        nodes: z.array(z.object({
          number: z.number(),
          title: z.string(),
          state: z.string(),
          blockedBy: z.object({ nodes: z.array(z.object({ number: z.number(), state: z.string() })) }),
          projectItems: projectItemsSchema,
        })),
      }),
      comments: z.object({
        totalCount: z.number(),
        nodes: z.array(z.object({
          author: z.object({ login: z.string() }).nullable(),
          createdAt: z.string(),
          body: z.string(),
        })),
      }),
    }),
  }),
})

const ISSUE_ITEM_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      number title url state
      parent { number }
      projectItems(first: 10) { nodes { ${PROJECT_ITEM_FIELDS} } }
    }
  }
}`

const issueItemSchema = z.object({
  repository: z.object({
    issue: z.object({
      number: z.number(),
      title: z.string(),
      url: z.string(),
      state: z.string(),
      parent: z.object({ number: z.number() }).nullable(),
      projectItems: projectItemsSchema,
    }),
  }),
})

const STATUS_OPTIONS_QUERY = `
query($fieldId: ID!) {
  node(id: $fieldId) { ... on ProjectV2SingleSelectField { options { id name } } }
}`

const statusOptionsSchema = z.object({
  node: z.object({ options: z.array(z.object({ id: z.string(), name: z.string() })) }),
})

const SET_STATUS_MUTATION = `
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { singleSelectOptionId: $option }
  }) { projectV2Item { id } }
}`

const SET_TEXT_MUTATION = `
mutation($project: ID!, $item: ID!, $field: ID!, $text: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project, itemId: $item, fieldId: $field,
    value: { text: $text }
  }) { projectV2Item { id } }
}`

const CLEAR_FIELD_MUTATION = `
mutation($project: ID!, $item: ID!, $field: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field }) { projectV2Item { id } }
}`

const PR_ISSUES_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 25) { nodes { number } }
    }
  }
}`

const prIssuesSchema = z.object({
  repository: z.object({ pullRequest: z.object({ closingIssuesReferences: z.object({ nodes: z.array(z.object({ number: z.number() })) }) }) }),
})

const milestonesSchema = z.array(z.object({ title: z.string(), open_issues: z.number() }))

const labelsSchema = z.array(z.object({ name: z.string() }))

const commentSchema = z.object({ html_url: z.string().nullish() })

/**
 * Parses `data` against a schema with a readable failure.
 */
function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new Error(`GitHub ${what} did not match the expected shape: ${result.error.message}`)
  return result.data
}

export class GitHubBoard implements BoardBackend {
  readonly platform = "github" as const

  readonly labels: WorkflowLabels

  private readonly owner: string

  private readonly repo: string

  constructor(
    private readonly config: GitHubConfig,
    private readonly repository: string,
    private readonly gh: GhRunner,
  ) {
    this.labels = config.labels
    const [owner, repo] = repository.split("/")
    if (owner === undefined || repo === undefined) throw new Error(`repository must be owner/name, got ${repository}`)
    this.owner = owner
    this.repo = repo
  }

  /**
   * Accepts `480`, `#480` or `owner/name#480` (for the configured repository)
   * and returns `#480`.
   */
  normalizeRef(ref: string): string {
    const match = /^(?:([^#\s]+\/[^#\s]+))?#?(\d+)$/.exec(ref.trim())
    if (match === null || match[2] === undefined) throw new Error(`expected an issue number like #480, got ${ref}`)
    if (match[1] !== undefined && match[1] !== this.repository) {
      throw new Error(`${ref} is not in the configured repository ${this.repository}`)
    }
    return `#${Number(match[2])}`
  }

  /**
   * The issue number behind a reference.
   */
  private numberOf(ref: string): number {
    return Number(this.normalizeRef(ref).slice(1))
  }

  /**
   * The workflow role a Status option id plays, from the config.
   */
  private roleForOptionId(optionId: string | null | undefined): StateRole | null {
    if (optionId == null) return null
    return STATE_ROLES.find((role) => this.config.states[role]?.optionId === optionId) ?? null
  }

  /**
   * The workflow role a Status display name plays, from the config.
   */
  private roleForStateName(name: string): StateRole | null {
    const wanted = name.trim().toLowerCase()
    return STATE_ROLES.find((role) => this.config.states[role]?.name.toLowerCase() === wanted) ?? null
  }

  /**
   * The board's item for an issue, from its project items, or null when the
   * issue is not on the board.
   */
  private boardItem(items: ProjectItem[]): ProjectItem | null {
    return items.find((item) => item.project.number === this.config.projectNumber) ?? null
  }

  /**
   * The claim carried by a project item.
   *
   * Entirely from the field's text: the claim text already carries the stamp
   * staleness is measured on, so the item's own `updatedAt` is not consulted -
   * the same rule the Linear claim comment follows.
   */
  private claimOf(item: ProjectItem | null): Claim | null {
    return parseClaimText(item?.claim?.text)
  }

  /**
   * Reduces an issue plus its board item to a row.
   */
  private toRow(content: IssueContent, item: ProjectItem | null, sortIndex: number): BoardRow {
    const stateName = item?.status?.name ?? (content.state === "OPEN" ? "(off board)" : "Closed")
    return {
      ref: `#${content.number}`,
      title: content.title,
      url: content.url,
      sortIndex,
      state: stateName,
      stateRole: this.roleForOptionId(item?.status?.optionId) ?? (content.state === "CLOSED" ? "done" : null),
      closed: content.state === "CLOSED",
      milestone: content.milestone?.title ?? null,
      assignee: content.assignees.nodes.map((node) => node.login).join(",") || null,
      // Projects v2 has no delegation, so an assignee here still means exactly
      // what it always did: a human took the issue.
      delegate: null,
      labels: content.labels.nodes.map((node) => node.name),
      claim: this.claimOf(item),
      openBlockers: content.blockedBy.nodes.filter((node) => node.state === "OPEN").map((node) => `#${node.number}`),
      pullRequests: content.closedByPullRequestsReferences.nodes.map((node) => node.number),
      parent: content.parent === null ? null : { ref: `#${content.parent.number}`, milestone: content.parent.milestone?.title ?? null },
      children: content.subIssuesSummary.total === 0
        ? null
        : { closed: content.subIssuesSummary.completed, total: content.subIssuesSummary.total },
      githubIssue: content.number,
    }
  }

  /**
   * The Status field's options, with the role each plays.
   */
  async states(): Promise<WorkflowState[]> {
    const data = parse(statusOptionsSchema, await this.gh.graphql(STATUS_OPTIONS_QUERY, { fieldId: this.config.statusFieldId }), "status options")
    return data.node.options.map((option) => {
      const role = this.roleForOptionId(option.id)
      return { name: option.name, role, closed: role === "done", id: option.id }
    })
  }

  /**
   * Open milestones with their open-issue counts.
   */
  async milestones(): Promise<{ name: string; open: number }[]> {
    const data = parse(milestonesSchema, await this.gh.rest("GET", `repos/${this.repository}/milestones?state=open&per_page=100`), "milestones")
    return data.map((milestone) => ({ name: milestone.title, open: milestone.open_issues }))
  }

  /**
   * Every item on the board, in position order.
   */
  private async fetchBoardItems(): Promise<{ item: ProjectItem; content: IssueContent }[]> {
    const rows: { item: ProjectItem; content: IssueContent }[] = []
    let after: string | null = null
    for (;;) {
      const data: z.infer<typeof boardItemsSchema> = parse(boardItemsSchema, await this.gh.graphql(BOARD_ITEMS_QUERY, {
        owner: this.config.owner, number: this.config.projectNumber, after,
      }), "board items")
      for (const node of data.organization.projectV2.items.nodes) {
        const content = issueContentSchema.safeParse(node.content)
        if (!content.success) continue // a draft item or a pull request, not a task
        if (content.data.repository.nameWithOwner !== this.repository) continue
        const { content: _content, ...item } = node
        rows.push({ item, content: content.data })
      }
      const { pageInfo } = data.organization.projectV2.items
      if (!pageInfo.hasNextPage || pageInfo.endCursor === null) return rows
      after = pageInfo.endCursor
    }
  }

  /**
   * Board rows for a milestone set, filtered client-side (Projects v2 has no
   * server-side milestone filter), in board position order.
   */
  async poll(options: PollOptions): Promise<BoardRow[]> {
    const rows: BoardRow[] = []
    for (const [index, entry] of (await this.fetchBoardItems()).entries()) {
      const milestone = entry.content.milestone?.title ?? null
      if (options.milestones !== "all" && (milestone === null || !options.milestones.includes(milestone))) continue
      if (!options.includeClosed && entry.content.state === "CLOSED") continue
      rows.push(this.toRow(entry.content, entry.item, index))
    }
    return rows
  }

  /**
   * One issue in full.
   */
  async issue(ref: string): Promise<IssueDetail> {
    const number = this.numberOf(ref)
    const data = parse(issueSchema, await this.gh.graphql(ISSUE_QUERY, { owner: this.owner, repo: this.repo, number }), `issue #${number}`)
    const { issue } = data.repository
    const item = this.boardItem(issue.projectItems.nodes)
    const row = this.toRow(issue, item, 0)
    const stateOf = (items: ProjectItem[], state: string): string => this.boardItem(items)?.status?.name ?? (state === "OPEN" ? "(off board)" : "Closed")
    return {
      ...row,
      description: issue.body,
      blockers: issue.blockedByDetail.nodes.map((node) => ({
        ref: `#${node.number}`, title: node.title, state: stateOf(node.projectItems.nodes, node.state),
      })),
      childIssues: issue.subIssues.nodes.map((node) => ({
        ref: `#${node.number}`,
        title: node.title,
        state: stateOf(node.projectItems.nodes, node.state),
        openBlockers: node.blockedBy.nodes.filter((blocker) => blocker.state === "OPEN").map((blocker) => `#${blocker.number}`),
      })),
      pullRequestUrls: issue.closedByPullRequestsReferences.nodes.map((node) => node.url),
      comments: issue.comments.nodes.map((comment) => ({
        author: comment.author?.login ?? "unknown", createdAt: comment.createdAt, body: comment.body,
      })),
      commentCount: issue.comments.totalCount,
    }
  }

  /**
   * An issue's board item, resolved for a write. Throws when the issue is not
   * on the board - nothing can set its fields.
   */
  private async issueItem(ref: string): Promise<{ number: number; title: string; parent: boolean; item: ProjectItem }> {
    const number = this.numberOf(ref)
    const data = parse(issueItemSchema, await this.gh.graphql(ISSUE_ITEM_QUERY, { owner: this.owner, repo: this.repo, number }), `issue #${number}`)
    const { issue } = data.repository
    const item = this.boardItem(issue.projectItems.nodes)
    if (item === null) {
      throw new Error(`#${number} is not on the board - add it with: gh project item-add ${this.config.projectNumber} --owner ${this.config.owner} --url ${issue.url}`)
    }
    return { number, title: issue.title, parent: issue.parent !== null, item }
  }

  /**
   * Resolves a state by role or display name against the field's options.
   */
  private async resolveState(state: string | StateRole): Promise<WorkflowState> {
    const states = await this.states()
    const asRole = STATE_ROLES.find((role) => role === state)
    if (asRole !== undefined && this.config.states[asRole] === undefined) {
      throw new Error(`the GitHub board has no column for the "${asRole}" role; that flow is Linear-only`)
    }
    const wantedName = (asRole === undefined ? state : this.config.states[asRole]?.name ?? state).trim().toLowerCase()
    const found = states.find((candidate) => candidate.name.toLowerCase() === wantedName)
    if (found === undefined) {
      throw new Error(`unknown state "${state}"; the board has: ${states.map((candidate) => candidate.name).join(", ")}`)
    }
    return found
  }

  /**
   * Moves an issue's board Status.
   */
  async setState(ref: string, state: string | StateRole): Promise<StateChange> {
    const target = await this.resolveState(state)
    const { number, parent, item } = await this.issueItem(ref)
    assertMayClose(`#${number}`, target.name, target.closed, parent)
    const from = item.status?.name ?? "(unset)"
    if (item.status?.optionId === target.id) return { ref: `#${number}`, from, to: target.name, changed: false }
    await this.gh.graphql(SET_STATUS_MUTATION, {
      project: this.config.projectId, item: item.id, field: this.config.statusFieldId, option: target.id,
    })
    return { ref: `#${number}`, from, to: target.name, changed: true }
  }

  /**
   * Writes the claim text field.
   */
  async claim(ref: string, role: ClaimRole, sessionId: string, now: Date): Promise<{ ref: string; claim: string; replaced: Claim | null }> {
    const { number, item } = await this.issueItem(ref)
    const text = formatClaim(role, sessionId, now)
    await this.gh.graphql(SET_TEXT_MUTATION, {
      project: this.config.projectId, item: item.id, field: this.config.claimedByFieldId, text,
    })
    return { ref: `#${number}`, claim: text, replaced: this.claimOf(item) }
  }

  /**
   * Projects v2 has no agent delegation, so there is no phase to hand over
   * separately from a claim. Says so rather than pretending to write.
   */
  async assign(ref: string, agent: AgentRole): Promise<{ ref: string; agent: AgentRole; previous: AgentRole | null; released: Claim | null }> {
    throw new Error(
      `the GitHub board has no agent delegation, so ${this.normalizeRef(ref)} cannot be handed to the ${agent}: `
      + "claim it for a session instead",
    )
  }

  /**
   * Clears the claim text field. Projects v2 has no delegation, so there is
   * never a delegate to report having cleared.
   */
  async release(ref: string): Promise<{ ref: string; released: Claim | null; delegate: AgentRole | null }> {
    const { number, item } = await this.issueItem(ref)
    const claim = this.claimOf(item)
    if (claim === null) return { ref: `#${number}`, released: null, delegate: null }
    await this.gh.graphql(CLEAR_FIELD_MUTATION, {
      project: this.config.projectId, item: item.id, field: this.config.claimedByFieldId,
    })
    return { ref: `#${number}`, released: claim, delegate: null }
  }

  /**
   * Posts an issue comment under the caller's `gh` auth.
   */
  async comment(ref: string, body: string): Promise<{ ref: string; url: string | null }> {
    const number = this.numberOf(ref)
    const data = parse(commentSchema, await this.gh.rest("POST", `repos/${this.repository}/issues/${number}/comments`, { body }), "comment")
    return { ref: `#${number}`, url: data.html_url ?? null }
  }

  /**
   * Adds or removes a repository label by name.
   */
  async label(ref: string, verb: "add" | "remove", name: string): Promise<string[]> {
    assertLabelInUse(name)
    const number = this.numberOf(ref)
    if (verb === "add") {
      await this.gh.rest("POST", `repos/${this.repository}/issues/${number}/labels`, { labels: [name] })
    } else {
      await this.gh.rest("DELETE", `repos/${this.repository}/issues/${number}/labels/${encodeURIComponent(name)}`)
    }
    const labels = parse(labelsSchema, await this.gh.rest("GET", `repos/${this.repository}/issues/${number}/labels?per_page=100`), "labels")
    return labels.map((label) => label.name)
  }

  /**
   * The issues a pull request belongs to: its closing references, plus the
   * numbers its branch and body name (`closingIssuesReferences` only
   * populates from a closing keyword, so a PR whose body never got its
   * `Fixes #N` line reports none).
   */
  async resolvePullRequest(pr: PullRequestRef): Promise<LinkedIssue[]> {
    const numbers = new Map<number, string>()
    const data = parse(prIssuesSchema, await this.gh.graphql(PR_ISSUES_QUERY, { owner: this.owner, repo: this.repo, number: pr.number }), `PR #${pr.number}`)
    for (const node of data.repository.pullRequest.closingIssuesReferences.nodes) numbers.set(node.number, "closing-reference")
    for (const number of issueNumbersNamedBy(pr)) if (!numbers.has(number)) numbers.set(number, "branch-or-body")

    const issues: LinkedIssue[] = []
    for (const [number, via] of numbers) {
      const issueData = parse(issueItemSchema, await this.gh.graphql(ISSUE_ITEM_QUERY, { owner: this.owner, repo: this.repo, number }), `issue #${number}`)
      const { issue } = issueData.repository
      const item = this.boardItem(issue.projectItems.nodes)
      const state = item?.status?.name ?? (issue.state === "OPEN" ? "(off board)" : "Closed")
      issues.push({
        ref: `#${number}`,
        title: issue.title,
        url: issue.url,
        state,
        stateRole: this.roleForOptionId(item?.status?.optionId) ?? this.roleForStateName(state),
        closed: issue.state === "CLOSED",
        agent: null,
        via,
      })
    }
    return issues
  }

  /**
   * GitHub links pull requests through closing keywords, not attachments.
   */
  async linkPullRequest(ref: string, prUrl: string): Promise<void> {
    throw new Error(`GitHub links pull requests through closing keywords: add "Fixes ${this.normalizeRef(ref)}" to the body of ${prUrl}`)
  }
}
