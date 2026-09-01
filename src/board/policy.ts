import type { BoardRow } from "./types"

/**
 * Board policy that holds on every platform, enforced at the point that has
 * the information rather than re-derived by callers.
 */

/**
 * Whether a row belongs to a human, and so is not an agent's to work.
 *
 * The rule used to be "any assignee means a human took it". Delegation broke
 * that: handing an issue to an agent also sets the assignee to the account the
 * API key belongs to, so an assignee on its own now says nothing. What
 * separates the two is the delegate - a row an agent holds carries one, a row
 * a human took does not. Hence: skip only when a human is assigned *without*
 * an agent also assigned.
 *
 * This is why `release` clears the assignee along with the delegate. Linear
 * leaves the assignee behind when a delegate is cleared, and a row left in
 * that state would read as human-owned forever and never be dispatched again.
 *
 * **It answers "a human took it", not "it is ours to work".** Those differ for
 * one case this cannot see: a row delegated to some *other* workspace agent
 * carries both an assignee and a delegate, so it is not human-assigned, and it
 * is still not ours. `BoardRow` carries the delegate's display name rather
 * than its id, so the two are told apart by name - the eligibility rule in
 * `dispatcher:start` says to skip a delegate that is neither of our two agents
 * - and the backstop is mechanical: `claim` and `assign` refuse to move a
 * delegate the dispatcher does not run, exactly as `release` has always
 * refused to clear one. So a stranger's row can be misread here but never
 * silently taken.
 */
export function isHumanAssigned(row: Pick<BoardRow, "assignee" | "delegate">): boolean {
  return row.assignee !== null && row.delegate === null
}

/**
 * Labels the workflow no longer uses, and what replaced each.
 *
 * A retired label has to fail loudly rather than quietly succeed: `Question`
 * became a workflow state, and a worker that thought it had parked a task by
 * writing a label would leave the task looking dispatchable while it waits on
 * an answer nobody knows it needs.
 */
export const RETIRED_LABELS: Record<string, string> = {
  question: 'the Question label was replaced by the Question workflow state: park a task with "board state <ref> question"',
}

/**
 * Refuses to add or remove a label the workflow has retired.
 */
export function assertLabelInUse(name: string): void {
  const replacement = RETIRED_LABELS[name.trim().toLowerCase()]
  if (replacement !== undefined) throw new Error(`refusing to write the "${name.trim()}" label: ${replacement}`)
}

/**
 * Refuses to complete a top-level task by hand.
 *
 * A task with a pull request is completed by the owner's merge (Linear's
 * GitHub automation moves it to Done; the GitHub board's `Fixes #N` closes
 * it), and an agent completing one directly would close it behind the owner's
 * back. Sub-issues carry no PR of their own, so completing them is exactly
 * right and allowed.
 */
export function assertMayClose(ref: string, targetState: string, targetClosed: boolean, hasParent: boolean): void {
  if (targetClosed && !hasParent) {
    throw new Error(
      `refusing to set ${ref} to ${targetState}: only the owner's merge completes a top-level task; `
      + "sub-issues may be completed by hand",
    )
  }
}
