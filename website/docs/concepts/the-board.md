---
title: The board
description: What each column means, who moves a task between them, and the two markers that show who is holding it.
---

# The board

The board is the one shared source of truth: you and the dispatcher both read
it and write to it, and nothing important lives anywhere else. Tasks are
issues in one Linear project, scoped by milestone and ranked by the board's
manual order. Your team can name the columns anything; the config maps each
name to its role. The colours below are the ones Linear paints the states in.

## The seven states

| State | Means | Who moves a task here |
| --- | --- | --- |
| <span className="st backlog">Backlog</span> | not yet | you |
| <span className="st ready">Ready</span> | go, never worked; gets a fresh branch | you |
| <span className="st progress">In Progress</span> | a developer or the reviewer has it | the dispatcher |
| <span className="st changes">Changes Requested</span> | sent back; the same PR gets more commits | the reviewer's verdict, or your review on the PR |
| <span className="st question">Question</span> | waiting on a decision only you can make | the worker that got stuck |
| <span className="st review">Human Review</span> | a PR is waiting for you | the dispatcher, after a passing review |
| <span className="st done">Done</span> | merged | your merge, through Linear's GitHub integration |

## Five rules worth remembering

1. **Only you move a task out of `Backlog` or `Question`.** Answer a question
   by replying on the issue, then move it to `Ready` (no PR yet) or `Changes
   Requested` (a PR exists).
2. **Merging is what makes a task `Done`.** No agent merges or writes `Done`.
   The PR is linked to the issue by its branch name and a `Fixes <ID>` line,
   which the developer adds automatically.
3. **`Changes Requested` is rework, not a restart.** The next developer adds
   commits to the existing PR, and it goes ahead of every `Ready` task.
4. **One task is one PR.** Steps inside a task are a checkbox list in the
   issue description; the developer ticks them as it goes, and a task is not
   reviewed until every box is ticked.
5. **Order is priority, milestones are scope.** Reorder the board to change
   what happens next; the dispatcher only touches the milestones you named.

## Who is holding a task

Two markers, both on the issue:

- **The delegate**, shown in Linear's assignee field, is the agent that
  currently owns the task: the developer agent or the reviewer agent. It says
  which phase the task is in.
- **The claim** is one comment naming the session that is working it right
  now:

  ```
  **[developer]** claimed 2026-08-27T14:05Z · `claude --resume <session-id>`
  ```

  The timestamp is refreshed while the worker runs. If it stops moving for
  90 minutes the session is presumed dead and the next dispatcher takes the
  task over. Paste the `claude --resume` command to open that session.

Two labels also steer a task: `Confirm with user` means "ask me before
starting", and `UI` marks design-sensitive work.

## Taking a task yourself

Assign the task to yourself in Linear and leave the agent empty: in the
assignment menu pick yourself as the assignee and **No agent** as the agent. A
task with a person assigned and no agent is human-owned, and the dispatcher
skips it in every state, so it can sit in `Ready` or `In Progress` while you
work on it.

- **Do not take over a task a worker is on.** While a claim is fresh, the
  dispatcher re-asserts the agent on every heartbeat, so removing the agent
  by hand lasts only until the next round. Take a task when its claim comment
  is gone or stale, or stop the loop first.
- **Your name alone is not the signal.** Delegating a task to an agent also
  sets its assignee to the dispatcher's Linear account, so an agent-held task
  can carry your name too. Yours means your name **and no agent**.
- **Hand it back** by clearing yourself as assignee and moving it to `Ready`
  (nothing built) or `Changes Requested` (a PR exists). If your own PR
  merges, the task completes like any other.
- To have the loop check with you before an agent starts a task, use the
  `Confirm with user` label instead of assigning yourself.

That is everything you need to use the dispatcher. Setup is under [Getting
started](../getting-started/install.md); the full rules the loop follows are
under [In depth](../in-depth/board-model.md).
