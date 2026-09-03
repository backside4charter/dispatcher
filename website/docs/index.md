---
title: Overview
slug: /
description: What the dispatcher is, what it is made of, and where to start.
---

# dispatcher

<p class="lede">
An autonomous backlog dispatcher for agent-driven development. A long-running
Claude Code session works your task board top to bottom: each task goes to a
fresh developer agent that lands it as a pull request, each finished PR goes
to an adversarial reviewer agent, and each PR that drifts into conflict goes
to a cleaner agent. You keep the two jobs that matter, ordering the backlog
and merging.
</p>

## What it is made of

| Piece | What it is | Where it lives |
| --- | --- | --- |
| The `dispatcher` binary | One self-contained executable per platform: the board CLI, the event channel, the agent identity tooling, the review-to-board sync and the worktree pruner | Installed on your machine (and in CI for the review sync) |
| The Claude Code plugin | The `dispatcher:start` and `dispatcher:stop` skills that run the loop, three companion skills with the worker procedures, and the `developer`, `reviewer` and `cleaner` agent definitions | Enabled per repository in `.claude/settings.json` |
| `dispatcher.config.json` | Everything project-specific: the board platform and project, what your team calls each workflow state and label, the repository PRs land in, and the agent identities | Committed at your repository root |

Nothing project-specific lives in the dispatcher's source. A new project writes
a config (the `dispatcher init` wizard does most of it) and picks a platform:
[Linear](setup/linear.md) or [GitHub Projects v2](setup/github-projects.md).

## Where to go

| If you want to | Read |
| --- | --- |
| understand it in a few minutes | [How it works](concepts/how-it-works.mdx), then [The board](concepts/the-board.md) |
| install it and run it | [Install](getting-started/install.md), [Set up a repository](getting-started/init.md), [Run the loop](getting-started/first-run.md) |
| prepare Linear and GitHub | [Set up Linear](setup/linear.md), [Set up the GitHub Apps](setup/github-apps.md), [Review sync workflow](setup/review-sync.md), [Event channel setup](setup/event-channel.md) |
| look something up | [CLI](reference/cli.md), [Config](reference/config.md), [Credentials](reference/credentials.md), [Claude Code plugin](reference/plugin.md) |
| know exactly what the loop does and why | [In depth](in-depth/board-model.md) |
