---
title: GitHub Projects v2 (alternative)
description: Running the board on a GitHub Projects v2 board instead of Linear - the fields it needs, the ids to collect, and what differs.
---

# GitHub Projects v2 (alternative backend)

Linear is the primary board. The GitHub Projects v2 backend is the flow the
dispatcher ran on before moving to Linear and is kept as a selectable
alternative. Everything above the backend is identical: the same commands, the
same states by role, the same claim semantics, the same loop.

## What the board needs

An organization-level Projects v2 board containing the issues of the one
configured repository, with:

- A **Status** single-select field with one option per role. The
  `question` role is optional here, to accommodate a frozen board that cannot
  gain a column; asking to move a row to a role the board has no option for
  fails loudly.
- A **Claimed By** text field. The claim text
  (`dev:<session-id>@<UTC minute>`) lives here instead of in a comment, and
  there is no delegate: `assign` and `claim` both write this field.
- Milestones on the issues (repository milestones, matched by title).
- The two labels (`confirm-with-user`, `ui` by default) as repository labels.

Pull requests link to issues through `Fixes #N` in the body and the
`task/<n>-<slug>` branch convention; GitHub closes the issue on merge and the
board reflects it. `dispatcher board link-pr` has no meaning on this backend
and says so.

## Collecting the ids

The config needs ids the API only hands out per board. With `gh` logged in:

```sh
# project id and number
gh api graphql -f query='
  query($org: String!) { organization(login: $org) { projectsV2(first: 20) { nodes { id number title } } } }' -f org=acme

# field ids and Status option ids
gh api graphql -f query='
  query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: 30) { nodes {
    ... on ProjectV2FieldCommon { id name }
    ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }' -f id=PVT_...
```

## The config

```json
{
  "platform": "github",
  "repository": "acme/widgets",
  "botUserIds": [100000001, 100000002],
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

`dispatcher init` writes this shape with `TODO` placeholders when you pick
GitHub Projects; fill them from the queries above. A config may carry both a
`linear` and a `github` section; `platform` picks one, and `--platform` or
`DISPATCHER_BOARD_PLATFORM` overrides it for a single command.

## What differs from Linear

| | Linear | GitHub Projects v2 |
| --- | --- | --- |
| Issue reference | `ACM-12` | `#480` (or `480`) |
| Board access | the Linear API key | the caller's `gh` auth |
| Claim | delegate plus a claim comment | the `Claimed By` text field |
| Delegate column in the poll | the agent's display name | `-` (no delegation) |
| Linking a PR | integration, or `link-pr` | `Fixes #N` only |
| Comments | tagged `**[role]**`, all under the API key's account | tagged, under the `gh` user |
| Event channel board signal | the Linear poller | `projects_v2_item`, `issues`, `issue_comment` and `sub_issues` webhooks, forwarded with the PR events |
| Review sync credential | `LINEAR_API_KEY` | a `GH_TOKEN` with the `project` scope |
