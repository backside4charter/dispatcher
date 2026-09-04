---
title: Run the loop
description: Start the dispatcher, read its status, do your part, and stop it.
---

# Run the loop

## Start it

Open Claude Code at the repository root, ideally on a strong model at low
effort (the agents pin their own models):

```sh
claude --model opus --effort low
```

```
/dispatcher:start v1.1.0
```

Name one or more milestones; that is the only thing the loop will touch.
Without one it lists the board's milestones and asks. Optional, in another
terminal: `dispatcher listen` lets board and PR changes wake the loop within
seconds instead of at its timer ([setup](../setup/event-channel.md)).

## What you will see

- **On the board:** a dispatched task moves to `In Progress` with the
  developer agent shown as its agent and one claim comment on the issue.
  When the developer finishes, the agent flips to the reviewer; when the
  review passes, the task lands in `Human Review` with no agent.
- **In the session:** one line of status per round saying whether it is
  busy, out of work, or waiting on you, plus anything that needs you: a
  question, a task it skipped, follow-up work an agent noticed.
- **On GitHub:** branches named `task/<id>-<slug>`, PRs opened by the
  developer app, a comment-only review from the reviewer app.

## What you do

- Move tasks from `Backlog` to `Ready`, and reorder the board; the top is
  worked first.
- Review the PRs at `Human Review`. Merge, or request changes on the PR; the
  task goes back to the developer with your review word for word.
- Answer questions: reply on the issue, then move the task to `Ready` or
  `Changes Requested`.
- Put `Confirm with user` on anything you want a word about before it
  starts.
- Take a task yourself by assigning yourself with no agent
  ([details](../concepts/the-board.md#taking-a-task-yourself)).

## Stop it

```
/dispatcher:stop        # finish what is running, take no new work
/dispatcher:stop now    # stop the running agents and put their tasks back
```

Run it in the same session. Nothing is lost either way: the next
`/dispatcher:start` resumes from the board. A session that dies without
stopping leaves claims behind; they expire after 90 minutes and the next
dispatcher takes them over.
