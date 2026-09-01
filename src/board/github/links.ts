/**
 * How a pull request names a GitHub issue: the `task/<n>-<slug>` branch
 * convention and closing keywords in the body. Used by the GitHub backend for
 * every PR, and by the Linear backend for pull requests opened before the
 * move to Linear.
 */

/**
 * Recovers the GitHub issue number from a `task/<n>-<slug>` branch, or null
 * when the branch does not carry one (`task/<slug>` predates the convention;
 * `task/acm-<n>-<slug>` is the Linear-era form and names a Linear issue).
 */
export function issueNumberFromBranch(headRef: string): number | null {
  const match = /^task\/(\d+)-/.exec(headRef)
  return match?.[1] === undefined ? null : Number(match[1])
}

/**
 * GitHub issue numbers named by closing keywords in a PR body (`Fixes #123`),
 * de-duplicated in order of appearance. A bare mention (`see #12`) is not a
 * link.
 */
export function closingIssueNumbersIn(body: string): number[] {
  const pattern = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)\b/gi
  const found: number[] = []
  for (const match of body.matchAll(pattern)) {
    const number = Number(match[1])
    if (!found.includes(number)) found.push(number)
  }
  return found
}

/**
 * Every GitHub issue number a PR names: its closing keywords plus its branch.
 */
export function issueNumbersNamedBy(pr: { headRef: string; body: string }): number[] {
  const numbers = closingIssueNumbersIn(pr.body)
  const fromBranch = issueNumberFromBranch(pr.headRef)
  if (fromBranch !== null && !numbers.includes(fromBranch)) numbers.push(fromBranch)
  return numbers
}

/**
 * The HTML URL of an issue in a repository.
 */
export function githubIssueUrl(repository: string, number: number): string {
  return `https://github.com/${repository}/issues/${number}`
}
