---
title: Review sync workflow
description: Add the GitHub Actions workflow that runs dispatcher review-sync when a review is submitted on a pull request.
---

# Review sync workflow

[Review sync](../in-depth/review-sync.md) is a `dispatcher review-sync` run
triggered by GitHub on every submitted pull request review. It needs the
binary, the repository's `dispatcher.config.json`, and board credentials.

## The workflow

Add `.github/workflows/board-review-sync.yml` to the repository the PRs land
in. Pin the dispatcher version to the one your config was written for.

```yaml
name: Board review sync

on:
  pull_request_review:
    types: [submitted]

permissions:
  contents: read

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      # The config file is read from the repository root.
      - uses: actions/checkout@v4

      - name: Install dispatcher
        env:
          DISPATCHER_VERSION: 0.3.1
        run: |
          curl -fsSL https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"

      - name: Sync the board
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
        run: dispatcher review-sync
```

`review-sync` reads the event payload from `GITHUB_EVENT_PATH`, which GitHub
Actions sets automatically. On a Linear board it needs `LINEAR_API_KEY` as a
repository secret. On a GitHub Projects board it needs a token that can write
the organization project: set `GH_TOKEN` to a fine-grained or classic token
with the `project` scope, because the workflow's own `GITHUB_TOKEN` cannot
write organization projects.

## What a run looks like

Most runs do nothing and say why in one line, exit 0:

```
no action: not-a-change-request (review by someuser on PR #481)
```

A change request by you on a PR whose issue is at `Human Review`:

```
change request by someuser on PR #481; board: linear (/home/runner/work/widgets/widgets/dispatcher.config.json)
linked ACM-480 (Human Review) via attachment
moved ACM-480  Human Review -> Changes Requested, agent handed back (no claim)
done: 1 moved, 0 left alone
```

A review by either bot (`botUserIds`) is ignored as `bot-reviewer`. An API
failure exits non-zero so the run shows red.

## Checking it

Submit a "Request changes" review on a PR at `Human Review`. The Actions run
should appear within seconds and the issue should read `Changes Requested`
with no delegate. The next dispatcher firing dispatches a developer at it,
and its prompt carries your review verbatim.
