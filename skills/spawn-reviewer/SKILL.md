---
name: spawn-reviewer
description: Dispatch one adversarial reviewer subagent at a task's pull request, and route its verdict when it finishes - selection, claiming, writing a review prompt that targets real risk, and the promote-or-send-back decision. Invoke from the dispatcher:start loop at the moment you are about to spawn a reviewer or have just been notified one finished.
---

# Dispatch a reviewer

Invoke this **at the decision point**, not from memory. The reviewer is read-only and never touches the working tree, so it is cheap and safe to run alongside anything - the risk here is not collisions, it is promoting work that is not actually ready.

Board access is `dispatcher board <command>` (the project may wrap the binary - its CLAUDE.md says how to invoke it; arguments are identical). `<REF>` is the platform's issue reference (`ACM-12` on Linear, `#480` on GitHub); states are written by role: `changes-requested`, `in-progress`, `question`, `human-review`, `backlog`. Review is not a state: a row under review is `In Progress` **delegated to the reviewer agent**, moved there by `dispatcher board assign <REF> reviewer`.

## A. Before spawning

**1. Cap check.** At most **2** reviewers in flight. Fill the reviewer queue before the developer queue when both have work: a review is short and unblocks the owner, while a stalled review queue leaves finished work invisible.

**2. Select** a row **delegated to the reviewer agent** (the `delegate` column of the poll), unclaimed or stale-claimed, with an open **non-draft** PR. Two rows are not reviewable:

- **No PR at all** - the poll's `prs` column only shows PRs the board has linked, so run `dispatcher board pr-issues <pr>` over the open PRs (or match the identifier / legacy number / slug in `gh pr list --state open`) before concluding there is none, and `dispatcher board link-pr <REF> <pr>` any you find. If there genuinely is none, comment "needs human attention: delegated to the reviewer with no open PR" and skip it.
- **A draft PR, unticked checkboxes in the issue description, or unfinished legacy sub-issues** - nothing to review yet. Hand it back with `dispatcher board assign <REF> developer`. But first check whether the piece is merely *unmarked*: something built but left unticked, or a legacy sub-issue still reading `In Progress`, is a stale record you fix (see `dispatcher:spawn-developer`, section C2), not unfinished work that bounces the task.

**3. Confirm CI has finished.** A reviewer takes gate results from CI rather than running them, so an in-flight or missing check makes its verdict meaningless. If `statusCheckRollup` conclusions are empty, wait (`gh pr checks <PR> --watch`).

**4. Claim, then spawn:**

```bash
dispatcher board claim <REF> review
```

Agent tool: `subagent_type: reviewer`, `run_in_background: true`. **No worktree** - it must not get one.

## B. Writing a review prompt that earns its cost

A prompt that just says "review this PR" produces a style audit. Give it the specific risk surface:

