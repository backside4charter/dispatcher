---
title: Run the loop
description: Start the event channel and the dispatcher session, read its status text, and stop it cleanly.
---

# Run the loop

## 1. Start the event channel (optional)

In a terminal of its own, at the repository root:

```sh
dispatcher listen
```

It binds a loopback port, starts `gh webhook forward` for your organization's
pull request events, polls the Linear project every 30 seconds, and appends
board events to `.claude/dispatcher/events.jsonl`. Leave it running; it serves
every dispatcher session on the machine. Check it with `dispatcher status`.

The loop works without it, at the latency of its own polling timer. Details
and machine setup: [Event channel](../setup/event-channel.md).

## 2. Open the dispatcher session

Start Claude Code at the repository root. The dispatcher itself needs no heavy
reasoning, so a strong model at low effort is the economical choice, and the
CLI flags leave your saved default alone:

```sh
claude --model opus --effort low
```

The workers are pinned by their own agent definitions (`model: opus`,
`effort: xhigh`), so task work and review always run on the strong model
regardless of what the dispatcher session uses.

## 3. Start it

```
/dispatcher:start v1.1.0
```

Name one or more milestones; several are fine when a patch release is open
alongside the next minor (`/dispatcher:start v1.1.0 v1.0.1`). Without an
argument the skill lists the board's milestones and asks. The milestone set is
the only scope filter: issues outside it are never picked, whatever their
state.

On the first firing the dispatcher tells you which milestones it is working
and how to stop it, runs `dispatcher board config`, polls, and starts
dispatching. Then it settles into the rhythm described in [The dispatcher
loop](../in-depth/dispatcher-loop.md): process finished workers, top up,
freshen PRs, scan, prune, re-arm.

## What you will see

**On the board.** A dispatched issue moves to `In Progress`, gets the
developer agent as its delegate, and receives one comment:

```
**[developer]** claimed 2026-08-27T14:05Z · `claude --resume <session-id>`
```

That comment is the [claim](../in-depth/claims.md). Its timestamp is refreshed
every firing while the worker runs, and the `claude --resume` command is
literally how you reopen the session that holds it. When the developer
finishes, the delegate flips to the reviewer agent and the claim disappears
until a reviewer picks it up. When the reviewer passes, the row lands in
`Human Review` with no delegate: it is yours.

**In the session.** Every firing ends with one line of status text saying
which of three states the loop is in:

| Status | Meaning |
| --- | --- |
| At a cap | two developers or two reviewers are running; it says which issues |
| Out of work | it polled this firing and nothing was eligible; it says why (all Backlog, all claimed, all blocked, human-owned) |
| Blocked on you | PRs are waiting at `Human Review`; the count comes from `gh pr list`, not from board rows |

It also relays anything that needs you: a `Question` row (in full, every
firing until you answer), a stale claim it took over from a dead session,
`Confirm with user` rows it skipped, follow-up work a worker described, and
PRs it could not bring up to date with `main`.

**On GitHub.** Branches named `task/<identifier>-<slug>`, PRs opened by the
developer app with `Fixes <identifier>` in the body, a `COMMENT` review from
the reviewer app with line-anchored findings, and merge commits from the
developer app when the loop updates a branch that fell behind `main`.

## What you do while it runs

- **Order the board.** Manual order is the priority signal within a tier;
  the loop re-polls every firing, so a reorder takes effect at the next one.
- **Promote work** by moving issues from `Backlog` to `Ready`. Only you do
  this.
- **Review and merge** PRs at `Human Review`. Your merge completes the issue
  through the board's GitHub integration.
- **Request changes** on a PR when it is not right. With the [review sync
  workflow](../setup/review-sync.md) in place the issue goes back to
  `Changes Requested` within seconds and the next developer resumes that
  same PR with your review carried into its prompt, verbatim.
- **Answer questions.** A worker that hits a decision only you can make
  parks its task: it comments the question, sets the state to `Question` and
  releases its claim. Reply in a comment on the issue and move the row to
  `Ready` (never worked) or `Changes Requested` (a PR exists). The next
  worker gets both the question and your answer.
- **Label `Confirm with user`** on anything you want a word about before it
  starts; the loop skips those and mentions them once.
- **Take a task yourself** by assigning yourself in Linear with no agent set;
  the loop skips human-owned tasks. Do it when no worker holds the task, or
  the next heartbeat hands it back to the agent
  ([details](../concepts/the-board.md#taking-a-task-yourself)).

## Stopping

```
/dispatcher:stop        # drain: no new work, finish what is running, release claims
/dispatcher:stop now    # abort: stop the running workers, restore their rows
```

Run it in the dispatcher session. Stopping ends the loop's wakeups, stops the
background event waiter, and leaves the board honest: no `In Progress` row
without a worker behind it, and no claim from this session. A drain can take
as long as the longest running developer; the skill tells you what is in
flight and that the session has to stay open until it reports.

Everything durable is on the board and on GitHub, so the next
`/dispatcher:start` resumes exactly where this one stopped. A session that
dies without stopping leaves its claims behind; they age out after 90 minutes
and the next dispatcher takes them over ([Claims and
sessions](../in-depth/claims.md)).

The listener is never stopped by `/dispatcher:stop`. Stop it with Ctrl+C in
its own terminal when you are done for the day.
