---
title: The board
description: What each column means, who moves a task between them, how to take a task yourself.
---

# The board

The board is the one shared source of truth: you and the dispatcher both read
it and write to it. Tasks are issues in one Linear project, scoped by
milestone and ranked by the board's manual order. Your team can name the
columns anything; the config maps each name to its role. The colours are the
ones Linear paints the states in.

## The seven states

| State | Means | Who moves a task here |
| --- | --- | --- |
| <span className="st backlog">Backlog</span> | not yet | you |
| <span className="st ready">Ready</span> | go; never worked | you |
| <span className="st progress">In Progress</span> | an agent has it | the dispatcher |
| <span className="st changes">Changes Requested</span> | sent back; the same PR gets more commits | the reviewer, or your review on the PR |
| <span className="st question">Question</span> | waiting on a decision only you can make | the agent that got stuck |
| <span className="st review">Human Review</span> | a PR is waiting for you | the dispatcher, after a passing review |
| <span className="st done">Done</span> | merged | your merge |

## Five rules worth remembering

1. **Only you move a task out of `Backlog` or `Question`.** Answer a question
   by replying on the issue, then move it to `Ready` (nothing built yet) or
   `Changes Requested` (a PR exists).
2. **Merging is what makes a task `Done`.** No agent merges or writes `Done`.
3. **`Changes Requested` is rework, not a restart.** The next developer adds
   commits to the existing PR, and it goes ahead of every `Ready` task.
4. **One task is one PR.** Steps inside a task are a checkbox list in the
   issue description; the developer ticks them as it goes.
5. **Order is priority, milestones are scope.** Reorder the board to change
   what happens next; the dispatcher only touches the milestones you named.

Two labels also steer a task: `Confirm with user` means "ask me before
starting", and `UI` marks design-sensitive work.

## Who is holding a task

- **The agent** shown in Linear's assignee field (the developer agent or the
  reviewer agent) says which phase the task is in.
- **The claim** is one comment on the issue naming the session working it
  right now, with a timestamp that is refreshed while the work runs:

  ```
  **[developer]** claimed 2026-08-27T14:05Z · `claude --resume <session-id>`
  ```

  If the timestamp stops moving for 90 minutes the session is presumed dead
  and the next dispatcher takes the task over. Paste the `claude --resume`
  command to open that session.

## Taking a task yourself

Assign the task to yourself in Linear and leave the agent empty: pick yourself
as the assignee and **No agent** as the agent. A task with a person assigned
and no agent is human-owned, and the dispatcher skips it in every state.

- **Do not take over a task an agent is on.** While its claim is fresh the
  dispatcher re-asserts the agent every round, so a hand-removed agent comes
  back. Take a task when its claim comment is gone or stale, or stop the loop
  first.
- **Your name alone is not the signal.** Delegating to an agent also puts the
  dispatcher's account in the assignee field, so an agent-held task can show
  your name too. Yours means your name **and no agent**.
- **Hand it back** by clearing yourself as assignee and moving it to `Ready`
  or `Changes Requested`. If your own PR merges, the task completes like any
  other.
- To have the loop check with you before an agent starts a task, use the
  `Confirm with user` label instead of assigning yourself.

That is everything you need to use the dispatcher. Setup is under [Get
started](../getting-started/get-started.md); the full rules are in the
[System breakdown](../ai/system.md#board-model).
