---
title: Set up Linear
description: Everything to create and configure in a Linear workspace before the dispatcher can work it - one time per project.
---

# Set up Linear

This is the one-time setup on the Linear side. Most of it is done once per
workspace; the project, its milestones and the config are per repository.

## 1. A team and a project

The dispatcher works **one project** on **one team**. The project is the
board; its manual issue order is the priority order the loop dispatches in.

- Note the team's **key**, the prefix in `ACM-12`. It becomes
  `linear.teamKey` and is how issue references are validated.
- Create the project (or use an existing one). Its id and URL go in
  `linear.projectId` and `linear.projectUrl`; `dispatcher init` discovers
  both.

## 2. Project milestones

Create a project milestone per release or batch (`v1.1.0`, `v1.0.1`). The loop
is scoped to the milestones you name at `/dispatcher:start`, matched by name,
and never picks an issue outside them. Issues without a milestone show under
`(none)` in `dispatcher board milestones` and are never dispatched.

## 3. Seven workflow states

Under Settings > Teams > *your team* > Workflow, make sure the team has a
state for each of the seven roles. The names are yours; the config maps them.
The wizard's defaults, with the Linear state type each should have:

| Role | Default name | Linear type | Notes |
| --- | --- | --- | --- |
| `backlog` | Backlog | Backlog | never dispatched |
| `ready` | Ready | Unstarted | never worked; a fresh branch |
| `changesRequested` | Changes Requested | Unstarted or Started | sent back; has an open PR |
| `inProgress` | In Progress | Started | a developer or the reviewer holds it |
| `question` | Question | Started (or Unstarted) | parked on you |
| `humanReview` | Human Review | Started | a PR waits on you |
| `done` | Done | **Completed** | must be a completed-type state; the CLI derives "closed" from the type |

Any other states the team has (Canceled, Duplicate, Triage) are fine; they
map to no role and the dispatcher leaves rows in them alone. The states are
listed with their roles by `dispatcher board states`.

## 4. Two labels

Create two workspace or team labels and name them in `linear.labels`:

- **Confirm with user** (`labels.confirmWithUser`): agent-workable, but you
  want a word before it starts. The loop skips it and mentions it once.
- **UI** (`labels.ui`): design-sensitive work; carried into the developer's
  prompt so the project's design rules apply.

Do not create a `Question` label. Questions are a state, and the CLI refuses
to write a label by that name.

## 5. Agent app users

Claims delegate an issue to an agent user, which is what puts the owning agent
in Linear's assignee UI. You need two: a **developer** agent and a
**reviewer** agent. Cleanup work runs as the developer.

A Linear agent is an OAuth application with agent capabilities, installed into
the workspace as an app. Linear's developer documentation
([Getting started with agents](https://linear.app/developers/agents)) has the
current steps; the shape is:

1. Under Settings > API > Applications, create an application. Give it the
   name and icon you want to see on delegated issues (`acme-developer`, say).
   Enable the agent capability so it can be delegated to.
2. Install it into the workspace with the `actor=app` OAuth flow (workspace
   admin permissions are required). Once installed, the app appears as a
   workspace user that issues can be delegated to, and it needs access to the
   team the project belongs to.
3. Repeat for the reviewer.

The dispatcher never uses the agents' OAuth credentials. Your own API key can
set an issue's delegate to an app user, which is what makes a claim a
one-call write. What the config needs is each app user's **Linear user id**.
Find them with your API key:

```graphql
query {
  users(filter: { app: { eq: true } }) {
    nodes { id name displayName active }
  }
}
```

```sh
curl -s https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ users(filter: { app: { eq: true } }) { nodes { id name displayName active } } }"}'
```

Put the ids in `dispatcher.config.json`:

```json
"agents": {
  "developer": "1c1f7b3e-....",
  "reviewer": "9d2a44e0-...."
}
```

Until these are set, `dispatcher board claim` fails loudly and nothing is
dispatched; the read-only board commands work regardless.

Note that delegating an issue also sets its assignee to the account whose API
key made the call. That is why the dispatcher reads assignee and delegate
together and why `release` clears both: see [The board
model](../in-depth/board-model.md#who-owns-a-row-assignee-read-with-delegate).

## 6. The GitHub integration

Enable the GitHub integration for the workspace (Settings > Integrations >
GitHub) and connect the repository the PRs land in. Then, per team, under
Settings > Team > Workflows & automations > Pull request and commit
automations, set:

- **PR merged -> Done.** Required. Your merge is what completes a task; the
  dispatcher never writes `Done` on a top-level task.
- **PR opened -> In Progress** may stay on or off. The dispatcher sets `In
  Progress` at dispatch, before the PR exists, so it is a no-op.
- Leave any automation that would move issues on **review requested** off,
  or pointed at a state with no role. Agents never request GitHub reviews,
  so it would not normally fire, but a row moved to an unmapped state is
  invisible to the loop.

Linear links a PR to an issue when the branch name or the PR description
carries the identifier. The dispatcher computes task branches as
`task/acm-480-short-slug` and every PR body carries `Fixes ACM-480`, so both
routes apply. Magic words are a team setting too; make sure closing words
(`Fixes`, `Closes`) are recognised.

## 7. A personal API key

Every board read and write, and every comment, goes out under one Linear
account: the one whose API key the dispatcher finds. Create a personal API
key for that account under Settings > Account > Security & access, and put it
where the binary looks:

- `LINEAR_API_KEY` in the environment (CI, or a one-off), or
- `.secrets/api-keys.json` at the repository root: `{"Linear": "lin_api_..."}`.

Because comments all post under this account, agent comments are tagged on
their first line (`**[developer]**`, `**[reviewer]**`, `**[cleaner]**`,
`**[dispatcher]**`), and an untagged comment is read as yours. If you would
rather agent comments not post under your personal account, create a member
account for the dispatcher and use its key; the assignee that delegation sets
will then be that account too.

## 8. Write the config

Run [`dispatcher init`](../getting-started/init.md) at the repository root. It
discovers the workspace key, team, project and states from the API key and
asks about the rest. Then fill in `linear.agents` and verify:

```sh
dispatcher board config
dispatcher board states
dispatcher board poll v1.1.0
```

## Checklist

- [ ] Team key and project noted; milestones created
- [ ] Seven states exist, `Done` is a completed-type state
- [ ] `Confirm with user` and `UI` labels exist
- [ ] Developer and reviewer agent apps installed; their user ids in `linear.agents`
- [ ] GitHub integration connected; *PR merged -> Done* automation on for the team
- [ ] API key in `LINEAR_API_KEY` or `.secrets/api-keys.json`
- [ ] `dispatcher board poll <milestone>` returns your rows
