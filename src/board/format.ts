import { claimAgeMinutes, formatClaimText } from "./claims"
import { isHumanAssigned } from "./policy"
import type { BoardRow, IssueDetail } from "./types"

/**
 * Rendering shared by every platform: the poll's TSV rows and the issue
 * Markdown a worker prompt embeds. Agents read this output, so it favours
 * fixed columns and `-` placeholders over prettiness.
 */

/** Header line matching `formatRowTsv`. */
export const ROW_TSV_HEADER = [
  "milestone", "state", "delegate", "claim", "issue", "labels", "assignee", "blockers", "prs", "parent", "subs", "title",
].join("\t")

/**
 * Orders rows by the board's manual order, top of the board first. That
 * order is the owner's priority signal; nothing else on the board ranks work.
 */
export function sortRows<T extends BoardRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.sortIndex - b.sortIndex || a.ref.localeCompare(b.ref))
}

/**
 * Renders a row as one tab-separated line. Empty cells print as `-` so every
 * line has the same column count whatever the row carries.
 */
export function formatRowTsv(row: BoardRow, now: Date): string {
  const claim = row.claim === null ? "-" : `${formatClaimText(row.claim)}(${claimAgeMinutes(row.claim, now)}m)`
  return [
    row.milestone ?? "-",
    row.state,
    row.delegate ?? "-",
    claim,
    row.ref,
    row.labels.length === 0 ? "-" : row.labels.join(","),
    row.assignee ?? "-",
    row.openBlockers.length === 0 ? "-" : row.openBlockers.join(","),
    row.pullRequests.length === 0 ? "-" : row.pullRequests.map((n) => `#${n}`).join(","),
    row.parent === null ? "-" : row.parent.ref,
    row.children === null ? "-" : `${row.children.closed}/${row.children.total}`,
    row.title,
  ].join("\t")
}

/**
 * Renders an issue as Markdown for a worker prompt: header, sub-issues,
 * blockers, the description verbatim, and the most recent comments (owner
 * answers to parked questions live there).
 */
export function renderIssueMarkdown(issue: IssueDetail, now: Date, commentLimit: number): string[] {
  const lines: string[] = []
  lines.push(`# ${issue.ref} ${issue.title}`, "")
  lines.push(`- URL: ${issue.url}`)
  lines.push(`- State: ${issue.state}${issue.closed ? " (closed)" : ""}`)
  lines.push(`- Milestone: ${issue.milestone ?? "-"}`)
  lines.push(`- Labels: ${issue.labels.length === 0 ? "-" : issue.labels.join(", ")}`)
  // Delegating an issue to an agent also assigns it, so an assignee on its own
  // no longer means a human took the row. Spell out which it is rather than
  // leaving a prompt to work it out from two fields.
  const owner = isHumanAssigned(issue)
    ? `${issue.assignee ?? "?"} (human-owned, agents skip)`
    : `${issue.assignee ?? "-"} (agent-workable)`
  lines.push(`- Assignee: ${owner}`)
  lines.push(`- Delegate: ${issue.delegate ?? "-"}`)
  const claim = issue.claim === null ? "-" : `${formatClaimText(issue.claim)} (${claimAgeMinutes(issue.claim, now)} min old)`
  lines.push(`- Claim: ${claim}`)
  if (issue.githubIssue !== null) lines.push(`- GitHub issue: #${issue.githubIssue}`)
  lines.push(`- Pull requests: ${issue.pullRequestUrls.length === 0 ? "-" : issue.pullRequestUrls.join(", ")}`)
  lines.push(`- Parent: ${issue.parent === null ? "-" : issue.parent.ref}`)
  lines.push(`- Blocked by: ${issue.blockers.length === 0 ? "-" : issue.blockers.map((b) => `${b.ref} (${b.state})`).join(", ")}`)
  if (issue.childIssues.length > 0) {
    lines.push("", "## Sub-issues", "", "| Issue | Title | State | Blocked by |", "| --- | --- | --- | --- |")
    for (const child of issue.childIssues) {
      lines.push(`| ${child.ref} | ${child.title} | ${child.state} | ${child.openBlockers.join(", ") || "-"} |`)
    }
  }
  lines.push("", "## Description", "", issue.description ?? "(empty)")
  const shown = commentLimit === 0 ? [] : issue.comments.slice(-commentLimit)
  lines.push("", `## Comments (${issue.commentCount} total, showing last ${shown.length})`)
  for (const comment of shown) {
    lines.push("", `### ${comment.author} at ${comment.createdAt}`, "", comment.body)
  }
  return lines
}
