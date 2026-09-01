---
name: spawn-cleaner
description: Dispatch the single cleaner subagent at an open pull request that has fallen into conflict with the default branch, and route its result when it finishes - selection, claiming, the cleanup prompt, and the restore-not-promote board rule. Also carries the project-wide stranded-row scan that runs every firing. Invoke from the dispatcher:start loop when you are about to spawn a cleanup worker, have just been notified one finished, or are running the stranded-row scan.
---

# Dispatch a cleaner worker

Invoke this **at the decision point**, not from memory.

`cleaner` is the third worker type. It exists because a PR in conflict with the default branch (`main` below) never heals on its own, gets worse with every merge the owner makes, and blocks a merge the owner is waiting on - but resolving it is not feature work and must never compete with the backlog for a developer slot.

Board access is `dispatcher board <command>` (the project may wrap the binary - its CLAUDE.md says how to invoke it; arguments are identical). `<REF>` is the platform's issue reference; states are written by role: `in-progress`, `question`, `human-review`, `changes-requested`, `backlog`. Which agent phase a row is in is the **delegate**, moved by `dispatcher board assign <REF> <developer|reviewer>`.

## A. Before spawning

**1. Cap check: exactly one.** At most **1** cleanup worker in flight, ever. It has its own slot **in addition to** the 2 developers and 2 reviewers, so it neither starves the backlog nor waits behind it. If one is already running, stop here.

**2. Scan open PRs, not board rows.** A conflicting PR usually belongs to an issue at `Human Review` - finished work waiting on the owner - which no board-state query surfaces as dispatchable. Enumerate from the PR list and work back to the issue, the opposite direction from every other dispatch:

```bash
gh pr list --state open --limit 50 \
  --json number,title,headRefName,isDraft,author,mergeable,mergeStateStatus
dispatcher board pr-issues <number>          # the board issue(s) a PR belongs to, any era
```

**`mergeable_state` reads `unknown` until GitHub computes it, and every push to `main` invalidates it.** A scan taken right after a merge reports `unknown` for everything and yields an empty conflict list that looks like good news. **Always re-query the candidates before believing any verdict** - one pass to trigger computation, a short pause, then a second authoritative pass. This has produced a false "no conflicts" reading in a real run.

**3. Skip these:**

| Skip | Why |
| --- | --- |
| Draft | Unfinished work; its author is still moving the same files. |
| Branch checked out in any local worktree (`git worktree list`) | Git refuses to check out one branch in two places, so the spawn fails. Also covers "do not disturb the owner's working copy". |
| Its issue is already claimed, or has a developer in flight | That worker merges `main` as part of its own round. |
| Already attempted at this head SHA and this `main` SHA | One attempt per (head, `main`) pair - see the hand-back rule. |

**The owner's own PRs are in scope**, unlike in the freshness sweep. The sweep skips them because pushing a merge commit onto a branch they may be mid-edit on is disruptive; here the worktree check already covers that, and a conflict blocks the merge whoever opened it.

**4. Order by `behind_by` descending.** Depth of drift is the best proxy for conflict size, and the worst-drifted PR is the one degrading fastest.

```bash
gh api repos/<owner>/<repo>/compare/main...<headRefName> --jq '"behind=\(.behind_by) ahead=\(.ahead_by)"'
```

**5. Claim the issue and record where it came from.** Claim exactly like any dispatch - that is what stops a second dispatcher taking it - and **write the prior state down in your loop state**, because you have to put it back:

```bash
dispatcher board claim <REF> cleanup
dispatcher board state <REF> in-progress
```

**6. Spawn** with the Agent tool: `subagent_type: dispatcher:cleaner` (the type may also appear as plain `cleaner` - use whichever your Agent tool lists), `isolation: "worktree"`, `run_in_background: true`.

## B. Prompt must-haves

