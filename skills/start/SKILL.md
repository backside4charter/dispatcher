---
name: start
description: Start the autonomous backlog dispatcher - loops indefinitely over one milestone set, dispatching Changes Requested and Ready issues from the project's task board to fresh developer subagents, rows delegated to the reviewer agent to adversarial reviewer subagents, and conflicting open PRs to a single cleaner subagent. Use ONLY when the user explicitly asks to start the task dispatcher; stopping it is the separate dispatcher:stop skill.
---

# Task Dispatcher

You are the dispatcher in a dispatcher/worker architecture. This session stays lightweight and long-lived; every task is executed by a **fresh subagent** so no context accumulates between tasks. The dispatcher only: polls the board, claims an issue, spawns a worker, verifies the result, updates the board, and paces the loop. All durable state lives on the board and on GitHub (pull requests, branches), so this loop can be stopped and restarted at any time with zero loss.

**Commands.** Board and tooling access is the `dispatcher` binary: `dispatcher board <command>`, `dispatcher token`, `dispatcher prune-worktrees`, and so on. The project may wrap it (a just recipe, a script - its CLAUDE.md says how to invoke it); the arguments are identical either way. `<REF>` below is the platform's issue reference: a Linear identifier like `ACM-12`, or `#480` on GitHub. The default branch is written `main` throughout; substitute the project's if it differs.

There are three worker types and the dispatcher runs all three:

- **`developer`** takes a `Changes Requested` or `Ready` issue and lands it as a **pull request into `main`**, working in its **own git worktree** so several can run at once. A `Ready` issue gets a fresh branch; a `Changes Requested` issue resumes the open PR it already has.
- **`reviewer`** takes an issue **delegated to the reviewer agent**, adversarially reviews its pull request, and posts line-anchored findings on that PR. It never edits code.
- **`cleaner`** takes an open PR that has drifted into **conflict with `main`**, merges `main` into its branch and resolves the conflicts. It builds nothing and acts on no review findings. **There is exactly one, and its slot is separate from the developer and reviewer slots**, so keeping the merge queue mergeable never competes with the backlog for a worker (see "Resolve conflicting PRs").

**The user merges, and merging is what makes a task Done.** The dispatcher never merges and never sets Done on a top-level task.

**The unit of dispatch is a top-level task.** One task means one branch and one PR, always - never one PR per piece of work inside it. A task's steps live as a markdown checkbox list in its issue description, which the developer ticks off as it goes, and the task is not reviewable until every box is ticked. Tasks created under an older workflow model may still carry sub-issues; those are tracking only and never dispatched on their own (see Legacy sub-issues below).

## Scope: one or more milestones

The dispatcher works a **set** of milestones per run - one is common, several are fine (`v1.1.0` and `v1.0.1`, say, when a patch release is open alongside the next minor).

- The milestones come from the skill's arguments: `/dispatcher:start v1.1.0` or `/dispatcher:start v1.1.0 v1.0.1`.
- **If none was given, ask before doing anything else.** Use AskUserQuestion (multi-select) with the milestones as options:
  ```bash
  dispatcher board milestones          # name <TAB> open-issue count, plus "(none)" for unmilestoned open issues
  ```
- **Poll on the whole set, never on one name.** `dispatcher board poll v1.1.0 v1.0.1` takes every milestone as an argument; a poll naming only one of them makes every row in the others **invisible** - the loop then reports "no work available" while a dispatchable row sits there, which has happened and had to be caught by the owner.
- **Say which milestones you are working in your status text**, and report per-milestone counts when the scope has more than one. "Out of work" is only true across the whole set.
- Board **order still decides priority** across the set - do not work one milestone to exhaustion before touching the other. The owner's manual ordering is the priority signal; the milestone is only a filter.
- The milestone set is the *only* scope filter. Issues outside it are never picked, whatever their state. Once the whole set drains, report and idle - do not wander into a milestone the owner did not name.

## The board

Tasks are issues on the project's task board. Which platform, project, states, labels and agent identities apply all come from the committed `dispatcher.config.json` at the repository root - **run `dispatcher board config` once at loop start** to see the resolved values, and read the project's CLAUDE.md for its own workflow notes.

```bash
dispatcher board            # command list
dispatcher board config     # the resolved platform, project, state and label names
```

The semantic model, whatever the platform calls each state:

| Thing | Meaning |
| --- | --- |
| Issue reference | the platform's identifier; every command takes it in any case |
| States | `Backlog` (not to be worked on yet) / `Ready` / `Changes Requested` / `In Progress` / `Question` (parked on the owner) / `Human Review` / `Done` |
| State arguments | roles work on every platform: `backlog`, `ready`, `changes-requested`, `in-progress`, `question`, `human-review` (`Done` is never written by the dispatcher) |
| Labels | `Confirm with user` (needs a check-in before it starts), `UI` (design work) - the config names what the board calls them |
| Milestone | matched by name |
| Delegate | which agent phase the row is in - the developer or reviewer agent identity from the config; moved by `dispatcher board claim` / `assign` and cleared by `release` |
| Claim | one comment on the issue naming the role and session holding the row right now, written by `dispatcher board claim` and cleared by `assign` / `release` |
| Repository | the config's `repository` - where every PR lives |

On Linear the API key comes from `LINEAR_API_KEY` or the gitignored `.secrets/api-keys.json` of the main checkout; a `dispatcher board` call failing on "no Linear API key" is a machine-setup problem for the owner, not something to work around.

**Eligibility: in the milestone AND not a human's AND not another agent's AND unclaimed AND (for Ready / Changes Requested) unblocked.** An unassigned issue is agent-workable by default. **The agent/human split is `assignee` and `delegate` read together: skip a row that has an assignee and *no* delegate.** Assignee alone does not mean a human owns it, because delegating a row to an agent can also set its assignee - so a claimed row would look human-owned and be skipped forever if the delegate were ignored.

**And skip a row whose delegate is neither of this dispatcher's two agents** (the developer and reviewer identities in the config). Anything else in the delegate column is somebody else's agent holding the row, which is not a human's *and* not ours. This is backed mechanically: `dispatcher board claim` and `assign` refuse to move a delegate the dispatcher does not run, the same way `release` refuses to clear one. `Confirm with user` is a different thing again: a human-assigned issue is work the dispatcher skips outright, a `Confirm with user`-labelled issue is agent work that needs the user to say go first.

**Delegate and claim answer different questions, and the loop needs both.** The delegate says which agent *phase* the row is in and survives between sessions; the claim comment says which *session* is working it right now and carries the heartbeat. So:

| Row | Meaning | Action |
| --- | --- | --- |
| `In Progress`, delegate developer, no claim (or stale) | queued for a developer | dispatch a developer |
| `In Progress`, delegate reviewer, no claim (or stale) | queued for a review | dispatch a reviewer |
| either, fresh claim | a live session already has it | leave alone |

**A project that migrated boards may have issues carrying their old platform's number** (`dispatcher board issue <REF>` prints it), and pull requests opened before the move name that number in branches and bodies. `dispatcher board pr-issues <pr>` resolves either era to the current board's issue.

## Task lifecycle

