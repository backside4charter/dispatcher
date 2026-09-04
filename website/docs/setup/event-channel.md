---
title: Event channel
description: Optional - let board and PR changes wake the loop within seconds instead of at its timer.
---

# Event channel

Without it the loop wakes when an agent finishes and on a timer. With it, a
change on the board or a PR wakes the loop within seconds. Nothing depends on
it; if it is down the loop simply runs at timer speed.

One-time setup:

```sh
gh extension install cli/gh-webhook
gh auth refresh -h github.com -s admin:org_hook
```

Then, whenever you work, in a terminal of its own at the repository root:

```sh
dispatcher listen
```

It listens on a local port, forwards your organization's pull request events
through `gh webhook forward` (no public endpoint needed), polls the Linear
project every 30 seconds, and serves every dispatcher session on the machine.
Leave it running; `/dispatcher:stop` never stops it, Ctrl+C does.

Check it with `dispatcher status`. `forward: NOT running` with an `HTTP 404`
means the `admin:org_hook` scope is missing; `linear: off` names what is
missing on the Linear side. Several dispatcher-enabled repositories on one
machine each need their own port: set `listener.port` in each config.
