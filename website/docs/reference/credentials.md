---
title: Credentials and environment
description: Where every credential is looked up, every environment variable the binary reads, and the layout of .secrets/.
---

# Credentials and environment

Credentials are looked up, never configured. Nothing secret goes in
`dispatcher.config.json`.

## Where each credential comes from

| Credential | Used by | Looked up as |
| --- | --- | --- |
| Linear API key | every `board` command on Linear, the listener's poller, `init` discovery, `review-sync` | `LINEAR_API_KEY`, else the `Linear` entry of `.secrets/api-keys.json` in the main checkout |
| GitHub board access (Projects v2) | `board` commands on GitHub, `pr-issues`, `link-pr` lookups, the poll's PR reads | the caller's `gh` auth (`gh auth login`); in CI, `GH_TOKEN` |
| Developer app private key | `commit` (identity only), `pr`, `token`, `identity`, the freshness sweep | `DISPATCHER_GITHUB_APP_KEY_DEVELOPER` (or the configured `keyEnvVar`), else `.secrets/<slug>.private-key.pem` |
| Reviewer app private key | `token --app reviewer`, `identity --app reviewer`, the reviewer agent | `DISPATCHER_GITHUB_APP_KEY_REVIEWER`, else `.secrets/<slug>.private-key.pem` |
| Organization webhook access | `dispatcher listen` (through `gh webhook forward`) | `gh` auth with the `admin:org_hook` scope |
| Pushing branches | workers | your normal `origin` remote (SSH or HTTPS); who pushes has no bearing on attribution |

## The `.secrets/` directory

```
.secrets/
  api-keys.json                     {"Linear": "lin_api_..."}
  acme-developer.private-key.pem    the developer app's key
  acme-reviewer.private-key.pem     the reviewer app's key
```

It is gitignored and therefore exists only in the **main checkout**. Every
linked worktree points back at the main checkout's git directory, which is
what `git rev-parse --git-common-dir` reports, so the binary resolves
`.secrets/` from any worktree, including a worker's.

## Environment variables the binary reads

| Variable | Read by | Meaning |
| --- | --- | --- |
| `LINEAR_API_KEY` | Linear backend, listener, init | the API key; overrides the file |
| `DISPATCHER_CONFIG` | every command | explicit config path; `--config` wins over it |
| `DISPATCHER_BOARD_PLATFORM` | every board-reading command | platform override; `--platform` wins over it |
| `DISPATCHER_STATE_DIR` | `listen`, `status`, `wait`, `consume` | event-channel state directory; `--dir` wins over it; default `.claude/dispatcher/` beside the config |
| `DISPATCHER_GITHUB_APP_KEY_DEVELOPER`, `DISPATCHER_GITHUB_APP_KEY_REVIEWER` | app commands | path to the app's private key; names are configurable per app |
| `CLAUDE_CODE_SESSION_ID` | `board claim`, `board claims` | the session id written into claims; set by Claude Code |
| `GITHUB_EVENT_PATH` | `review-sync` | the webhook payload file; set by GitHub Actions |
| `GH_TOKEN` | anything that shells out to `gh` | `gh`'s token; workers scope it to single commands when they use an app token |

Installer-only: `DISPATCHER_VERSION` and `DISPATCHER_INSTALL`.

## Files the binary writes

| Path | Written by | Committed |
| --- | --- | --- |
| `dispatcher.config.json` | `init` | yes |
| `.claude/settings.json` | `init` (merges the plugin entries) | yes, normally |
| `.claude/dispatcher/events.jsonl`, `cursor.json`, `listener.json`, `waiter.json` | the event channel | no; gitignore `.claude/dispatcher/` |
| `.claude/worktrees/*` | Claude Code's worktree isolation; removed by `prune-worktrees` | no |

## In CI

The review sync needs the config (checked out with the repository) and one
credential: `LINEAR_API_KEY` as a repository secret on Linear, or a `GH_TOKEN`
with the `project` scope on GitHub Projects. It never needs the app keys.