- The PR number, its branch, its `behind_by`, and that it currently conflicts.
- The issue description **as context only** - explicitly not a list of work to do.
- **The specific landmines in the commits being merged.** This is what separates a useful cleanup prompt from a generic one: name the renames, deletions and moved shared APIs that landed on `main` since the branch forked. A worker that knows `onSelect` became `onPick` and `ClearAction` was deleted will find the silent breakage; one that does not will ship a clean-looking merge.
- The **silent semantic conflict** warning in full: a file new on the branch has no textual conflict yet may reference an API `main` renamed or deleted, and components that ignore unknown props make it compile-and-do-nothing. Typecheck is the detector.
- The loss-proof requirement, **with arithmetic**: per-parent vs result test-case and assertion counts, merged = base + branch delta + main delta.
- Out of scope, stated plainly: no feature work, no refactors, and **no acting on review findings**.
- **The issue identifier**, so the question-parking path works - without it the worker cannot park the task when two features genuinely disagree and the choice is the owner's.
- **The project's quality-gate and install commands** (from its CLAUDE.md), and any project-specific generated-file recipes the merge may touch.
- Standing prohibitions: never rebase, never force-push, no creating issues, no merging, no closing issues, no board edits beyond the question-parking carve-out, no pushing to `main`, no deploys, no destructive data operations, no `git restore` / `git checkout --`.
- A report that states **whether any file needed manual resolution** - you route the board on that answer.

## C. When it finishes

**1. Has the PR already been merged?**

```bash
gh pr view <PR> --json state,mergedAt --jq '"\(.state) \(.mergedAt // "-")"'
```

If `MERGED`, the owner merged while the worker ran: the board's merge automation completed the issue. **Write no state at all**, release the claim, report what landed, and move on.

**2. Verify** - the PR is `MERGEABLE`, CI is green on the new head, the branch is pushed, and the worker's commits are attributed to the developer bot account (the config's `githubApps.developer.botLogin`). Some of these PRs were opened from the owner's account, so a commit landing under their identity is a real risk worth checking rather than assuming.

**3. Free the worktree:** `dispatcher prune-worktrees`. A held branch is un-checkoutable for the owner, and the worker cannot release its own worktree - a worktree-isolated agent is blocked from running git against the main checkout, and a worktree cannot be removed from inside itself. The command applies the keep rules (locked, uncommitted, unpushed, outside `.claude/worktrees/`) and sweeps the husks a failed Windows removal leaves behind; see `dispatcher:spawn-developer`, section C3. Report a non-zero exit - it means git still lists a worktree the prune tried to remove.

**4. Route - restore, never promote.**

- **Any file needed manual resolution** -> `dispatcher board assign <REF> reviewer`, so a reviewer checks the merge itself. Merges have silently dropped content that CI did not catch, more than once. Scope that review to the merge, not the feature - the feature was already reviewed. A row that was at `Human Review` moves back to `In Progress` for that review; one that was already `In Progress` just changes delegate.
- **Nothing actually conflicted** (it cleared before the worker started) -> restore the state **and the delegate** it came from, and say so.

**Never promote a PR past where it was on the strength of a conflict fix.** A row at `Human Review` has already been reviewed for its feature; a row at `Changes Requested` still owes the owner its change requests, and resolving its conflict does not discharge them.

**5. One attempt, then hand it back.** A conflict a fresh worker cannot untangle means two features genuinely disagree, and choosing between them is the owner's call. The worker parks that itself: it comments the question on the issue (which sides disagree, the options, its recommendation) and sets the task's state to `Question`. Verify both writes actually happened and fix either it missed, release the claim, and surface the question in your status text every firing until the owner answers - they move the row out of `Question`, normally to `Changes Requested` since the PR exists. If the worker failed for any *other* reason (crashed, gates red, ran out of context), comment "needs human attention: conflict resolution failed - <reason>", restore the prior state, release the claim, and do not retry until its head SHA or `main` moves.

**6. Report the queue, not just the win.** "Resolved #429, 5 still conflicting (#438 behind 15, #452 behind 13, ...)" - a growing conflict pile is invisible if you only report what you fixed.

