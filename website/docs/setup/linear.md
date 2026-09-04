---
title: Set up Linear
description: What the dispatcher needs in a Linear workspace - once per project.
---

# Set up Linear

## 1. A team and a project

One team, one project. The project is the board; its manual order is the
priority. Note the team key (the `ACM` in `ACM-12`).

## 2. Milestones

Create a project milestone per release or batch. The loop is scoped to the
milestones you name when you start it.

## 3. Seven workflow states

Under Settings > Teams > *team* > Workflow, one state per role. Names are
yours; `Done` must be a completed-type state.

| Role | Default name | Type |
| --- | --- | --- |
| backlog | <span className="st backlog">Backlog</span> | Backlog |
| ready | <span className="st ready">Ready</span> | Unstarted |
| changesRequested | <span className="st changes">Changes Requested</span> | Started |
| inProgress | <span className="st progress">In Progress</span> | Started |
| question | <span className="st question">Question</span> | Started |
| humanReview | <span className="st review">Human Review</span> | Started |
| done | <span className="st done">Done</span> | Completed |

## 4. Two labels

`Confirm with user` (ask me before starting) and `UI` (design-sensitive).

## 5. Agent app users

Two Linear agents, one developer and one reviewer, so tasks can be delegated
to them. Each is an OAuth application with agent capability, created under
Settings > API > Applications and installed into the workspace with
`actor=app` by a workspace admin (Linear's guide:
[linear.app/developers/agents](https://linear.app/developers/agents)). Put
their user ids in `linear.agents`; find them with your API key:

```graphql
{ users(filter: { app: { eq: true } }) { nodes { id name displayName } } }
```

Until they are set, the loop cannot claim tasks.

## 6. The GitHub integration

Settings > Integrations > GitHub, connected to the repository. Then, per team,
under Workflows & automations > Pull request and commit automations, turn on
**PR merged -> Done**. Merging is what completes a task. Task branches carry
the issue identifier and PR bodies carry `Fixes <ID>`, which is how Linear
links them.

## 7. A personal API key

Settings > Account > Security & access, for the account the dispatcher acts
as. Every board write and comment posts under it; agent comments are tagged
`[developer]`, `[reviewer]`, `[cleaner]` or `[dispatcher]` on their first
line. Store it as in [Set up a repository](../getting-started/init.md).