- **State the PR's own claims, then tell it to verify them rather than accept them.** The claims are where the defects hide: "no new scope needed", "degrades gracefully", "cached per user", "chunked". Real runs found a scope claim that held and a fail-graceful claim that did not, both only because the reviewer was pointed at them.
- **Name the failure modes worth hunting** for this change: pagination silently truncating, a stale value presented as current, a remote call that throws instead of degrading, sort-after-truncate, double-fire on redelivery, an unbounded cache, a query fan-out where there was one query.
- **Ask for a per-checkbox coverage verdict** - implemented / not implemented / cannot tell, for every box in the issue description. That is not something the developer can be trusted to self-assess, and a ticked box the diff does not deliver is blocking. On a legacy task, ask for the same verdict per sub-issue: it is what decides which of them are honestly `Done`.
- **One task is one PR.** Tell the reviewer to treat work split across two PRs as blocking, whatever the issue description says - split PRs have had to be consolidated back onto one branch before.
- **List what is already known and must not be re-raised** (a tracked known issue, a disclosed follow-up, absent test infrastructure). Otherwise rounds 2 and 3 re-litigate settled ground.
- On a **re-review**, say which findings were fixed and how, and scope it to the deltas and their blast radius. Remind it that manufacturing findings burns a full developer round for nothing, and rubber-stamping defeats the purpose.
- **Spell out the question-parking path** so it works: when the verdict genuinely hinges on a decision only the owner can make (a product call, not a code fact), the reviewer parks the task - comments the question on the issue (`dispatcher board comment <REF> --as reviewer --body-file <path>`), sets the state to `Question` (`dispatcher board state <REF> question`) and releases the claim (`dispatcher board release <REF>`, which clears the delegate too, so the row does not read as an agent still holding stopped work) - and ends `VERDICT: QUESTION` instead of guessing or forcing a verdict. Same three writes the developer and cleaner make when they park a task.
- Standing rules for the prompt: read-only (no edits, commits, checkouts, installs; read with `git show origin/<branch>:<path>`), **no creating issues**, line-anchored comments with `event: "COMMENT"` only - never `--approve` or `--request-changes` - then one short verdict comment on the issue, and no board or issue writes beyond the question-parking carve-out above.
- Require the report to end in `VERDICT: PASS`, `VERDICT: CHANGES_REQUESTED`, or `VERDICT: QUESTION`.

Note in the prompt when the change has had **no visual or interaction pass** (agents may be unable to drive the project's live UI) and ask which risks only a human click-through can retire.

## C. When it finishes

**First: has the PR already been merged?** A verdict can arrive minutes after the owner merged, and a state write built on a stale verdict silently overwrites what the merge set.

```bash
gh pr view <PR> --json state,mergedAt --jq '"\(.state) \(.mergedAt // "-")"'
```

If it reads `MERGED`, the task is **finished**: the board's merge automation completed the issue. Do not write any state - not `Human Review`, not anything. Release the claim, say in your status text that the owner merged it and what the review found (the findings are still worth surfacing even though the merge landed), and move on. This has happened: a PASS was processed six minutes after a merge and set a completed task back to review.

Then route on the verdict line:

**PASS** -> **before promoting, check the PR for the owner's own review.**

```bash
gh api repos/<owner>/<repo>/pulls/<PR>/reviews --jq '.[] | select((.body//"") != "") | "\(.user.login) \(.state)\n\(.body)"'
```

Filter the AI's own reviews out by login first - they come from the reviewer bot account (the config's `githubApps.reviewer.botLogin`), and what remains with a body is the owner's. Owner change requests outrank an AI PASS. If any are unaddressed, this does **not** promote - `dispatcher board state <REF> changes-requested`, `dispatcher board release <REF>`, and send it back to the developer queue with those requests verbatim. Otherwise `dispatcher board state <REF> human-review` and `dispatcher board release <REF>` (which clears the delegate too - the agent pipeline is done with it), then comment the verdict plus PR link. Say in your status text that a PR is waiting on the owner, and report **open PR count from `gh pr list --state open`** - never from counting `Human Review` rows, which can include work needing a sign-off rather than a merge.

**CHANGES_REQUESTED** -> `dispatcher board state <REF> changes-requested` plus `dispatcher board release <REF>` - never back to `Ready`, which means "never worked on" - or `dispatcher board assign <REF> developer` if you are resuming it immediately. Leave the PR open so its threads stay live, and comment the findings on the issue so the round-trip is visible in its history. A `Changes Requested` row outranks every `Ready` row in the developer queue, so it is normally the next thing dispatched.

**QUESTION** -> the reviewer parked the task on an owner decision. Verify its three writes actually happened - the question commented on the issue, the state at `Question`, and the claim released - and make any it missed (`dispatcher board release <REF>` is idempotent, so re-running it costs nothing and clears the delegate if the reviewer got only part-way). Then surface the question in your status text - in full, with the options and its recommendation - every firing until the owner answers. Never answer it yourself, and never re-dispatch a `Question` row.