## D. Stranded-row scan (every firing, project-wide)

The conflict scan keeps open PRs mergeable; this scan keeps the **board** honest. A claim is a heartbeat, so a claim older than the staleness window (90 minutes by default) belongs to a session that died - and the row under it is stranded: some step was promised (a review, a fix round) that nobody will ever run. Crucially the scan is **project-wide and ignores the milestone scope**, like the conflict scan: a stranded row in a milestone no dispatcher is polling stays stranded forever precisely because nothing looks at it. Real case: a row sat awaiting review for 12 days under a dead session's review claim - a cleanup round had manually resolved its PR's conflicts, the merge review the claim promised never ran, and no dispatcher was scoped to its milestone to notice.

One command surfaces every candidate - claimed rows, rows queued for an agent, plus parked questions:

```bash
dispatcher board claims
```

Columns: **kind** (`own-claim` - this session's; `claim` - another live session's; `stale-claim` - older than the window and not yours; `queued` - delegated to an agent with no session on it; `question` - a row at `Question`), **milestone**, **state**, **delegate**, **claim**, **age-min**, **issue**, **title**.

Rows marked `own-claim` or `claim` are workers doing their job - leave them alone. A `queued` row is normal between a handoff and the next dispatch; it only needs attention if it has been sitting there across several firings, which means no dispatcher is scoped to its milestone. For each **`stale-claim`**, route on the row's delegate and state:

- **Delegated to the reviewer agent with an open, non-draft PR** -> steal the claim (`dispatcher board claim <REF> review`) and dispatch the review it was waiting for, **whatever milestone the row is in** - an unreviewed finished PR blocks the owner's merge queue, which is exactly this lane's business. Reconstruct the scope from the issue's and PR's comment history first: a cleanup that manually resolved conflicts means a **merge-scoped** review with restore-not-promote routing; otherwise a normal feature (re-)review. The reviewer cap applies - if both slots are busy, carry the row in your loop state and dispatch it at the next free slot rather than forgetting it.
- **In Progress inside the milestone set** -> nothing extra to do here: the normal poll's tier 1 already picks it up.
- **In Progress outside the milestone set** -> release the stale claim (`dispatcher board release <REF>`) and surface the row to the owner in your status text; do not start development in a milestone the owner did not name.
- **Anything else** -> release the stale claim so the row reads honestly, and surface it.

