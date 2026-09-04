---
title: Get started
description: Hand the setup to your AI - one message is enough - and have a few things ready when it asks.
---

# Get started

Setting the dispatcher up is a job for an AI. Open your AI coding tool (Claude
Code is the one the loop itself runs in) in the repository your pull requests
land in, and give it this:

```
Set up the dispatcher in this repository by following
https://backside4charter.github.io/dispatcher/ai/setup
```

It installs the binary, finds your Linear team, project and workflow states,
writes the config, enables the plugin, and adds the small CI workflow that
sends tasks back when you request changes. Where it needs you it asks.

## Have these ready

| It will ask for | Where it comes from |
| --- | --- |
| A Linear API key | Linear > Settings > Account > Security & access > Personal API keys |
| Which team and project is the board | you |
| Two Linear agents (one developer, one reviewer) | created and installed by a workspace admin under Settings > API > Applications; the guide explains |
| Two GitHub Apps for the agents' commits and reviews | registered and installed by an organization owner; the guide gives the exact permissions |
| The GitHub integration in Linear, with *PR merged -> Done* on | Linear > Settings > Integrations > GitHub, then the team's automations |

Everything it writes is committed to the repository except your credentials,
which live in a gitignored `.secrets/` folder.

## Then

Restart Claude Code in the repository so it picks up the plugin, and run:

```
/dispatcher:start <milestone>
```

[Run the loop](first-run.md) covers what you will see and what you do while
it runs. Prefer to do the setup by hand? See the Advanced pages below, starting
with [Install](install.md).
