---
title: Set up the GitHub Apps
description: Create the developer and reviewer GitHub Apps, install them, store their keys, and fill in githubApps in the config.
---

# Set up the GitHub Apps

Two GitHub Apps give agent work identities of its own: the **developer** app
authors commits and opens PRs, the **reviewer** app posts reviews. [Two agent
identities](../in-depth/identities.md) explains why there are two. This page
is the procedure.

The board commands work without the apps. `dispatcher commit`, `pr`,
`token` and `identity` need them, and so do the developer and reviewer
agents, so a loop without them produces PRs under your own account that you
cannot approve.

## 1. Register two apps

For each of the two, under your organization's Settings > Developer settings >
GitHub Apps > New GitHub App (an app owned by the organization is simplest;
a personal one installed on the organization works too):

| Field | Developer app | Reviewer app |
| --- | --- | --- |
| Name | e.g. `acme-developer`; the slug is derived from it and fixed at creation | e.g. `acme-reviewer` |
| Homepage URL | anything, the repository URL is fine | same |
| Webhook | uncheck **Active**; the dispatcher does not receive app webhooks | same |
| Repository permissions | **Contents: Read and write** (push the freshness-sweep merge commits, update branches), **Pull requests: Read and write** (open PRs, update branches). Metadata: Read is added automatically | **Pull requests: Read and write** (post reviews). Metadata: Read |
| Where can this app be installed | Only on this account | same |

Fewer permissions is better; `dispatcher identity` prints what an
installation was actually granted, and the `X-Accepted-GitHub-Permissions`
response header names what an endpoint needs if a call is refused.

## 2. Generate and store the private keys

On each app's settings page, under Private keys, generate a key. GitHub
downloads a PEM file. Save it in the main checkout of your repository as:

```
.secrets/<slug>.private-key.pem
```

for example `.secrets/acme-developer.private-key.pem`. `.secrets/` must be
gitignored; it is also where `api-keys.json` lives. The path is resolved from
the main working tree, so it works from any git worktree. An environment
variable can point elsewhere instead: `DISPATCHER_GITHUB_APP_KEY_DEVELOPER`
and `DISPATCHER_GITHUB_APP_KEY_REVIEWER` by default, or the name you set in
the app's `keyEnvVar`.

## 3. Install both apps on the organization

From each app's settings page, Install App, choose the organization, and
select the repository (or all repositories). The installation id is in the
URL of the resulting page:
`https://github.com/organizations/<org>/settings/installations/<installation id>`.

## 4. Collect the ids

The config needs five values per app. All names are display-only; the numeric
ids are what the code compares.

| Config field | Where to find it |
| --- | --- |
| `appId` | the app's settings page, "App ID" |
| `installationId` | the installation URL from step 3 |
| `slug` | the app's settings page URL: `.../settings/apps/<slug>` |
| `botLogin` | `<slug>[bot]` |
| `botUserId` | `gh api "users/<slug>%5Bbot%5D" --jq .id` (needs a user token, which `gh` has) |

```sh
gh api "users/acme-developer%5Bbot%5D" --jq '{login: .login, id: .id, type: .type}'
gh api "users/acme-reviewer%5Bbot%5D"  --jq '{login: .login, id: .id, type: .type}'
```

## 5. Fill in the config

Either answer yes to the apps question in `dispatcher init`, or add the
section by hand:

```json
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
"botUserIds": [100000001, 100000002]
```

`botUserIds` repeats the two bot ids at the top level; it is what the review
sync and the event channel use to ignore the bots' own reviews and pushes.
Optional per app: `keyFile` (file name inside `.secrets/`, default
`<slug>.private-key.pem`) and `keyEnvVar`.

## 6. Verify

```sh
dispatcher identity                    # the developer app: permissions, account, bot email
dispatcher identity --app reviewer
dispatcher token | cut -c1-8           # mints a token; prints its first characters
```

`identity` prints the installation's granted permissions, the repository
selection, the bot login, and the git author email commits must carry
(`<botUserId>+<botLogin>@users.noreply.github.com`). If the key is missing it
says where it looked.

A first end-to-end check, on a scratch branch:

```sh
git switch -c task/acm-0-identity-check
echo test >> README.md && git add README.md
dispatcher commit -m "Identity check"
git push -u origin HEAD
dispatcher pr --title "Identity check" --body "Fixes nothing; delete me." --draft
```

`dispatcher pr` prints the PR URL, `opened by: acme-developer[bot] (Bot)`, and
`all commits attributed to acme-developer[bot]`. Close and delete the PR
afterwards.

## Branch protection and required reviews

The reviewer app only ever posts `COMMENT` reviews, so it can never satisfy a
required-approval rule; that is intended. If your repository requires an
approving review before merge, you are the approver, and the developer app
being the PR author is what lets you approve. If a ruleset restricts who may
push, allow the developer app: the freshness sweep pushes merge commits to
bot-authored branches through its token.