The same command lists every **`question`** row - a task parked on an owner question. Never dispatch these; surface each one in your status text every firing (the question itself is in the issue's comments: `dispatcher board issue <REF>`), because a parked question nobody mentions is indistinguishable from a forgotten task.

## Cleanup prompt template

```
You are resolving the merge conflicts on ONE existing pull request. This is a NARROW task: merge
`main` into the branch and resolve the conflicts. Do not build features, do not refactor, and do not
act on review findings.

## Task
- Title: <title>
- Issue: <REF> - <issue url> (context only - do NOT edit the issue or the board)
- Pull request: <pr url> (#<pr number>) on branch `<headRefName>`
- The PR reports `mergeable_state=dirty` (CONFLICTING) and the branch is **<N> commits behind `main`**.
- Issue description, so you understand what the branch is trying to do (NOT a list of work to do):
<description>

## What to do
1. Check out `<headRefName>` and `git merge origin/main`. **Never rebase and never force-push** - a
   force-push marks every existing review thread on this PR outdated, and this PR carries review
   history that must survive.
2. Resolve every conflict by keeping BOTH sides' intent: this branch's feature AND everything that
   landed on `main`.
3. **Verify the merge lost nothing from either side.** Merges have silently dropped content - a set
   of test assertions, and an entire settings modal - and the owner caught both, not CI. For every
   conflicted file, diff the merged result against both parents. In test files, **count test cases
   and assertions on each parent and on the result and show the arithmetic**: merged = base + branch
   delta + main delta.
4. **Hunt for silent semantic conflicts - git will NOT flag these.** A file that is new on this
   branch has no textual conflict at all, but may have been written against an API that `main` has
   since renamed or deleted; it merges "cleanly" while referencing things that no longer exist.
   Components that ignore unknown props are the dangerous case - the code compiles and does nothing.
   Landmines in the commits you are merging: <name them explicitly>.
   Typecheck against the merged tree is your detector; never accept a cached pass.
5. If `main` changed a pattern the branch relies on, the merged result must use the CURRENT `main`
   pattern, not the branch's old one.
6. **Generated files are regenerated, never hand-merged.** Resolve the dependency lockfile by first
   merging the manifests keeping BOTH sides' entries, then discarding the conflicted lockfile and
   regenerating it with the project's install command - read that command from the project's
   CLAUDE.md or build files rather than assuming, it changes. Never take one side of a lockfile
   wholesale; that silently drops the other side's dependencies. Same for anything else a recipe
   emits: <project-specific generated-file recipes, from its CLAUDE.md - omit if none>. If a
   regenerated lockfile comes back with a DIFFERENT version for any package, that is a finding to
   report, not a resolution to accept - pinned versions are deliberate and a merge is never where a
   bump gets introduced.

## Out of scope
- Do NOT address review findings on the PR, blocking or otherwise. Another round handles those.
- Do NOT improve, rename, or refactor anything the merge did not force you to touch.
- If resolving a conflict genuinely forces a behaviour change, make the smallest honest one, cover it
  with a test, and call it out explicitly in your report.

## Protocol
- You run in your own git worktree. Bootstrap it before any gate: <the project's install command>.
- ALL quality gates must be green: <the project's quality-gate commands, from its CLAUDE.md>.
- Commit as the developer GitHub App: `dispatcher commit -m "<message>"`, never plain `git commit`.
  This PR may have been opened from the owner's account - check `git log` authorship and fix it if
  any commit did not land as the bot.
- `git push origin HEAD` (no force). The PR exists - do NOT run `dispatcher pr` or `gh pr create`.
  Then confirm `gh pr view <N> --json mergeable,mergeStateStatus` reads MERGEABLE.
- Reply on the PR saying what conflicted and how you resolved it.
- Do NOT: create issues, merge the PR, close the issue, edit the issue or its board state (the
  question-parking writes below are the only exception), push to `main`, deploy, run destructive
  data operations, or use `git restore` / `git checkout --`.
- `main` may move while you work. Merging it again is fine; do not chase it indefinitely - stop once
  you are clean and CI is green, and say how far behind you ended up.
- If the conflict cannot be honestly resolved - two features genuinely disagree about the same code -
  do not guess at which side the owner wants. Park the task for the owner instead: write the question
  to a file (which sides disagree, the options with their consequences, and which you would pick and
  why) and comment it (`dispatcher board comment <REF> --as cleaner --body-file <path>`), set the
  task's state to Question (`dispatcher board state <REF> question` - a state, not a label, so the
  row says on its own that it is waiting on the owner), release your claim
  (`dispatcher board release <REF>`, which clears the delegate too, so the row does not read as an
  agent still holding stopped work), leave the branch un-pushed rather than pushing a half-resolved
  merge, and report INCOMPLETE with the specifics. These parking writes are the ONLY issue/board
  writes you may make.

## Report (your final message is ALL the dispatcher sees)
1. STATUS: COMPLETE or INCOMPLETE
2. Which files conflicted, and how you resolved each
3. Whether any file needed MANUAL resolution, or whether it all auto-merged - say this explicitly,
   the dispatcher routes the board on it
4. Any silent semantic conflicts you found, and how you reconciled them - say explicitly if you found
   none, and how you checked
5. Your evidence nothing was lost: per-parent vs result counts with the arithmetic, and what you diffed
6. Anything you touched beyond pure conflict resolution, and why
7. Quality gates: actual pass/fail of each
8. The PR's mergeable state after your push, and confirmation your commits are attributed to the bot
9. Follow-ups worth the owner's attention - describe them; do NOT file an issue
```
