---
title: Overview
slug: /
description: What the dispatcher is and where to start.
---

# dispatcher

<p class="lede">
The dispatcher works your Linear board for you. A long-running Claude Code
session hands each task to an AI developer, has an AI reviewer check the
result, and puts the finished pull request in front of you. You decide what
is ready, answer the odd question, and merge.
</p>

## What it is made of

- **A binary**, `dispatcher`, that reads and writes the board and handles the
  GitHub plumbing.
- **A Claude Code plugin** with the `/dispatcher:start` and `/dispatcher:stop`
  commands and the three agents that do the work.
- **One config file**, `dispatcher.config.json`, committed in your repository.

## Where to go

| You want to | Read |
| --- | --- |
| understand it in a few minutes | [How it works](concepts/how-it-works.mdx), then [The board](concepts/the-board.md) |
| set it up | [Get started](getting-started/get-started.md): hand the setup to your AI |
| run it day to day | [Run the loop](getting-started/first-run.md) |
| point an AI at the details | [Setup guide for AI agents](ai/setup.md), [System breakdown](ai/system.md) |