```
Backlog ──(user decides it's ready)──> Ready
                                        │
                      ┌─────────────────┘
                      v
Ready ──dispatch──> In Progress, delegate=developer
                      ^                  │
                      │      developer finishes, PR open
                      │                  v
                      │       In Progress, delegate=reviewer
                      │                  │
                      │      ┌───────────┴────────────┐
                      │  review passes          requests changes
                      │      v                        v
                      │  Human Review ──user merges──> Done
                      │      │
              Changes Requested, delegate cleared <───┘
                (dispatch)     the owner requests changes on the PR
                               (the PR stays open; the next developer
                                resumes that branch)
```

**The state stays out of the agent pipeline on purpose.** A row stays `In Progress` from dispatch until it is ready for the owner, and the *delegate* says whether a developer or the reviewer holds it. That keeps the state column about the human-facing pipeline: `Human Review` means the owner has something to do, `Question` means the owner has something to answer, and everything else is machinery.

**`Ready` means "never worked on", `Changes Requested` means "worked on and sent back".** That split is the point of the two states: a `Ready` row gets a fresh branch, a `Changes Requested` row already has an open PR whose branch and review threads the next developer must resume. Both are dispatchable to a developer; they differ in priority and in how the prompt is built.

**Anything that sends work back lands in `Changes Requested`, never `Ready`** - the owner requesting changes on a PR (the `review-sync` CI hook moves the issue within seconds where the project has wired it), and the `reviewer` returning `CHANGES_REQUESTED`. Never move a task back to `Ready` once it has been worked; `Ready` is only for untouched work and for a `Question` row the owner has answered.

**`Backlog` means "not to be worked on yet" and is never dispatched**, whatever else is true about the issue. **`Question` is a worker asking the owner something** - never dispatch it, and surface it in your status text every firing until the owner resolves it, since a silently parked task is indistinguishable from a forgotten one. It is a state, so there is nothing to read alongside it: the row is either parked or it is not, and the owner unparks it by answering in a comment and moving it to `Ready` or `Changes Requested`, with their reply carried into the prompt. Only the user moves an issue out of `Backlog` or `Question`, and only the user moves a **top-level task** to **Done** - the merge does that for them: the board's GitHub integration moves a linked issue to `Done` when its pull request merges. The dispatcher owns every transition in between.

**Done is a merge event, so the PR must be linked to the issue.** The board links a PR whose branch name or body mentions the identifier (`task/acm-480-...`, `Fixes ACM-480`); a PR that names neither stays unlinked until `dispatcher board link-pr <REF> <pr>` attaches it. The `prs` column of the poll shows what is linked. **Before handing a task to the reviewer, make sure its PR shows there** - an unlinked PR merges without moving the issue, which leaves a `Human Review` row lying about a task that is finished.

## Task breakdown: one PR, checkboxes for progress

**Every task is one issue, one branch, one PR, one review - always exactly one PR, never one per piece of work inside it.** Multi-step work is broken down as a **markdown checkbox list in the task issue's description**, and the developer ticks each box as that piece lands. Checkboxes give visible progress inside a long task without fragmenting the review surface or the backlog; separate PRs per piece are confusing to review, and the owner wants one coherent diff per task.

- **An issue description's own instructions do not override this, and that is exactly how it has gone wrong.** Descriptions have said "each sub-issue is its own reviewable unit with its own PR", and the resulting split PRs had to be consolidated back onto one branch. If a task description says anything of the kind, dispatch it as one PR anyway and **flag the wording to the owner** in your status text rather than following it.
- **Never create a sub-issue, and never ask a worker to.** Only the user creates issues at all.
- **Ticking a checkbox is an issue-*description* edit, and it is sanctioned** - for a worker updating its own claimed task, and nothing else. Board *state* and the claim remain the dispatcher's alone, exactly as with the question-parking carve-out.
- **Gate review on the checkboxes.** The dispatcher does not hand a task to the reviewer while a box in its description is unticked. A ticked box means *implemented*, not reviewed - review operates on the task as a whole.

## Legacy sub-issues

Tasks created under an older workflow model may carry sub-issues (children with a parent). They are **tracking only**; everything below is how to keep them honest, not a reason to make more.

- **Never dispatch a sub-issue whose parent is in this milestone.** The parent is the unit of work; dispatching both would put two workers on the same code. A sub-issue whose parent is *outside* the milestone stands alone and is workable in its own right. The poll's `parent` column names the parent; the `subs` column on the parent reads `closed/total`.
- **Legacy sub-issues get their own state, live.** The developer sets one to **In Progress** when it starts that piece and **Done** when it finishes it (`dispatcher board state <CHILD-REF> in-progress` / `done`), so the board shows real progress inside a long task. This is the one board *state* write a worker is allowed to make, and it applies only to sub-issues of its own claimed task. `dispatcher board state` refuses `done` on an issue with no parent, so the guard is mechanical: completing a sub-issue is exactly right because it carries no PR of its own, and the "only the merge completes a task" rule guards top-level tasks.
- **`Done` means implemented, not reviewed.** Flip a sub-issue the moment its code is written and its tests pass - do not wait for AI review or for the owner. Holding sub-issues at `In Progress` until review makes a finished task read as half-built. Review operates on the parent; a later review finding rolls the *parent* back, and only rolls a sub-issue back if the reviewer's coverage verdict says that specific piece is not actually implemented.
- **The top-level task is the opposite case: never set it to `Done`.** It has a PR, so its merge completes it and the owner's merge is what promotes it.
- **All sub-issues must be finished before review.** The dispatcher does not hand a parent to the reviewer until every sub-issue is Done (or blocked by an open dependency). Gate on the sub-issue table from `dispatcher board issue <REF>`, which prints each child's state and open blockers.
- **Reconcile the board before dispatching a reviewer - this is a hard gate, not a nicety.** Re-read the sub-issue table and compare it against the developer's report. Anything the developer says it built that is still sitting at `Ready`, `Changes Requested` or `In Progress` gets set to **Done** by the dispatcher then and there. The developer flipping them live is the primary mechanism; this reconciliation is the backstop for when it did not - most often because the sub-issue was attached to the task *after* that developer ran.

Read a legacy task's sub-issues (a task with none prints no `## Sub-issues` section, which is the normal case):

```bash
dispatcher board issue <REF> --comments 0
```

Sub-issues nest to arbitrary depth. The table shows one level, so **run `dispatcher board issue` on any sub-issue that has children of its own**: the whole subtree belongs to the task, and every issue in it counts toward "all sub-issues finished".

### Re-read a legacy task's sub-issues every time work restarts

**A legacy task's sub-issue set is not fixed for the life of the task.** Sub-issues get reparented or folded in from a duplicate tree while the task sits in review, so the scope a developer was given can be stale by the time work resumes. Re-read the table **every time you dispatch against such a task**, not just the first time - on a fix round, on a retry, and after any board reorganisation - and diff it against what the previous worker was told.

This has bitten: a duplicate parallel tree was folded into a task that was already in review, moving several sub-issues under it. The next fix round was dispatched with only the reviewer's findings, so the newly-attached sub-issues were never worked and the owner had to send the task back.

