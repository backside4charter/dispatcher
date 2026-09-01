/**
 * Linear-side auto-discovery for `dispatcher init`: with an API key on the
 * machine, the painful config values (workspace key, team and project UUIDs,
 * workflow state names) become pickers instead of manual entry.
 */
import { z } from "zod"
import type { LinearGraphql } from "../board/linear/client"

/** A team the key can see. */
export interface DiscoveredTeam {
  id: string
  name: string
  key: string
}

/** A project on a team. */
export interface DiscoveredProject {
  id: string
  name: string
  url: string
}

/** One workflow state of a team. */
export interface DiscoveredState {
  name: string
  /** Linear's state category: triage | backlog | unstarted | started | completed | canceled. */
  type: string
  position: number
}

const organizationSchema = z.object({ organization: z.object({ urlKey: z.string(), name: z.string() }) })
const teamsSchema = z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), key: z.string() })) }) })
const projectsSchema = z.object({
  team: z.object({ projects: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string(), url: z.string() })) }) }),
})
const statesSchema = z.object({
  team: z.object({ states: z.object({ nodes: z.array(z.object({ name: z.string(), type: z.string(), position: z.number() })) }) }),
})

/**
 * The workspace's URL key (the `acme` in linear.app/acme/...).
 */
export async function discoverWorkspaceKey(client: LinearGraphql): Promise<string> {
  const data = await client.query("query { organization { urlKey name } }", {}, organizationSchema)
  return data.organization.urlKey
}

/**
 * Every team the key can see.
 */
export async function discoverTeams(client: LinearGraphql): Promise<DiscoveredTeam[]> {
  const data = await client.query("query { teams(first: 50) { nodes { id name key } } }", {}, teamsSchema)
  return data.teams.nodes
}

/**
 * The projects on one team.
 */
export async function discoverProjects(client: LinearGraphql, teamId: string): Promise<DiscoveredProject[]> {
  const data = await client.query(
    "query($teamId: String!) { team(id: $teamId) { projects(first: 50) { nodes { id name url } } } }",
    { teamId },
    projectsSchema,
  )
  return data.team.projects.nodes
}

/**
 * The team's workflow states, in board order.
 */
export async function discoverStates(client: LinearGraphql, teamId: string): Promise<DiscoveredState[]> {
  const data = await client.query(
    "query($teamId: String!) { team(id: $teamId) { states { nodes { name type position } } } }",
    { teamId },
    statesSchema,
  )
  return [...data.team.states.nodes].sort((a, b) => a.position - b.position)
}
