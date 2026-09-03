---
title: Config reference
description: Every field of dispatcher.config.json, with a complete example naming both platforms.
---

# Config reference

`dispatcher.config.json` lives at the repository root and is committed, so
every worktree, every session and every CI run reads the same file. It is
also the marker the binary locates the repository by. It is validated with a
schema on every load, and an invalid file is reported with every violation at
once, by field path.

## Top level

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `platform` | `"linear"` \| `"github"` | yes | which board backend answers; the matching section must be present |
| `repository` | `owner/name` | yes | the GitHub repository pull requests are opened in; its owner is also the organization whose webhooks the listener forwards |
| `botUserIds` | number[] | yes (may be empty) | numeric GitHub user ids of the agent bot accounts; their reviews never drive the review sync and their webhook deliveries never wake the loop |
| `claimStaleMinutes` | positive integer | no, default 90 | a claim older than this, from another session, belongs to a dead session |
| `listener` | object | no | event listener tuning |
| `githubApps` | object | no | the two agent GitHub Apps; required by `commit`, `pr`, `token`, `identity` |
| `linear` | object | when `platform` is `linear` | the Linear board |
| `github` | object | when `platform` is `github` | the GitHub Projects v2 board |

A config may carry both `linear` and `github`; `--platform` or
`DISPATCHER_BOARD_PLATFORM` switches between them for one command.

## `listener`

| Field | Type | Meaning |
| --- | --- | --- |
| `port` | 1 to 65535 | loopback port `dispatcher listen` binds (default 47831). Each dispatcher-enabled repository on one machine needs its own |

## `githubApps.developer` and `githubApps.reviewer`

Both entries have the same shape. See [Set up the GitHub
Apps](../setup/github-apps.md) for where each value comes from.

| Field | Type | Meaning |
| --- | --- | --- |
| `appId` | positive integer | the GitHub App's id, used as the JWT issuer |
| `installationId` | positive integer | the organization installation tokens are scoped to |
| `slug` | string | the app's URL slug, fixed at creation; `gh` reports the PR author as `app/<slug>` |
| `botLogin` | string | the bot account's login, `<slug>[bot]`; display-only |
| `botUserId` | positive integer | the bot account's numeric user id: the identifier commits are attributed on, and the one that survives a rename |
| `keyFile` | string, optional | file name of the private key inside `.secrets/`; default `<slug>.private-key.pem` |
| `keyEnvVar` | string, optional | environment variable that overrides the key path; default `DISPATCHER_GITHUB_APP_KEY_DEVELOPER` / `_REVIEWER` |

## `linear`

| Field | Type | Meaning |
| --- | --- | --- |
| `workspace` | string | the workspace URL key (`acme` in `linear.app/acme`) |
| `teamId` | string | the team's id |
| `teamKey` | string | the identifier prefix (`ACM` in `ACM-12`); references are validated against it |
| `projectId` | string | the project's id; every poll and the listener's poller filter on it |
| `projectUrl` | URL | the project's URL, printed by `board config` |
| `states` | object | the team's state name for each of the seven roles: `backlog`, `ready`, `changesRequested`, `inProgress`, `question`, `humanReview`, `done`. All required |
| `agents.developer`, `agents.reviewer` | string | the Linear user ids of the two agent app users rows are delegated to |
| `labels.confirmWithUser`, `labels.ui` | string | the label names |

## `github`

| Field | Type | Meaning |
| --- | --- | --- |
| `owner` | string | the organization (or user) that owns the Projects v2 board |
| `projectNumber` | positive integer | the board's number |
| `projectId` | string | the board's node id (`PVT_...`) |
| `statusFieldId` | string | the Status single-select field's id |
| `claimedByFieldId` | string | the Claimed By text field's id |
| `states.<role>` | `{ name, optionId }` | each role's Status option: display name and stable option id. `question` is optional; every other role is required |
| `labels.confirmWithUser`, `labels.ui` | string | the repository label names |

## Complete example

Fictional `acme/widgets`, naming both platforms:

```json
{
  "platform": "linear",
  "repository": "acme/widgets",
  "botUserIds": [100000001, 100000002],
  "claimStaleMinutes": 90,
  "listener": { "port": 47831 },
  "githubApps": {
    "developer": {
      "appId": 111111,
      "installationId": 10000001,
      "slug": "acme-developer",
      "botLogin": "acme-developer[bot]",
      "botUserId": 100000001
    },
    "reviewer": {
      "appId": 222222,
      "installationId": 10000002,
      "slug": "acme-reviewer",
      "botLogin": "acme-reviewer[bot]",
      "botUserId": 100000002
    }
  },
  "linear": {
    "workspace": "acme",
    "teamId": "team-1",
    "teamKey": "ACM",
    "projectId": "proj-1",
    "projectUrl": "https://linear.app/acme/project/widgets-0a1b2c3d4e5f",
    "states": {
      "backlog": "Backlog",
      "ready": "Ready",
      "changesRequested": "Changes Requested",
      "inProgress": "In Progress",
      "question": "Question",
      "humanReview": "Human Review",
      "done": "Done"
    },
    "agents": {
      "developer": "agent-developer",
      "reviewer": "agent-reviewer"
    },
    "labels": { "confirmWithUser": "Confirm with user", "ui": "UI" }
  },
  "github": {
    "owner": "acme",
    "projectNumber": 2,
    "projectId": "PVT_exampleProject01",
    "statusFieldId": "PVTSSF_status",
    "claimedByFieldId": "PVTF_claim",
    "states": {
      "backlog": { "name": "Hold", "optionId": "c6c58d18" },
      "ready": { "name": "Ready", "optionId": "f75ad846" },
      "changesRequested": { "name": "Changes Requested", "optionId": "cbe4dc71" },
      "inProgress": { "name": "In Progress", "optionId": "47fc9ee4" },
      "humanReview": { "name": "User Review", "optionId": "b2bb70ee" },
      "done": { "name": "Done", "optionId": "98236657" }
    },
    "labels": { "confirmWithUser": "confirm-with-user", "ui": "ui" }
  }
}
```

## How the file is found

1. `--config <path>` on the command line.
2. The `DISPATCHER_CONFIG` environment variable.
3. The nearest `dispatcher.config.json` at or above the working directory.

The walk starts from the working directory, never from the binary's own
location. A git worktree under `.claude/worktrees/` carries its own copy of
the committed file, so commands run inside a worker's worktree resolve to
that worktree, and the event channel's state directory
(`.claude/dispatcher/` beside the config) is never shared by accident.

## Changing states or labels later

Renaming a state in Linear without updating `linear.states` makes the next
write fail with `unknown state "<name>"; the team has: ...`, naming the live
states, rather than writing to the wrong column. Update the config and the
board together. Adding a state the config does not name is harmless: it has
no role, and the dispatcher leaves rows in it alone.