**No verdict line, or the reviewer failed** -> treat as INCOMPLETE, retry once with a fresh reviewer, then comment "needs human attention: AI review failed twice" and leave it delegated to the reviewer.

**There is no cap on review round-trips.** Review and fix rounds alternate until the PR passes or the owner intervenes - do not count rounds or park a task for cycling. The retry-once rule above covers broken reviewer runs, not honest verdicts.

## Reviewer prompt template

```
You are adversarially reviewing ONE completed task from the project backlog. Review only this PR.

## Task
- Title: <title>
- Issue: <REF> - <issue url>
- Pull request: <pr url> (#<pr number>)
- Labels: <labels>
- Full description (issue description) - this is the contract the implementation must satisfy:
<description>
- Breakdown from the issue description - every checkbox is part of this PR's contract, and this task
  is ONE PR whatever the description says about splitting it up:
  [x] <checkbox text>
- Legacy sub-issues this PR is also expected to deliver, if any (all of them, in this one PR):
  <CHILD-REF> - <title> (<state>)
<developer's report, if available>
<earlier review rounds on this PR, if any - say whether each prior finding was actually addressed>
<project-specific review notes from the project's CLAUDE.md - its CRITICAL rules, design docs, and
convention checks worth holding the diff against; omit if none>

## Protocol
- Read your agent instructions in full and follow them. In short: hunt for real flaws, never edit code, never merge, never approve or request-changes as a GitHub review event.
- Post findings on the PR as ONE `event: "COMMENT"` review, anchored to the lines they concern.
- Post it **as the reviewer GitHub App**, never the owner's `gh` account:
  `GH_TOKEN="$(dispatcher token --app reviewer)" gh api repos/<owner>/<repo>/pulls/<PR>/reviews --input - <<'JSON' ...`
  The developer app authored this PR, so the review has to come from a different identity to be an
  independent signal, and a review under the owner's account would consume the human review the board
  is waiting for. Scope GH_TOKEN to the single command; use `gh api` rather than `gh pr review`
  (that resolves `GET /user`, which 403s for an installation token). If `dispatcher token --app reviewer`
  fails, stop and report it - never fall back to the owner's auth.
- Then post a short one-line verdict comment plus the PR link on the issue:
  write it to a file and run `dispatcher board comment <REF> --as reviewer --body-file <path>`. Nothing
  more goes on the issue. (Board comments may post under the owner's account; the `--as reviewer` tag
  on the first line is what identifies the comment as yours.)
- If your verdict genuinely hinges on a decision only the owner can make - a product call, not a code
  fact you can settle by reading - do not guess and do not force it into PASS or CHANGES_REQUESTED.
  Park the task instead: comment the question on the issue (context, the options with consequences,
  your recommendation) with `dispatcher board comment <REF> --as reviewer --body-file <path>`, set the
  task's state to Question (`dispatcher board state <REF> question` - a state, not a label, so the row
  says on its own that it is waiting on the owner), release the claim (`dispatcher board release <REF>`,
  which clears the delegate too, so the row does not read as an agent still holding stopped work),
  and end `VERDICT: QUESTION`. These are the ONLY board/issue writes permitted beyond the comments
  above.

## Report (your final message is ALL the dispatcher sees)
1. A short findings summary, most severe first
2. Count of blocking findings vs non-blocking nits
3. The PR review URL
4. The LAST line must be exactly `VERDICT: PASS`, `VERDICT: CHANGES_REQUESTED`, or `VERDICT: QUESTION`
   - CHANGES_REQUESTED if there is at least one blocking finding (correctness bug, unmet acceptance
     criterion, violated CRITICAL rule, missing or weakened test coverage, failing CI)
   - PASS if only non-blocking nits remain. PASS is not approval to merge; it means the work is ready
     for the user to look at.
   - QUESTION only after you have parked the task per the protocol above.
```
