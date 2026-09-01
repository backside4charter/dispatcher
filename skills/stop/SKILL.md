---
name: stop
description: Shut the running task dispatcher loop down cleanly - end its /loop wakeups, stop the event waiter, drain (default) or abort (`now`) the in-flight workers, restore their board rows, release this session's claims, and report where everything stands. Use when the user asks to stop, pause, or shut down the task dispatcher. Must run in the session that is running the loop.
---

# Stop the Task Dispatcher

The dispatcher (`dispatcher:start`) is a `/loop` dynamic-mode loop that lives entirely in one session: its next firing is a ScheduleWakeup armed here, its immediate wakes are a background `dispatcher wait` task started here, and its workers are subagents of this session. Everything durable is on the board and on GitHub (issue state, claims, PRs, branches), which is what makes stopping safe: nothing is lost, and the next `dispatcher:start` resumes from the board. Stopping means undoing exactly the session-local things and leaving the board honest - no row at `In Progress` with nobody working it, no claim from a session that is gone.

Board access is `dispatcher board <command>`; states are written by role. (The project may wrap the binary - a just recipe, a script; its CLAUDE.md says how to invoke it, and the arguments are identical.) `<REF>` below is the platform's issue reference (`ACM-12` on Linear, `#480` on GitHub). Session id: the `CLAUDE_CODE_SESSION_ID` environment variable.

## Which session

Run this **in the dispatcher session**. ScheduleWakeup, background tasks, and subagents are all session-local; none of them can be reached from anywhere else.

- If this session has never run `dispatcher:start`, say so and do nothing else. Point the user at the right session: every claim on the board names it - a claim reads `<role>:<session-id>@<time>`, and `claude --resume <session-id>` reopens that session, where `/dispatcher:stop` works. `dispatcher board claims` lists the claims and their session ids.
- Never clear a **fresh** claim (younger than the configured staleness window, 90 minutes by default) that belongs to another session from here - that is another live dispatcher's worker, and its own loop releases it. Stale claims are the stranded-row scan's business on the next dispatcher, not this skill's. `dispatcher board release <REF> --session <this session id>` refuses to touch anyone else's claim, so use that form throughout.
- **Never kill the event listener** (`dispatcher listen`). The owner runs it in its own terminal and it serves every dispatcher session. Stopping a loop does not touch it.

## Two modes

- **Drain (default).** Stop taking new work, let the in-flight workers finish, process each result as it arrives exactly as the loop would, release its claim, and never re-arm. Nothing half-done reaches the board. A developer can take an hour, so say what is in flight and that this session has to stay open until the last completion notification has been handled.
- **Abort (`now`)** - the argument `now`, or the user saying "stop now" / "abort" / "kill the workers". Kill the in-flight workers with TaskStop and put their rows back. Use it only when the user asks for it: a killed developer's work survives (its branch and worktree stay; `dispatcher prune-worktrees` keeps anything uncommitted or unpushed), but finishing the task later costs a fresh worker from wherever the branch was left.

## Procedure

**1. End the loop first.** Call ScheduleWakeup with `stop: true`. This is the one step that must never be skipped: without it the next firing re-arms everything below. From here on, **never call ScheduleWakeup again in this session**, whatever notifications arrive.

**2. Stop the event waiter.** Find the running `dispatcher wait` background task (TaskList) and TaskStop it. With the loop ended its wake would be harmless, but a lingering waiter holds the channel's wait lock, so another session's waiter reads `already-waiting` and that dispatcher runs on its timer alone. Leave the listener alone (see above).

**3. Inventory what this session has in flight** - the workers still running (TaskList) and this session's claims on the board. Take the claims from the board, not from memory of what you spawned: the claim you forgot is exactly the one that strands a row for the whole staleness window.

```bash
dispatcher board claims          # own-claim rows are this session's; claim / stale-claim rows belong to others
```

Keep the rows marked **`own-claim`**. For each, note the role (`dev` / `review` / `cleanup`) and whether a worker is still running on it. A claim with no worker behind it (the worker died earlier, or a completion was never processed) is handled in step 5 right away, in either mode.

Also keep any **`queued`** row this session dispatched at. `queued` means a delegate with no claim comment, which is either a deliberate handoff (fine, leave it) or the half-written claim the write ordering produces: the delegate is written before the comment, so a failed comment write leaves an agent apparently holding a row with no session on it. If this session spawned a worker at such a row, treat it exactly like an `own-claim` row of that worker's role - `release --session` clears the delegate residue even though there is no claim to match, and says so.

**4. Handle the running workers.**