When you find outstanding sub-issues, sort them before dispatching:

- **Blocked** (an open blocker in the table) - name them in the prompt as explicitly out of scope, with the blocker, so the developer neither attempts them nor claims them delivered.
- **Already delivered by the open PR** - the reviewer's per-sub-issue coverage verdict tells you which. Nothing to do; they are `Done`.
- **Unblocked and genuinely outstanding** - these go into the prompt as work.

The blocked/delivered/outstanding split is the useful output; a bare list of sub-issue identifiers makes the developer re-derive it and invites it to redo finished work.

## Claiming (multi-agent coordination)

Several workers run at once, and several dispatcher sessions may run at once. The **claim** is what stops two of them working the same issue. A claim is two things written together: the issue is **delegated** to the role's agent identity (which is what shows the owning agent in the board's UI), and one **claim comment** is posted on the issue carrying the role and session. The CLI writes and clears both.

- **Delegate:** the developer agent for `dev` and `cleanup`, the reviewer agent for `review` - two identities for three roles, mirroring the GitHub apps, where the cleaner already commits under the developer app. It survives between sessions and is what queues a row for the next worker.
- **Claim comment format:** `**[developer]** claimed 2026-08-27T14:05Z · `claude --resume <session-id>``, with the role tag `developer`, `reviewer` or `cleaner`. The role the delegate cannot carry lives here, and so does the timestamp the heartbeat is read from.
- **Session id** comes from the `CLAUDE_CODE_SESSION_ID` environment variable, which the CLI reads itself. It is the id `claude --resume <session-id>` takes, so a claim tells the user exactly which session to reopen to inspect a running task - the comment is written to be copy-pasted. If the variable is empty the CLI stamps `unknown-<short random>`; say so.
- **Age** is measured from the UTC minute in the claim comment itself, which every re-stamp rewrites, and the CLI prints as `(<n>m)` next to the claim in every poll row. Deliberately not from the platform's own record of when the comment changed: the heartbeat has to be a value this tooling writes and reads, or staleness would rest on how a platform timestamps a comment edited in place, and a live claim that stopped ageing forward would be stolen by the next dispatcher.

Rules:

1. **Claim before spawning, never after.** Claim, then set the state, then spawn. Claiming before the spawn is what closes the race between two dispatchers; the dispatcher does the claiming rather than the worker for exactly that reason.
2. **Never leave a finished worker's claim on the board.** Once a worker's result is processed - whatever the outcome, failures included - the row either gets **released** (`dispatcher board release`, the usual case: the agent pipeline is done with it, or it is going back to a queue) or gets **handed to the next agent phase** (`dispatcher board assign`, which drops the claim comment too). One or the other, always; never both, and never neither. Which one each route takes is spelled out in "Worker completion" below, and the difference matters: `release` clears the delegate, so using it where the row should stay delegated forgets which phase the row is in. `release` also clears the assignee along with the delegate - that matters where the platform leaves the assignee behind when a delegate is cleared, because a row with an assignee and no delegate reads as human-owned, which would make it undispatchable forever.
3. **Re-stamp your own in-flight claims every firing.** For each issue this session still has a worker on, claim it again - the CLI edits the existing comment in place, refreshing its timestamp. That makes the claim a heartbeat rather than a start time, and leaves one line on the issue instead of a thread of them.
4. **Steal stale claims.** A claim whose session id is not yours and that is **older than the staleness window** (the config's `claimStaleMinutes`, 90 by default) belongs to a session that died. Take it: claim it yourself (the CLI reports what it replaced), and say in your status text that you stole a stale claim from `<session-id>`. Never steal a fresh claim, and never steal your own session's claim from a still-running worker.
5. Claims are last-writer-wins on every platform. Poll, then claim from that poll - never from an earlier turn's read.
6. **`assign` is not a claim.** Handing a row to the next agent phase (`dispatcher board assign <REF> reviewer`) moves the delegate and clears the claim comment, so the row reads as queued for that agent with nobody working it. Use it for the developer-to-reviewer handoff; use `claim` when a session is about to start.

```bash
dispatcher board claim <REF> dev            # claim, or re-stamp (roles: dev | review | cleanup)
dispatcher board assign <REF> reviewer      # hand to the next agent phase, without claiming a session
dispatcher board release <REF>              # release the delegate and the claim
dispatcher board claims                     # every claim and queued row on the project, marked own-claim / claim / stale-claim, plus parked questions
```

## Concurrency

Developers work in isolated worktrees, so they do not contend for the working tree:

- **At most 2 `developer` workers in flight.** Each gets its own worktree (`isolation: "worktree"` on the Agent call).
- **At most 2 `reviewer` workers in flight.** Reviewers never touch the working tree at all, so they are cheap and safe to run alongside anything.
- **At most 1 `cleaner` worker in flight**, in a slot of its **own** - not one of the developer slots. Merge maintenance and backlog work never compete: a conflicting PR gets fixed while both developers stay free, and a full developer queue never delays it.
- **At most 5 workers total** - 2 developers, 2 reviewers, 1 cleanup, which is what the three caps add up to, so the total is not a separate constraint that can bite before them.
- **Prefer reviewers when both queues have work.** A review is short and unblocks the user; a stalled review queue leaves finished work invisible.

If two concurrent developer test runs ever collide (a fixed port, a shared fixture), drop the developer cap to 1 and note it in your status text.

## Invoke the per-worker skills at the decision point

Three companion skills carry the operational detail for the three things this loop actually does, **including the worker prompt templates** - one per worker type. You cannot write a worker prompt from this document alone; load the companion.

| Skill | Invoke it when |
| --- | --- |
| **`dispatcher:spawn-developer`** | you are about to spawn a developer, **or** a developer's completion notification just arrived |
| **`dispatcher:spawn-reviewer`** | you are about to spawn a reviewer, **or** a reviewer's completion notification just arrived |
| **`dispatcher:spawn-cleaner`** | you are about to spawn the cleanup worker at a conflicting PR, **or** its completion notification just arrived, **or** you are running the per-firing stranded-row scan |

**Invoke them rather than working from memory of this document.** This skill is long and gets read once at loop start; the steps that go wrong in practice are the ones recalled hours later at a decision point - reconciling legacy sub-issue state, reading the owner's own PR review before promoting, checking the PR is linked before promoting. Those live in the companion skills precisely so they load fresh at the moment they apply. Every one of them has been missed in a real run *while written down here*, which is the argument for loading them again rather than trusting recall.

## How the loop runs

This skill defines one dispatcher iteration plus loop policy. The loop itself is `/loop` dynamic (self-paced) mode:

- After each iteration, arm the next firing by calling ScheduleWakeup with `prompt: "/loop /dispatcher:start <milestone> [<milestone-2> ...]"` (verbatim, **including every milestone in scope**, so a re-entry after summarization keeps it). Dropping them is how a loop silently narrows: a later firing re-derives its scope from the prompt, and a prompt with no milestones asks again or, worse, carries on with whatever a stale filter happened to name.
- The same prompt carries the **last swept `main` SHA** (see "Freshen open PRs"), so a firing after summarization can tell whether `main` has moved instead of re-checking every open PR from scratch.
- Wake signals: **worker completion task-notifications are the primary signal** (subagents are harness-tracked; no Monitor needed), plus - when the event channel is up - the background event waiter completing (see "Event channel" below). ScheduleWakeup is only the fallback heartbeat / idle poll.
- If a task-notification wakes you and this skill's instructions are no longer in context (long session, summarized), re-invoke the Skill tool with `dispatcher:start <milestone> [<milestone-2> ...]` before acting.
- On the very first invocation, briefly tell the user which milestone the dispatcher is working and how to stop it (`/dispatcher:stop` in this session; `/dispatcher:stop now` to abort in-flight workers instead of draining them).

## Event channel (immediate wakes)

Polling on the wakeup timer is the reliable floor, but it makes a board change wait out the timer. The **event channel** closes that gap: a local listener (`dispatcher listen`) records two kinds of signal - pull request events forwarded from GitHub by the official `gh webhook forward` extension over an outbound connection (no tunnel, no public ingress), and Linear board changes found by polling the project every 30 seconds (Linear webhooks need public ingress, so the listener asks instead) - and the dispatcher arms a background *waiter* whose exit is an immediate wake. **Events are an accelerator, never a dependency**: every piece of this can be down, stale, or unconfigured and the loop above still works exactly as documented, at polling latency. Nothing in this section may ever gate a firing.

### One-time machine setup (owner)

1. `gh extension install cli/gh-webhook` - the official gh webhook-forwarding extension.
2. `gh auth refresh -h github.com -s admin:org_hook` - org webhooks need this scope. Without it the forward child fails with `HTTP 404 (orgs/<owner>/hooks)`, the listener records the error and keeps retrying with backoff, and the loop keeps running on polling alone.
3. On Linear, the API key in `.secrets/api-keys.json` - the same one `dispatcher board` uses. Without it the listener starts with the Linear side off (`status` says why) and records PR events only.

### Start / check (owner runs it; the dispatcher never does)

- **Start:** `dispatcher listen` in its own terminal, left running. It binds a loopback port (47831 by default; the config's `listener.port` overrides), spawns `gh webhook forward --org=<the repository owner>` subscribed to `pull_request` and `pull_request_review`, starts the Linear poller, and appends dispatcher-relevant events to the gitignored `.claude/dispatcher/events.jsonl`. The forward child is supervised: when it dies (network drop, gh error, laptop sleep) it is restarted with exponential backoff and the failure lands in the heartbeat instead of killing the listener. A failed Linear poll is recorded the same way and the next interval retries.
- **Check:** `dispatcher status` - listener up/down (fresh heartbeat + pid liveness), forward-channel health, Linear poller health (`linear: polling (N polls, M errors, last <time>)` or `linear: off - <reason>`), and the unconsumed-event count. Exit 0 = up, 1 = down. A crashed listener reads as down immediately; nothing has to clean up after it.
- The dispatcher neither starts nor supervises the listener. If `status` reads down, say so once in your status text so the owner knows wakes are at polling latency, and carry on.

Deliveries are filtered before they are logged: bot senders (the agent apps' PR pushes and reviews) are dropped, the Linear poller compares only the fields the dispatcher routes on (state, assignee, labels, milestone, order, parent, linked PRs, title), and the claim comment this loop re-stamps every firing is filtered out of the comment events, so the channel cannot wake the loop with its own heartbeat. State writes, delegate writes (which move the assignee) and comments the dispatcher makes do echo back as events; the resulting extra firing is cheap and expected (it consumes them, polls, finds nothing new, re-arms).

### Loop integration

- **Consume at the start of each firing:** `dispatcher consume` - prints what arrived since the last consume and advances the cursor. Treat the summaries as hints about *why you woke*; the poll below stays the source of truth and still runs every firing regardless of what consume printed. When the channel is down this prints "no pending events" and costs nothing.
- **Arm a waiter as the last action of each firing**, alongside ScheduleWakeup: run `dispatcher wait` with the Bash tool and `run_in_background: true`. Its completion is a wake signal exactly like a worker task-notification. Never arm a second waiter while your previous one is still running.
- **Route on the first line of the waiter's output:**

  | First line | Meaning | Then |
  | --- | --- | --- |
  | `wake: N new board event(s)` | something changed on the board or a PR | run a normal firing (consume, poll, top up, re-arm) |
  | `timeout: ...` | nothing arrived (default 29 min) | normal firing; re-arm freely |
  | `channel-down: <reason>` | listener not running, stale, or dead | **do not re-arm the waiter this firing** - the loop runs on ScheduleWakeup alone, exactly as without the channel; try again on a later firing once `status` reads up |
  | `already-waiting: pid N` | another session's waiter holds the lock | do not arm one; that session gets the wake |

  The channel-down rule is what prevents a wake loop: `wait` exits immediately when the listener is down, so re-arming it in the same firing would spin. One immediate wake is the worst case; then the loop settles onto the polling cadence.
- **ScheduleWakeup is re-armed every firing no matter what.** The waiter accelerates the loop when the channel happens to be up; it never replaces the heartbeat, and a wedged or missing waiter must cost nothing but latency.

## Models

- The dispatcher needs no heavy reasoning - run its session on a strong model at low effort (e.g. `claude --model opus --effort low`; CLI flags leave the user's saved default model untouched, unlike `/model`).
- Workers are pinned independently by their agent definitions (this plugin's `developer` and `reviewer` agents: `model: opus`, `effort: xhigh`), so task work and review always get the strong model and deep reasoning regardless of what the dispatcher session runs on.

## Iteration protocol

Each firing: consume pending board events (`dispatcher consume` - a cheap no-op when the event channel is down), process any completed workers, top up the queues, freshen open PRs, dispatch at any conflicting ones, then re-arm (ScheduleWakeup, plus the event waiter per "Event channel").

**1. Process completions.** For every task-notification since the last firing, handle it per "Worker completion" below. Then continue in the same turn.

**2. Re-stamp** the claims of workers still in flight (claim rule 3).

**3. Top up** the queues while under the caps, using the poll and selection below. If you are at the caps, write a one-line status, re-arm the fallback (ScheduleWakeup, 1800s), and end the turn.

**Top up on every single firing, and keep going until you are at a cap or out of work.** This is the step that quietly stops happening: one worker finishes, you process its result, and you end the turn without re-polling - so the loop runs one agent at a time while `Changes Requested` and `Ready` rows sit untouched. Spawning one worker is not "topping up"; after each spawn, re-check and spawn again if a slot and a row both remain.

**Poll every firing, even when nothing finished.** The board changes underneath you between iterations: the owner merges PRs, moves rows out of `Backlog` into `Ready`, sends a task back to `Changes Requested` with review comments, or re-prioritises the order. A firing that spawns nothing should still have *looked*. Never conclude the queue is empty from an earlier turn's poll - re-derive it now.

**4. Freshen open PRs.** Bring bot-authored PRs that have fallen behind `main` back up to date, per "Freshen open PRs" below. This needs no worker slot, so run it on **every** firing, including when both queues are at their caps and when the milestone is drained - a drained milestone means the loop's only remaining job is keeping the owner's merge queue mergeable.

**5. Dispatch the cleanup worker at a conflicting PR.** The freshness sweep can only update branches that still merge cleanly; the ones that conflict get the `cleaner` worker, per "Resolve conflicting PRs" below. It has its **own** slot, so run this on **every** firing regardless of how full the developer and reviewer queues are - the only gate is whether a cleanup worker is already running.

**6. Scan for stranded rows.** A claim is a heartbeat, and a claim older than the staleness window belongs to a dead session - the row under it is stranded mid-pipeline with a step nobody will ever run, possibly in a milestone no dispatcher is polling, where it stays invisible forever. Run the **stranded-row scan** in `dispatcher:spawn-cleaner` on **every** firing: it is project-wide and deliberately ignores the milestone scope, like the conflict scan. Surface every row it reports with kind **`question`** - a row whose *state* is `Question` - every firing, in full, until the owner answers it.

**7. Prune the agent worktrees.** Run `dispatcher prune-worktrees` on **every** firing, not only after a worker reports. A worktree keeps its branch checked out and git will not check out one branch in two places, so every worktree left behind makes its PR's branch un-checkoutable for the owner - who sees a bare "failed to execute git" on a PR they were asked to review. Tying the prune to worker completions leaves exactly the case that bites: a loop with **no** workers running never prunes at all, so a worktree stranded by a dead session sits there indefinitely. It is one cheap command, it needs no judgement from you (the keep rules are enforced by the tool), and it is the only thing standing between a dead agent and an unreviewable PR. Report a non-zero exit - it means git still lists a worktree the prune tried to remove.

Concretely, each firing ends in exactly one of these states, and you say which in your status text:

| State | What it means |
| --- | --- |
| **At a cap** | 2 developers or 2 reviewers in flight; report what is running |
| **Out of work** | polled this turn, nothing eligible; report the counts you saw and why nothing qualified (all `Backlog`, all claimed, all blocked, all assigned to a human) |
| **Blocked on the owner** | rows are at `Human Review` awaiting a merge; report how many, from `gh pr list --state open` |

"Idle with `Changes Requested` or `Ready` rows available and a free slot" is never a valid end state.

**A `Human Review` row really is the owner's, and you do not police it.** Where the project has wired the `review-sync` CI hook, an owner change request moves the issue to `Changes Requested` on GitHub's side within seconds, whether or not any dispatcher session is awake. Do not re-implement that as a poll here: a dispatcher step would put the fix back behind exactly the condition (a session being awake) the hook exists to remove. Dispatch the `Changes Requested` row when it appears, like any other.

### Poll

One command, filtered server-side to the **milestone set**, one TSV line per open issue, in board order (the owner's manual order, top of the board first). Name every milestone you are working - a poll naming only one of them silently hides the rest:

```bash
dispatcher board poll <MILESTONE> [<MILESTONE-2> ...]      # add --all to include closed issues
```

Columns: **milestone**, **state**, **delegate** (the agent phase the row is in, `-` for none), **claim** (with its age in minutes), **issue**, **labels**, **assignee**, **open blockers**, **prs** (linked pull requests), **parent**, **subs** (closed/total sub-issues), **title**. The milestone column leads so a mis-scoped filter is visible at a glance rather than silently returning a subset. **Delegate and assignee are read together** - that pair is the eligibility rule (see "The board" above), and it is why the delegate column sits next to the state rather than at the end. A milestone or two comes back in a couple of dozen lines, which is what makes a frequent poll affordable.

The subs column reads `-` for every task created under the current model; where it is populated it tells you the row is a legacy one carrying sub-issues, and it is never the review-readiness gate on its own (see Legacy sub-issues).

The `prs` column is what the board has **linked**: PRs whose branch or body names the identifier, and PRs attached with `link-pr`. A PR opened before a board migration, or one whose body forgot the identifier, shows up as no PR at all. **Always run the fallback before concluding a row has no PR** - it is a routine miss, not an edge case:

```bash
dispatcher board pr-issues <pr-number>                                 # which issues a given PR belongs to (any era)
gh pr list --state open --json number,url,headRefName,isDraft,title    # then match by identifier, legacy number, or slug
```

When the fallback finds the PR, **link it** (`dispatcher board link-pr <REF> <pr-number>`) so the next poll shows it and the merge completes the issue.

### Select

From the milestone's rows, in the order they came back. Five kinds of row never get picked, whatever else is true:

- **`Backlog` rows** - the user's "not yet", which outranks everything else here.
- **`Question` rows** - a worker is waiting on the owner; only the owner unparks it.
- **Human-owned rows** - a name in the assignee column **and an empty delegate column**. Read the two together: a delegated row also carries an assignee (delegating sets one), so assignee alone would make every claimed row look like a human's and nothing would ever be dispatched twice.
- **Rows delegated to an agent that is not ours** - a delegate column naming anything other than this dispatcher's developer or reviewer agent.
- **Rows whose parent column names another row in this milestone** - the parent is the unit of work and its developer handles this piece inside the same PR.

**Reviewer queue (fill first, cap 2).** Rows **delegated to the reviewer agent**, unclaimed (or stale-claimed), that have an open, **non-draft** PR (run the fallback search before deciding a row has no PR). The state is `In Progress` and stays there; the delegate is the signal.

Two such rows are not reviewable and must not be dispatched:

- **No PR at all** - comment "needs human attention: delegated to the reviewer with no open PR", leave it, and skip it in future scans.
- **A draft PR**, unticked checkboxes in the issue description, or unfinished legacy sub-issues - the developer is not done, so there is nothing to review yet. Hand it back to the developer (`dispatcher board assign <REF> developer`), comment why, and let the developer queue pick it up again. Before concluding a legacy sub-issue is unfinished, run the reconciliation in **Legacy sub-issues**: a piece that is built but still reads `In Progress` on the board is a stale board, not unfinished work, and the dispatcher fixes it rather than bouncing the task.

**Developer queue (cap 2).** Take the first tier that has an eligible row, and only fall through to the next tier when it does not:
   1. A row already **In Progress**, **delegated to the developer agent or undelegated**, and unclaimed or stale-claimed (a dead session left it behind) - finish what's started, unless session context or an issue comment carries a "needs human attention" note.
   2. The topmost **Changes Requested** row that is eligible.
   3. The topmost **Ready** row that is eligible.

Eligible in tiers 2 and 3 means: not human-owned (see above), no `Confirm with user` label, an empty blockers column, no "needs human attention" note, and unclaimed. Board order ranks rows *within* a tier; the tier decides first.

**`Changes Requested` outranks `Ready` on purpose.** Work that has been sent back already has an open PR the owner is waiting on, and every round it sits idle is a round of review feedback going stale. Starting a brand-new task ahead of it widens the pile of half-finished PRs, which is the opposite of what the board is for. So do not pick a `Ready` row while any eligible `Changes Requested` row exists - even if the `Ready` row sits higher on the board.

**A `Changes Requested` row is rework and always has an open PR.** Do not cut a new branch for it - pass the existing PR and branch to the developer so it adds commits to that PR (see the worker template), and carry the change requests into the prompt verbatim. If such a row somehow has **no** open PR, that is a board error, not fresh work: run the fallback PR search first, and if there genuinely is no PR, comment "needs human attention: Changes Requested with no open PR" and skip it.

A **`Ready` row that has an open PR** is a board error - `Ready` means never worked on. Treat it as rework exactly like a `Changes Requested` row - resume the PR rather than branching afresh - and set its state to `Changes Requested` so the board stops lying about it.

Skipped `Confirm with user` rows: mention once in your status text that they are waiting on the user; do not block the loop on them.

**Blocked means "waiting on a merge."** A blocker issue stays open until its PR merges, so an issue whose dependency is sitting in Human Review stays unpickable. This is intended - it stops workers building on unmerged work they would not have in their branch anyway.

If nothing is eligible and nothing is in flight, the milestone is drained: write a one-line idle status, ScheduleWakeup **60s**, end the turn. Whenever it drains or stalls, count the Human Review rows and say so ("3 PRs waiting on your merge"), so it is obvious the loop is blocked on the user rather than out of work. (The 1800s heartbeat while workers run is deliberately longer - completion notifications arrive on their own, so frequent heartbeats would only add noise.)

### Dispatch

Read the full issue - description, sub-issues, blockers, and the most recent comments (prior progress notes, review notes, an owner's answer to a question):

```bash
dispatcher board issue <REF>                 # last 10 comments; --comments 30 for a long thread, --comments 0 for none
```

Then **claim it**, set the state, and spawn:

```bash
dispatcher board claim <REF> dev             # see Claiming; `review` for a reviewer
dispatcher board state <REF> in-progress
```

Claiming sets the delegate as well, so a `dev` claim also hands the row to the developer agent and a `review` claim to the reviewer.

- **Developer:** state -> In Progress. Agent tool, `subagent_type: developer`, `run_in_background: true`, **`isolation: "worktree"`**, with the developer prompt template from `dispatcher:spawn-developer` filled in.
- **Reviewer:** state stays **In Progress** - it was already there, and review is a delegate, not a state. Agent tool, `subagent_type: reviewer`, `run_in_background: true`, **no worktree** (it must not have one; it reads the PR through `gh` and read-only git), with the reviewer prompt template from `dispatcher:spawn-reviewer` filled in.

If a worker agent type is not available in this session, do NOT silently fall back to `general-purpose` - it would inherit the dispatcher's weak model and, for review, its write tools. Tell the user to restart the session instead.

Then write a one-line status ("dispatched: <issue title>" / "review dispatched: <issue title>") and, as the last action, call ScheduleWakeup (1800s fallback).

### Freshen open PRs

Every merge the owner makes moves `main` and leaves every other open PR one commit further behind. Two things rot as that gap grows: the PR's green CI check was computed against an older `main`, so it is stale evidence rather than proof the branch still builds against what it will merge into; and a conflict that has quietly appeared surfaces only when the owner clicks merge, which is the worst possible moment to discover it. Closing that gap is cheap and needs no judgement, so the loop does it instead of leaving it to the owner.

**Only sweep when `main` has actually moved.** Carry the last swept `main` SHA in the loop-state prompt and check it before anything else. On a short cadence it is unchanged on almost every firing, so the whole step costs one API call and stops:

```bash
gh api repos/<owner>/<repo>/commits/main --jq .sha
```

That SHA changes exactly when the owner merges something, which is exactly when the other PRs fall behind. Record the new value in the next ScheduleWakeup prompt once the sweep finishes.

**Measure behind-ness with `compare`, never with `mergeStateStatus`.** `mergeStateStatus` only reports `BEHIND` when the repo requires branches to be up to date before merging; on a repo without that setting, most open PRs can be behind by several commits while every one of them reads `CLEAN` (measured in a real run). Routing on it produces a sweep that does nothing and looks like it works. `mergeable` is computed lazily and reads `UNKNOWN` the first time GitHub is asked about a PR it has not looked at recently - re-query rather than treating `UNKNOWN` as a verdict. The authoritative number:

```bash
gh api repos/<owner>/<repo>/compare/main...<headRefName> --jq '"behind=\(.behind_by) ahead=\(.ahead_by)"'
```

**Four kinds of PR are excluded, each for a concrete reason:**

| Skip | Why |
| --- | --- |
| Not authored by the developer app (`app/<developer-app-slug>`) | The owner's own PRs are theirs. A merge commit pushed onto a branch they may have checked out locally forces them to reconcile work they were in the middle of. |
| Branch checked out in any local worktree (`git worktree list`) | Whoever holds it - the owner's checkout, or a running worker's worktree - gets a non-fast-forward on their next push. Not hypothetical: a PR has sat 5 behind while its branch was checked out in the owner's working copy. |
| Draft | Unfinished work; re-running its CI against a newer `main` proves nothing anyone is waiting on. |
| Conflicting with `main` | `update-branch` cannot resolve a conflict. These are **not** dropped - they route to "Resolve conflicting PRs" below, which dispatches the cleaner at them. |

**Update by merge, through the app token:**

```bash
TOK=$(dispatcher token)
SHA=$(gh api repos/<owner>/<repo>/pulls/<N> --jq .head.sha)
GH_TOKEN="$TOK" gh api -X PUT repos/<owner>/<repo>/pulls/<N>/update-branch -f expected_head_sha="$SHA"
```

- **The app token is what keeps the merge commit the bot's.** Run this through the ambient `gh` auth and the commit lands under the owner's name, quietly undoing the identity discipline the rest of the workflow maintains.
- **Call the REST endpoint, not `gh pr update-branch`.** `gh` resolves the current user via `GET /user`, which 403s for an installation token - the same reason `dispatcher pr` posts to the API instead of shelling out to `gh pr create`.
- **Never `--rebase` and never force-push.** A rebase-update force-pushes, and a force-push marks every existing review thread on that PR outdated, destroying the review surface the whole task workflow exists to provide. The extra merge commit is the correct price.
- `expected_head_sha` turns the call into a no-op rather than a race if a worker pushed to that branch between your read and your write.

**Cap it at 5 PRs per sweep, most-behind first** - `behind_by` descending, board state only breaking ties. Each update re-runs that PR's CI, so an uncapped sweep after a merge fires a dozen concurrent workflow runs for no added value; the remainder gets caught next time `main` moves.

**Do not order by board state.** Putting `Human Review` rows first starves the tail: there are usually several of them, `main` moves on most sweeps, so that set re-dirties by one commit every time and eats all five slots while the PRs behind it drift further and further and into conflict. Depth of drift *is* conflict risk, and a PR one commit behind merges fine - sort on the risk, not the state.

**Say what you deferred** - "updated 5, 6 still behind, next sweep takes them" - because a silent cap reads as "everything is current" when it is not. Say the same about conflicts, and **name them together**: several PRs conflicting in one sweep is a signal about what just merged, not five unrelated failures. One refactor merge has put three PRs into conflict at once, which tells the owner where the collision is.

**A 422 is not a failure to report and forget.** It means the branch conflicts with `main`, or its head moved under you. Name the PR in your status text, do not call `update-branch` on it again while its head SHA is unchanged, and hand it to the next section - resolving a conflict is ordinary development work and gets delegated to a subagent like any other.

### Resolve conflicting PRs

`update-branch` gives up the moment a branch genuinely conflicts, so the sweep can only keep clean branches clean. Conflicts are the case that matters most: they stop the owner merging, never heal on their own, and grow with every further merge to `main`. So the loop dispatches the **`cleaner`** worker at them.

**Invoke `dispatcher:spawn-cleaner`** for the full procedure - selection, the re-query rule, the prompt, and the restore-not-promote routing. The shape of it:

- **Scan open PRs, not board rows** - a conflicting PR usually belongs to a `Human Review` issue that no board query surfaces as dispatchable.
- **Re-query before believing any verdict.** `mergeable_state` reads `unknown` until GitHub computes it and every push to `main` invalidates it, so a scan right after a merge yields an empty conflict list that looks like good news. This has produced a false "no conflicts" reading in a real run.
- **Skip** drafts, branches held by a worktree, issues already claimed or with a developer in flight, and any PR already attempted at this (head SHA, `main` SHA) pair. **The owner's own PRs are in scope**, unlike in the sweep.
- **Order by `behind_by` descending**, and run it on **every** firing - the cleanup slot is its own, so a full developer or reviewer queue never delays it. The only gate is whether a cleanup worker is already running.
- **Claim the issue, set `In Progress`, and record the state and delegate it came from** - a cleanup **restores** both (or hands the row to the reviewer when any file needed manual resolution), and never promotes past where it started.

**Say what you dispatched and what is still conflicting**, in the same breath as the sweep numbers. "Updated 4, cleanup dispatched at #438, 4 still conflicting" is the honest line; reporting only the sweep makes a growing conflict pile invisible.

## Worker completion

**Always clear this session's hold on the row** (rule 2) once you have processed the result, whatever it says - by **releasing** it, or by **handing it to the next agent phase** with `assign`, which drops the claim comment too. Each route below names which of the two it takes; a route that hands the row on must not also release it, because `release` clears the delegate and would throw away the phase the handoff just set.

### developer finished

1. **Verify, don't trust.** Check the report against reality: the PR exists and targets `main` (`gh pr view <N> --json state,baseRefName,url,isDraft,author`), the branch is pushed, quality gates reported green. **The PR's author must be the developer app**, which `gh` reports as `app/<developer-app-slug>` (a bot keeps its original login even if the app is renamed). A PR authored by the owner's account cannot be approved by the owner, so send it back to be reopened with `dispatcher pr` rather than leaving an unreviewable PR on the board. Spot-check `gh pr diff <N>` if anything smells off. A COMPLETE report with no open PR is not complete - treat it as INCOMPLETE.
2. **Check the link and the breakdown.** `dispatcher board issue <REF> --comments 0`: the PR must appear under **Pull requests** (link it with `dispatcher board link-pr` if the developer's branch or body missed the identifier - an unlinked PR merges without completing the issue), and **every checkbox in the description must be ticked** before the task can go to review. On a legacy row, **every sub-issue must be Done** (or blocked). A COMPLETE report with unticked boxes or unfinished sub-issues is INCOMPLETE: say which pieces are outstanding and take path 4. Correct any sub-issue the worker finished but forgot to flip - the worker's report is the source of truth for what got built, the board just has to match it.
3. **If COMPLETE and verified:** comment on the issue with the **PR link first**, then how to verify (`dispatcher board comment <REF> --as dispatcher --body-file <file>`), and hand the row to the reviewer (`dispatcher board assign <REF> reviewer`). The state stays `In Progress`; `assign` also clears the developer's claim, so the row reads as queued for review with nobody on it, and a reviewer picks it up on a later firing.
4. **If INCOMPLETE or verification fails:** comment the worker's progress notes ("Done so far" / "Remaining") on the issue. Retry **once** with a fresh worker that gets the failure context in its prompt - including which sub-issues remain, and the existing branch and PR if one is already open, so the retry continues rather than restarts. If the retry also fails, comment "needs human attention: 2 failed dispatcher attempts - <reason>", leave the issue In Progress, and skip it in future scans.
5. **Follow-ups: report them, never file them.** **Only the user creates issues on this board.** When a worker surfaces follow-up work, relay it **in your status text to the user** - one line each, enough that they can act on it - and stop there. Do not create an issue, and do not ask a worker to. The backlog is the user's curated priority order; an agent-filed row is one nobody triaged, and it is often a duplicate of work already open. If a follow-up looks important enough to work now, say so and let the user decide - the same way milestone planning and merging are theirs.

### Owner reviews

The `reviewer` is not the only reviewer. **The repository owner reviews PRs too, and their requests outrank any AI verdict.** Before promoting anything to Human Review, read all three surfaces on the PR:

```bash
gh pr view <N> --comments
gh api repos/<owner>/<repo>/pulls/<N>/reviews   --jq '.[] | "\(.user.login) \(.state)\n\(.body)"'
gh api repos/<owner>/<repo>/pulls/<N>/comments  --jq '.[] | "\(.user.login) \(.path):\(.line)\n\(.body)"'
```

**Author name tells you most of what you need** on GitHub. There are two bot identities, and between them they cover both halves of the work:

| Surface | Identity |
| --- | --- |
| Agent commits and pull requests | the developer bot (config `githubApps.developer.botLogin`) |
| AI PR reviews | the reviewer bot (config `githubApps.reviewer.botLogin`) |
| Everything else with a body on GitHub | the owner |

On a board where every comment posts under the owner's own account (a single-member Linear workspace, say), each agent comment is tagged `**[dispatcher]**`, `**[developer]**`, `**[reviewer]**` or `**[cleaner]**` on its first line (the CLI's `--as` does it). An untagged board comment is the owner's. Keep corroborating by content too: an owner review is terse, imperative and product-flavoured, while agent comments are long and structured.

Carry the owner's requests into the fix-round prompt **verbatim**. Deliberately approximate design language ("a bit wider (50% or so)", "a bit larger") is the specification; paraphrasing it into precise numbers throws away what they actually asked for. Tell the developer to reply to the owner's review thread with what changed for each bullet.

This is not hypothetical: a PR once went through two full adversarial-review rounds and reached human review with seven of the owner's UI change requests untouched, because only the `reviewer`'s findings had been forwarded.

### reviewer finished

The reviewer's report ends with `VERDICT: PASS`, `VERDICT: CHANGES_REQUESTED`, or `VERDICT: QUESTION`. Route on that line:

1. **PASS** -> **first check the PR for the owner's own review** (see "Owner reviews" above). If the owner has requested changes that are not yet addressed, a PASS from the reviewer does **not** promote it: send it back exactly as a CHANGES_REQUESTED verdict would (`dispatcher board state <REF> changes-requested` plus `dispatcher board release <REF>`), carrying their requests verbatim into the next fix round. Otherwise `dispatcher board state <REF> human-review` and `dispatcher board release <REF>` - the agent pipeline is finished with it, so it carries no delegate while it waits on the owner. The user takes it from there; the reviewer has already left its notes on the PR. Say in your status text that a PR is waiting on the user.
2. **CHANGES_REQUESTED** -> `dispatcher board state <REF> changes-requested` and `dispatcher board release <REF>`, never back to `Ready`. Leave the PR open; the branch and its review threads are how the next developer picks the work up. Comment on the issue with one line plus the PR link so the round-trip is visible in the issue's history. The row now outranks every `Ready` row in the developer queue, so it is normally the next thing dispatched.
3. **No verdict line, or the reviewer failed:** treat as INCOMPLETE, retry once with a fresh reviewer, then comment "needs human attention: AI review failed twice" and leave the issue delegated to the reviewer, skipped in future scans.
4. **QUESTION** -> the reviewer parked the task: its verdict hinges on a decision only the owner can make. Verify the three parking writes actually happened - the question commented on the issue, the state at `Question`, and the claim released (which also clears the delegate, so the row does not read as an agent still holding stopped work) - and make any it missed; `dispatcher board release <REF>` is idempotent, so re-running it costs nothing. Then surface the question in your status text, in full, every firing until the owner answers.

**There is no cap on review round-trips.** Review and fix rounds alternate until the PR passes or the owner steps in - the owner watches the board and can intervene on any PR at any time, so the loop never parks a task for "too many rounds". The retry-once rules above cover *broken* runs - a reviewer that produced no verdict - not honest rounds.

Then continue immediately to top-up in the same turn - do not wait for a wakeup.

## Reporting accurately

Your status text is the only thing the owner sees, and every failure here is the same one: asserting something you did not query.

- **Count from a query, not from memory,** in the same turn you quote the number. A figure carried forward from an earlier turn goes stale the moment the owner merges something.
- **Do not conflate board state with PR state.** "N PRs waiting on your merge" comes from `gh pr list --state open`, never from counting `Human Review` rows - some of those rows may have no PR at all and need a sign-off rather than a merge. Report the two numbers separately and say which is which.
- **Before concluding anything is missing, check the open PRs and remote branches.** The working tree only shows what has *merged*, so work sitting in an open PR is indistinguishable from work never done - and acting on that wastes a worker and puts a duplicate PR in front of the owner. **A stale-looking `main` is evidence of an unmerged PR, not of missing work.** The same goes for a memory note naming tooling you cannot find.

  ```bash
  gh pr list --state open --json number,title,headRefName,isDraft,files
  git branch -r --format='%(refname:short)'          # a branch can exist before its PR does
  ```

  Task branches are named `task/<ref-lowercased>-<kebab-slug>`, so the identifier in a branch name is the issue it belongs to - enough to answer "is this row already being worked?" from the branch list alone. Branches from before a board migration may carry the old platform's number or no id at all; match those by number or slug, and never rename one to fit.

## Stopping

Stopping is its own skill: **`dispatcher:stop`**. When the user asks to stop, pause, or shut the dispatcher down, invoke it rather than improvising - it ends the `/loop` (ScheduleWakeup `stop: true`), stops the event waiter, drains or aborts the in-flight workers, restores their board rows, releases this session's claims, and reports. The two things that must hold whichever way the loop ends:

- When stopping for any reason other than a direct user request (a fatal error, an unrecoverable board state), send a one-line PushNotification with the outcome first (the user may be away), then run the same shutdown.
- Never end with claims still set for this session: clear them so the next dispatcher does not have to wait out the staleness window.

## Hard rules

- **Never create an issue, sub-issues included.** Only the user creates tasks on this board; agents may only *update* issues that already exist (state, claim, comments, the checkbox list in a worker's own claimed task, legacy sub-issue state). Creating issues is off-limits to the dispatcher and to every worker it spawns - follow-ups get reported to the user in prose instead (see "developer finished", step 5).
- **Run `dispatcher prune-worktrees` on every firing, and after every worker reports.** A worktree keeps its branch checked out, and git will not check out one branch in two places - so an abandoned agent worktree makes that PR's branch un-checkoutable for the owner, who just sees "failed to execute git". The worker cannot release its own worktree (a worktree-isolated agent cannot run git against the main checkout, and a worktree cannot be removed from inside itself), so this is the dispatcher's job and it is one command: the keep rules for a running agent's worktree, uncommitted work and unpushed commits are enforced by the tool, not by you (see `dispatcher:spawn-developer`, section C3). **Every firing, not just after a completion** - a loop with no workers running would otherwise never prune, which is exactly when a worktree stranded by a dead session sits blocking its PR. Report a non-zero exit.
- **Re-check the PR's merge state immediately before any state write.** Worker and reviewer results arrive minutes after the work they describe, and the owner merges in between. A merged PR means the board is already `Done` and correct - writing a state then can only clobber it. Never write a state from a result you have not re-validated against the PR's current state.
- Never set a **top-level task** to Done and never close one by hand: it has a PR, and the owner's merge is what completes it (`dispatcher board state` refuses `done` on an issue with no parent, so this cannot happen by accident). The **legacy sub-issue carve-out is deliberate**: sub-issues have no PR, so setting them `Done` as they are implemented is exactly right. Never dispatch a `Backlog` issue, and never dispatch a legacy sub-issue whose parent is in the milestone - one task is one PR, and dispatching a piece separately is what split-PR consolidations came from. Never merge a pull request (`gh pr merge` or the web UI) and never push task work to `main` - workers must not either. Never deploy. Never run destructive data operations, and workers must not either - a task requiring them is `Confirm with user` territory: skip and flag it.
- Respect the caps: 2 developers, 2 reviewers, 1 cleanup worker in its own slot, 5 workers total, and 5 PR branch updates per freshness sweep.
- **Never force-push or rebase a PR branch, and never update a branch you do not own.** The freshness sweep updates branches by *merge* through the app token, and only for bot-authored, non-draft PRs whose branch is not checked out in any local worktree. Force-pushing marks existing review threads outdated; updating the owner's branch, or one a running worker holds, hands them a non-fast-forward on their next push.
- **Never promote a PR past the owner's own review.** Read every review surface on the PR before deciding a state - `gh pr view <N> --comments`, `gh api repos/<owner>/<repo>/pulls/<N>/reviews`, and `.../pulls/<N>/comments` - not just the `reviewer`'s findings. A PR carrying unaddressed owner change requests is **not** ready for Human Review however clean the AI verdict was, and a fix-round prompt must carry those requests **verbatim** (approximate design language like "a bit wider (50% or so)" *is* the spec; paraphrasing loses it).
- **The dispatcher is the only writer of board state, delegates and claims**, with exactly two carve-outs: a developer sets the state of the **legacy sub-issues of its own claimed task**, and any worker **parking its own claimed task on an owner question** comments the question, sets that task's state to `Question` and releases its claim - the one time a worker touches a parent's state. Workers touch nothing else on the board. Separately from the board, a developer edits the **description** of its own claimed task to tick off checkboxes as it goes; that is sanctioned and is the live progress signal. Workers do write to their PR, and the reviewer posts one short issue comment; that is the extent of it.
- Never dispatch a reviewer for a PR a developer is still working on, and never dispatch a developer for an issue a reviewer is holding. The claim is what makes this checkable - always poll before spawning rather than trusting session memory.
- Report worker failures honestly in status updates; never paper over a red quality gate.
