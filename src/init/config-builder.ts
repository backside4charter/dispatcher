/**
 * Pure helpers for `dispatcher init`: guessing which workflow state plays
 * which dispatcher role, and deriving `owner/name` from a git remote - the
 * decision-shaped parts of the flow, kept out of the interactive orchestrator
 * so they are unit-testable.
 */
import { STATE_ROLES } from "../board/types"
import type { StateRole } from "../board/types"
import type { DiscoveredState } from "./linear-discovery"

/** The default state names offered when a board cannot be auto-discovered. */
export const DEFAULT_STATE_NAMES: Record<StateRole, string> = {
  backlog: "Backlog",
  ready: "Ready",
  changesRequested: "Changes Requested",
  inProgress: "In Progress",
  question: "Question",
  humanReview: "Human Review",
  done: "Done",
}

/** Name fragments that suggest a role, checked case-insensitively in order. */
const ROLE_NAME_HINTS: Record<StateRole, string[]> = {
  backlog: ["backlog", "hold", "icebox"],
  ready: ["ready", "todo", "to do"],
  changesRequested: ["changes requested", "changes-requested", "sent back", "rework"],
  inProgress: ["in progress", "in-progress", "doing"],
  question: ["question", "waiting", "blocked on owner"],
  humanReview: ["human review", "user review", "in review", "review"],
  done: ["done", "complete", "shipped"],
}

/** Linear state categories that corroborate a role when no name matches. */
const ROLE_TYPE_HINTS: Partial<Record<StateRole, string>> = {
  backlog: "backlog",
  ready: "unstarted",
  inProgress: "started",
  done: "completed",
}

/**
 * Guesses which of a team's workflow states plays each dispatcher role, by
 * state name first and Linear's state category second. Every state is used at
 * most once, and a role with no plausible match maps to undefined - the
 * interactive flow asks about those rather than guessing wrong.
 */
export function guessStateRoles(states: DiscoveredState[]): Record<StateRole, string | undefined> {
  const taken = new Set<string>()
  const result = {} as Record<StateRole, string | undefined>
  for (const role of STATE_ROLES) {
    const hints = ROLE_NAME_HINTS[role]
    const byName = states.find((state) => !taken.has(state.name)
      && hints.some((hint) => state.name.toLowerCase().includes(hint)))
    if (byName !== undefined) {
      result[role] = byName.name
      taken.add(byName.name)
    } else {
      result[role] = undefined
    }
  }
  for (const role of STATE_ROLES) {
    if (result[role] !== undefined) continue
    const typeHint = ROLE_TYPE_HINTS[role]
    if (typeHint === undefined) continue
    const byType = states.find((state) => !taken.has(state.name) && state.type === typeHint)
    if (byType !== undefined) {
      result[role] = byType.name
      taken.add(byType.name)
    }
  }
  return result
}

/**
 * Derives `owner/name` from a git remote URL (SSH, HTTPS, or host-alias
 * form), or undefined when it cannot be read.
 */
export function repositoryFromRemoteUrl(url: string): string | undefined {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim())
  const owner = match?.[1]
  const repo = match?.[2]
  if (owner === undefined || repo === undefined || owner === "" || repo === "") return undefined
  return `${owner}/${repo}`
}
