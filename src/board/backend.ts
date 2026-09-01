import type { DispatcherConfig } from "./config"
import { GitHubBoard } from "./github/backend"
import { ExecGh } from "./github/gh"
import type { GhRunner } from "./github/gh"
import { LinearBoard } from "./linear/backend"
import { LinearClient, resolveLinearApiKey } from "./linear/client"
import type { LinearGraphql } from "./linear/client"
import type { BoardBackend } from "./types"

/** Transports a backend can be built on; tests inject doubles here. */
export interface BoardDeps {
  env?: Record<string, string | undefined>
  linearClient?: LinearGraphql
  gh?: GhRunner
}

/**
 * Builds the backend the config selects. Credentials are resolved here and
 * nowhere else: the Linear API key from the environment or `.secrets/`, and
 * GitHub through whatever `gh` is logged in as.
 */
export function createBoardBackend(config: DispatcherConfig, deps: BoardDeps = {}): BoardBackend {
  const env = deps.env ?? process.env
  if (config.platform === "linear") {
    if (config.linear === undefined) throw new Error('platform is "linear" but no "linear" section is configured')
    const client = deps.linearClient ?? new LinearClient(resolveLinearApiKey(env))
    return new LinearBoard(config.linear, config.repository, client)
  }
  if (config.github === undefined) throw new Error('platform is "github" but no "github" section is configured')
  return new GitHubBoard(config.github, config.repository, deps.gh ?? new ExecGh(config.repository))
}