- *Drain:* leave them running. When each completion notification arrives, invoke the matching companion skill - `dispatcher:spawn-developer`, `dispatcher:spawn-reviewer`, or `dispatcher:spawn-cleaner` - and run its **completion** section (verify the PR and its link, check the checkbox list and reconcile any legacy sub-issues, `dispatcher prune-worktrees`, route the row, release the claim) **without** the loop steps: no top-up, no new spawn, no ScheduleWakeup, no waiter. After the last one, report (step 6) and end the turn. If the user changes their mind mid-drain, switch to abort for whatever is still running.
- *Abort:* TaskStop every worker of this session, then run `dispatcher prune-worktrees` (it keeps a worktree with uncommitted or unpushed work and prints why - report what it kept, because that is where a killed developer's unfinished work lives). Then restore each row per step 5.

**5. Restore rows and release claims** - for every claim of this session that no longer has a worker behind it. Check the PR state first, exactly as the completion sections do (`gh pr view <PR> --json state,isDraft` / `gh pr list --head task/<ref>-*`).

**The commands are per row, not one block applied to all of them.** Each row below names the exact pair to run; `release` clears the *delegate* as well as the claim, so running it on the `review` row would undo that row's whole point.

| The claim was | Put the row at | Then run |
| --- | --- | --- |
| `dev`, and no PR exists for the task | **`ready`** - never worked means a fresh branch next time. Mention the surviving branch or worktree in a comment so the next developer's prompt can carry it. | `dispatcher board state <REF> ready`<br>`dispatcher board release <REF> --session <session-id>` |
| `dev`, and an open PR exists (a resumed `Changes Requested` task, or the killed worker got as far as pushing one) | **`changes-requested`** - the next developer resumes that PR rather than branching afresh | `dispatcher board state <REF> changes-requested`<br>`dispatcher board release <REF> --session <session-id>` |
| `dev`, and the PR is `MERGED` | write nothing - the owner merged meanwhile and the board's merge automation already set `Done` | nothing at all; leave the delegate too |
| `review` | leave at **`In Progress`** - do not write a state | `dispatcher board assign <REF> reviewer` **and nothing else**. It re-asserts the reviewer delegate and drops the claim comment in one call. **Never `release` this row** |
| `cleanup` | the state it came from, which the dispatch recorded in the loop state; if that is lost, leave it where it is and say so - never promote | `dispatcher board state <REF> <the state it came from>`, then restore its delegate the same way: `dispatcher board assign <REF> <developer\|reviewer>` if it had one, `dispatcher board release <REF> --session <session-id>` if it did not |

That `review` row is the one case where releasing outright would lose information. `release` clears the delegate as well as the claim, and a row with neither reads as work nobody owes anything on: `In Progress`, undelegated and unclaimed is **developer tier 1**, so the next dispatcher would send a *developer* at a task whose code is finished and whose review is owed, and the review already earned would simply be forgotten.

`--session` is the guard against clearing a *different* live dispatcher's worker; a row carrying no claim at all asserts no session, so the same call still clears a delegate left behind on its own (see step 3) and reports that it did.

Leave the checkbox list in the issue description exactly as the killed worker left it - a ticked box records work that landed, and an unticked one is honest about what did not. On a legacy row, the **sub-issues** it had set to `In Progress` with nothing landed go back to `ready`; the ones it finished stay `Done`.

When a killed worker had made progress, comment it on the issue (`dispatcher board comment <REF> --as dispatcher --body-file <path>`: "dispatcher stopped mid-task on <date>; branch `task/<ref>-<slug>` has <what landed / what remains>") - a bare `Ready` row with a surprise branch behind it costs the next developer the context.

**6. Report.** One message that stands on its own:

- mode (drain / abort), and that the loop is ended (ScheduleWakeup stopped, waiter stopped);
- workers: finished, killed, or still draining - with issue identifiers, and for a drain, that the session must stay open until they report;
- claims released and rows restored (`ACM-12: In Progress -> Ready`, ...), legacy sub-issues touched, comments left;
- worktrees pruned and kept (from `dispatcher prune-worktrees`);
- PRs at `Human Review` waiting on the owner (`gh pr list --state open`), so they know what is theirs to merge;
- what `dispatcher:start <milestones>` will pick up when it restarts.

When the stop was not the user's direct request (a fatal error, an unrecoverable board state), send a one-line PushNotification with the outcome **before** the shutdown - the user may be away.

## Hard rules

- Stopping changes nothing about the standing prohibitions: never merge, never set `Done` on a top-level task, never close an issue, never create one (sub-issues included).
- Never clear another session's fresh claim, and never kill the listener.
- Leave the board honest: no row at `In Progress` without a worker and a claim behind it, and no claim from this session once you are done.
- Nothing is re-armed after step 1. A stray notification that wakes this session later is processed per step 4 and the turn ends without scheduling anything.
