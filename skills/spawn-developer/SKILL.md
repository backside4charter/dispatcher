---
name: spawn-developer
description: Dispatch one developer subagent at a backlog task, and handle its result when it finishes - selection, claiming, building a complete prompt, verifying the PR, and reconciling sub-issues. Invoke from the dispatcher:start loop at the moment you are about to spawn a developer or have just been notified one finished.
---

# Dispatch a developer

Invoke this **at the decision point**, not from memory. The parent `dispatcher:start` skill is long and is read once at loop start; the steps below are the ones that get skipped when acting from recall, and every one of them has been missed in a real run.

Board access is `dispatcher board <command>` (the project may wrap the binary - its CLAUDE.md says how to invoke it; arguments are identical). `<REF>` is the platform's issue reference (`ACM-12` on Linear, `#480` on GitHub); states are written by role: `backlog`, `ready`, `changes-requested`, `in-progress`, `question`, `human-review`. Which agent phase a row is in is the **delegate**, not a state - `dispatcher board assign <REF> <developer|reviewer>` moves it.

## A. Before spawning

**1. Cap check.** At most **2** developers in flight. If already at 2, do not spawn.

**2. Select, in strict tier order.** Take the first tier with an eligible row and only fall through when it has none:

1. A row already **In Progress** and unclaimed or stale-claimed - finish what's started.
2. The topmost **Changes Requested** row.
3. The topmost **Ready** row.

The row must be in the target milestone, unclaimed, **not a human's** (an assignee **and no delegate** means a human owns it - skip it; a delegated row carries an assignee too, since delegating sets one, so read the two columns together), not labelled `Confirm with user`, have no open blockers, no "needs human attention" note, and no parent in the same milestone. Board order ranks rows *within* a tier only.

**`Changes Requested` beats `Ready` even when the `Ready` row sits higher on the board.** A sent-back row already has an open PR the owner is waiting on; leaving it while starting something new just grows the pile of half-finished PRs. `Ready` means "never worked on"; `Changes Requested` means "worked on and sent back", and it always comes with an existing PR and branch to resume rather than a fresh branch to cut.

**3. Read the issue, including the checkbox list in its description.**

```bash
dispatcher board issue <REF>          # description, sub-issues, blockers, last 10 comments (--comments 30 for a long thread)
```

That list is the task's breakdown and the developer's live progress signal: **one task is one branch and one PR** whatever it contains, and the boxes are how progress shows without a second PR. If the description instead says a piece should get its own PR, ignore that and flag the wording to the owner - descriptions have said exactly that, and the resulting split PRs had to be consolidated back onto one branch.

**3a. On a legacy row, read its live sub-issue set too.** Tasks created under an older workflow model may still carry sub-issues; nothing creates new ones. The `## Sub-issues` table `dispatcher board issue` prints carries each child's state and open blockers. That set changes over a task's life - issues get reparented or folded in from duplicate trees while the task sits in review - so re-read it on **every** dispatch against such a row, including fix rounds and retries. Run `dispatcher board issue` on any child that has children of its own; the whole subtree belongs to the task.

Sort the result into three groups and put **all three** in the prompt:

