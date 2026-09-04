---
title: Review sync workflow
description: A small GitHub Actions job that sends a task back to Changes Requested the moment you request changes on its PR.
---

# Review sync workflow

When you leave a "Request changes" review on a PR, this workflow moves its
task back to `Changes Requested` within seconds, whether or not a dispatcher
session is running, and the next developer resumes the PR with your review
word for word. Reviews from the agents themselves are ignored.

Add `.github/workflows/board-review-sync.yml`, pinned to your dispatcher
version:

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

Add `LINEAR_API_KEY` as a repository secret. Most runs end with a one-line
"no action" and a green check; only an API failure shows red.