- **Blocked** (an open blocker in the table) - named as explicitly out of scope, with the blocker, so the developer neither attempts them nor claims them delivered.
- **Already delivered** by the open PR (the reviewer's coverage verdict tells you) - nothing to do, they are `Done`.
- **Unblocked and outstanding** - the actual work.

A bare list of identifiers is not enough: it makes the developer re-derive the split, and invites it to redo finished work or attempt something whose blocker does not exist yet.

**3b. If the row was recently parked on a question, go and read the answer.** A parked task sits at state **`Question`** and comes back as: the owner replies to the worker's question comment and moves the row to `Ready` (if it was never worked) or `Changes Requested` (if it already has a PR). The answer exists **only in that issue's comment thread**, so a prompt built without it re-runs the same task into the same wall. `dispatcher board issue <REF>` prints the last 10 comments; raise `--comments` if the question is older.

Find the worker's question (tagged `**[developer]**`, `**[reviewer]**` or `**[cleaner]**`) and the owner's reply beneath it (untagged - board comments may all post under the owner's account, so the tag is what tells them apart), and put **both** in the prompt verbatim - the question for context, the answer as the decision.

The state says everything on its own, so there is nothing to read alongside it:

| State | Meaning |
| --- | --- |
| `Question` | waiting on the owner - never dispatch, surface it every firing |
| `Ready`, with a worker question in its comments | the owner has answered - dispatch it as fresh work, with their answer in the prompt |
| `Changes Requested`, with a worker question in its comments | the owner has answered - dispatch it as a fix round on its open PR, with their answer in the prompt |

If a dispatchable row's comments carry an unanswered worker question, do **not** dispatch it: the owner moved it out of `Question` without replying, or replied somewhere the worker will not look. Say so in your status text and leave it.

**4. If resuming a PR, read every review on it - including the owner's.**

```bash
gh pr view <PR> --comments
gh api repos/<owner>/<repo>/pulls/<PR>/reviews  --jq '.[] | select((.body//"") != "") | "\(.user.login) \(.state)\n\(.body)"'
gh api repos/<owner>/<repo>/pulls/<PR>/comments --jq '.[] | "\(.user.login) \(.path):\(.line)\n\(.body)"'
```

The `reviewer` is not the only reviewer. **Owner change requests outrank any AI verdict**, so separate the two before building the work list. On GitHub `user.login` tells them apart directly: AI reviews come from the reviewer bot account (the config's `githubApps.reviewer.botLogin`), and anything else with a body is the owner's. Content still corroborates it - an owner review is terse, imperative and product-flavoured, usually a `state=COMMENTED` review whose body is a bullet list. Carry the owner's wording into the prompt **verbatim** - approximate design language ("a bit wider (50% or so)") is the spec, and rewriting it as a precise number substitutes your judgement for theirs.

**5. Claim before spawning** (this is what closes the race between two dispatchers):

```bash
dispatcher board claim <REF> dev
dispatcher board state <REF> in-progress
```

**6. Spawn** with the Agent tool: `subagent_type: developer`, `isolation: "worktree"`, `run_in_background: true`.

## B. Prompt must-haves

Beyond the task description, a prompt that omits any of these is broken:

- **The checkbox list from the issue description, and the instruction to tick each box as that piece lands** - as it goes, not batched at the end. Editing the description for that is sanctioned; it is the only progress signal a current-model task has.
- **One PR, stated explicitly** - never a second PR for a piece of the task, whatever the issue description says.
- **On a legacy row, the sub-issue table** with each child's identifier, title and state, and the blocked / delivered / outstanding split from step 3a. The worker flips them with `dispatcher board state <CHILD-REF> in-progress` / `done` - the identifier is enough.
- **The branch name, computed by you, as `task/<ref-lowercased>-<kebab-slug>`** (e.g. ACM-480 "Fix chat widget scroll pinning" -> `task/acm-480-chat-scroll-pinning`). Compute it rather than leaving the worker to invent one: the identifier is what lets anyone reading `git branch`, a PR list or a stale worktree map it back to a board row without opening anything, **and it is what makes the board integration link the PR to the issue automatically** - a branch without it leaves the PR unlinked, and an unlinked PR merges without completing the task. Keep the slug short - the identifier carries the identity, the words are only there to be readable. Omit it only when resuming, where the existing branch name stands regardless of whether it has an identifier.
- **The `Fixes <REF>` line for the PR body**, which links the PR on the board's side too (belt and braces with the branch name) and completes the issue on merge. A task imported from another board also keeps `Fixes #<legacy-number>` if it had one; the number is in the issue header.
- **The project's install and quality-gate commands**, read from its CLAUDE.md, plus any project-specific protocol notes it carries for this kind of work (design-skill requirements for UI-labelled tasks, generated-file recipes, vendored-toolchain notes).
- The owner's change requests verbatim, if resuming.
- For a resume: the existing branch and PR number, "add commits, do not open a second PR", and **never force-push** (it marks review threads outdated).
- The standing prohibitions: no creating issues, no merging, no closing issues, no editing the issue beyond its own checkboxes, no board state or claim writes beyond the two carve-outs, no pushing to the default branch, no deploying, no destructive data operations, no `git restore` / `git checkout --`.
- A report format ending in follow-ups that are **described, not filed**.

## C. When it finishes

**1. Verify, don't trust.** The PR exists, targets the default branch, is not a draft, is mergeable, and CI is actually green:

```bash
gh pr view <PR> --json state,isDraft,baseRefName,mergeable,statusCheckRollup
```

If checks show an empty conclusion they are still running - **wait for them** (`gh pr checks <PR> --watch`) rather than promoting or dispatching a reviewer at an unverified commit. A COMPLETE report with no open PR is not complete.

**The PR's author must be the developer app** - `gh` reports it as `app/<developer-app-slug>` (the config's `githubApps.developer.slug`; a bot keeps its original login even if the app is renamed). A PR authored by the owner's account cannot be approved by the owner, so send it back to be reopened with `dispatcher pr` rather than leaving an unreviewable PR on the board. Spot-check `gh pr diff <PR>` if anything smells off.

**If `state` reads `MERGED`, stop.** The owner merged while the worker ran; the board's merge automation completed the issue. Write no state at all, release the claim, and report what landed. The board is already correct and anything you write can only make it wrong.

**2. Check the link and the breakdown - hard gate.** `dispatcher board issue <REF> --comments 0`:

- The PR must appear under **Pull requests**. If it does not (the branch or body missed the identifier), link it now: `dispatcher board link-pr <REF> <PR>`. An unlinked PR merges without moving the issue, which leaves a `Human Review` row lying about a finished task.
- **Every checkbox in the description must be ticked** before the task can go to review. A COMPLETE report with unticked boxes is INCOMPLETE; say which pieces are outstanding and take route 4's INCOMPLETE path. Where the worker built something and forgot to tick it, tick it yourself (edit the description) - its report is the source of truth for what got built, the description just has to match.

On a legacy row, **reconcile the sub-issues** as well: compare the sub-issue table against the developer's report. Anything the developer built that is still sitting at `Ready`, `Changes Requested` or `In Progress` gets set to **Done** by you, now (`dispatcher board state <CHILD-REF> done` - the CLI allows it because the child has a parent). `Done` means *implemented*, not reviewed - a finished task whose sub-issues still read `In Progress` looks half-built to the owner. The developer flipping them live is the primary mechanism; this is the backstop for when it did not, most often because the sub-issue was attached after that developer ran.

**Never set the parent task to `Done`** - the CLI refuses it, and for good reason: the parent has a PR, and the owner's merge is what completes it. The parent is handed to the reviewer, then promoted to `Human Review`, and the merge closes it.

**3. Free the worktree - the owner cannot review a branch an agent is still holding.**

A developer works in its own worktree, and that worktree keeps its task branch checked out after the agent exits. **Git refuses to check out one branch in two places**, so every abandoned worktree makes its PR's branch un-checkoutable: the owner tries to pull it up in their editor and gets a bare "failed to execute git". Left alone these accumulate, one per finished task, until most open PRs cannot be reviewed locally.

**This is yours, not the worker's.** A worktree-isolated agent is blocked from running git against the main checkout, and a worktree cannot be removed from inside itself - so the developer physically cannot clean up after itself. Whoever is left does it, and that is you.

Once the PR is pushed and verified, release it:

```bash
dispatcher prune-worktrees            # --dry-run first if you want to see the plan
```

That removes **every** finished agent worktree, not just this one, so a single call after any worker reports keeps the tree clean. It is safe to run at any time and needs no judgement from you: it keeps a worktree that git has locked (Claude Code locks a running agent's, so a lock means someone is still in there), one holding uncommitted or untracked files, one holding unpushed commits, and anything outside `.claude/worktrees/` - printing the reason for each. It then deletes the husks a failed removal left behind, which is the Windows case where `git worktree remove` deregisters the worktree and then loses the directory delete to an open file handle. It never trusts that command's exit status; it re-lists and asks git what is actually registered now.

It exits non-zero only when git still lists a worktree it tried to remove. **Report that** - it means something is holding the branch and the owner cannot check it out.

Prose used to stand here instead of a command, and prose at the end of a long loop is not a guarantee: dozens of orphaned directories once accumulated over a few weeks, costing gigabytes and making their PRs' branches un-checkoutable. The safety rules above are unit-tested in this repo's `src/worktree-prune.spec.ts` rather than restated here.

**4. Route.**
- **COMPLETE and verified** -> comment on the issue (PR link first, then how to verify: write the body to a scratchpad file, then `dispatcher board comment <REF> --as dispatcher --body-file <path>`), then `dispatcher board assign <REF> reviewer`. That hands the row to the reviewer agent and clears the developer's claim in one call, so no separate `release` is needed; the state stays `In Progress`.
- **INCOMPLETE or verification failed** -> comment the progress notes, retry **once** with a fresh worker carrying the failure context, the existing branch and PR, and which checkboxes (and, on a legacy row, which sub-issues) remain. If the retry also fails: comment "needs human attention: 2 failed dispatcher attempts - <reason>", leave it In Progress, release the claim, skip in future scans.

**5. If the worker parked the task with a question.** A developer that hits a judgement call it cannot make comments the question on the issue, sets the state to `Question` and releases its claim. When you see that, first verify all three writes actually happened and fix any it missed (a parked task still at `In Progress`, or still delegated to an agent, is invisible to the recovery flow), then:

- **Do not re-dispatch it and do not answer the question yourself.** It was escalated precisely because it is the owner's call.
- **Surface it in your status text, in full** - the question, the options the worker laid out, and its recommendation. This is the only way the question reaches the owner; a parked row nobody mentions is invisible.
- Keep surfacing it on later firings while it sits at `Question`, so it cannot quietly rot.
- Confirm the worker pushed what it built and opened a draft PR if there was anything worth showing. If it stranded work locally, say so.

**6. Follow-ups: report, never file.** Only the user creates issues. Relay them in your status text.

## Developer prompt template

```
You are completing ONE task from the project backlog. Work ONLY this task - do not pick up other work, and do not expand scope beyond what the task describes.

## Task
- Title: <title>
- Issue: <REF> - <issue url> (the dispatcher handles all board state updates; the only writes you make are the checkbox ticks, the legacy sub-issue state, and the question-parking writes below)
- Legacy issue number (imported tasks only, otherwise omit): #<number>
- Branch: `task/<ref-lowercased>-<kebab-slug>` (fresh `Ready` work only - a resumed task uses the existing branch named under Existing pull request below, whatever it is called)
- Milestone: <milestone>
- Labels: <labels>
- Full description (issue description):
<description>
<prior progress notes / failure context from an earlier attempt, if any>
<the worker's question and the owner's answer, verbatim, if this task was parked and answered>

## Breakdown (the checkbox list in the issue description)
This task is ONE branch and ONE pull request, whatever it contains. Never open a second PR for a
piece of it - if the issue description says a piece is "its own reviewable unit with its own PR",
ignore that and say so in your report.

- The issue description carries a markdown checkbox list of this task's steps. **Tick each box the
  moment that piece is written and its tests pass** - as you go, not batched at the end. Editing the
  description of your OWN claimed task for this is sanctioned (edit it at the issue URL, or through
  the API); do not touch its prose, its labels, or any other issue.
- A ticked box means implemented, not reviewed. ALL boxes must be ticked before the task can go to
  review.

## Legacy sub-issues (omit this whole section unless the task has them)
This task was created under an older workflow model and still carries sub-issues. They are tracking
only and part of THIS task: one branch, one PR, no separate PRs for them. ALL of them must be
finished before review.

| Sub-issue | Title | State | Blocked by |
| --- | --- | --- | --- |
| <CHILD-REF> | <title> | <state> | <blockers or -> |

- Blocked (out of scope, do not attempt): <list, with blockers>
- Already delivered by the open PR: <list>
- Outstanding (your work): <list>
- Before you start one, set it In Progress: `dispatcher board state <CHILD-REF> in-progress`
- The moment you finish one, set it Done: `dispatcher board state <CHILD-REF> done` - as you go, not
  in a batch at the end. The CLI allows `done` on a sub-issue because it has a parent; it refuses it
  on the parent, which is correct - the owner's merge completes the parent.
- These sub-issue state writes - plus the question-parking writes under Protocol - are the ONLY board
  writes you may make. Never otherwise touch the parent's state, never touch the claim or the
  delegate, and never close any issue by hand. Never create a sub-issue.

## Existing pull request (Changes Requested rows only - omit this whole section for fresh `Ready` work)
- PR: <pr url> on branch `<branch>`
- This task is at **Changes Requested**: the AI reviewer, the repository owner, or both sent it back.
  Read every review surface on the PR - `gh pr view <N> --comments`,
  `gh api repos/<owner>/<repo>/pulls/<N>/reviews` and `gh api repos/<owner>/<repo>/pulls/<N>/comments` -
  and address every blocking finding. **The owner's requests outrank any AI verdict**, and they are
  reproduced verbatim below where there are any; treat their wording as the spec.
- Do NOT open a second PR and do NOT cut a new branch: check out `<branch>` and add commits to it.
- Never force-push - it marks the existing review threads outdated.
- Reply to each review thread you addressed, saying what you changed.

## Protocol
- You run in your own git worktree, so you will not collide with other workers. Bootstrap it before
  running any gate: <the project's install command> (a fresh worktree has no dependencies installed).
- Start on a fresh task branch cut from the default branch: `git switch -c <branch>` off an
  up-to-date origin default branch, using the exact **Branch** name given above - it carries the
  issue identifier, which is what links the branch, its PR and its board row. Never commit task work
  on the default branch.
- Follow the project CLAUDE.md fully: TDD (write the failing integration test FIRST and see it fail
  for the right reason), strong types, and ALL quality gates green before you are done:
  <the project's quality-gate commands, from its CLAUDE.md>.
- <project-specific protocol notes from the project's CLAUDE.md - design-skill requirements for
  UI-labelled work, vendored toolchains, generated-file recipes; omit if none>
- Commit in logical units with clear messages, **as the developer GitHub App**:
  `dispatcher commit -m "<message>"` (or `dispatcher commit -F <path>` for a multi-paragraph
  message), never plain `git commit` - GitHub blocks approving your own PR, so work committed and
  opened as the owner cannot be reviewed by them.
- When done: `git push -u origin HEAD`, then open the PR as the app with
  `dispatcher pr --title "<title>" --body-file <body-file>` (never `gh pr create`; write the body to
  a file, and append `--draft` for incomplete work) - body states what changed and why, links and
  closes the issue with a `Fixes <REF>` line (the merge then completes the issue; on an imported
  legacy task also keep `Fixes #<number>`), and reports the quality-gate results. `dispatcher pr`
  prints the PR URL, its author, and any commits not attributed to the bot; resolve such a warning
  before reporting. Confirm `git status` shows up to date with origin.
- Your PR will be read by an adversarial AI reviewer before the user sees it. Assume every shortcut
  gets found: no weakened tests, no `any`, no unhandled failure path.
- Do NOT: **create issues, sub-issues included** (only the user creates tasks; report follow-ups in
  your final message instead), open a second PR for part of this task, merge the PR (`gh pr merge`
  or the web UI), close the issue by hand, edit the issue beyond ticking your own task's checkboxes,
  touch its state, claim or delegate, push to the default branch, deploy, run destructive data
  operations (schema migrations against an environment, raw SQL, forced schema pushes), or use
  git restore/checkout to discard changes.
- If you hit a judgement call only the owner can make - an ambiguous requirement with materially
  different readings, a product decision, a premise that looks wrong - park the task per your agent
  instructions instead of guessing: write the question to a file and comment it
  (`dispatcher board comment <REF> --as developer --body-file <path>`), set the task's state to
  Question (`dispatcher board state <REF> question` - a state, not a label, so the row says on its
  own that it is waiting on the owner), release your claim (`dispatcher board release <REF>`), push
  what is worth showing as a draft PR, and report INCOMPLETE with the question.
- If you cannot complete the task, stop and report honestly what is done, what remains, and why.
  Push the branch and open the PR anyway if there is committed work worth showing, and mark it a
  draft (`--draft`).

## Report (your final message is ALL the dispatcher sees - make it complete)
1. STATUS: COMPLETE or INCOMPLETE (COMPLETE requires EVERY checkbox ticked)
2. What was done and why
3. Branch name and the full PR URL
4. Breakdown: each checkbox and whether you finished and ticked it; on a legacy task, each
   sub-issue's identifier and whether you set it Done
5. Quality gates: actual pass/fail result of each
6. How to verify or review the change
7. Follow-up work worth the user's attention, if any - describe it; do NOT file an issue for it
```
