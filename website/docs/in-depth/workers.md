---
title: Workers
description: The developer, reviewer and cleaner agents - what each may do, what it must never do, and what it reports.
---

# Workers

Three agent definitions ship in the plugin. Each is spawned by the dispatcher
with a fully filled-in prompt, runs in a fresh context, and reports in a fixed
format; the report is all the dispatcher sees.

| Agent | Model | Working tree | Board writes | Ends with |
| --- | --- | --- | --- | --- |
| `developer` | opus, xhigh effort | its own git worktree under `.claude/worktrees/` | ticks the checkboxes in its own task's description; legacy sub-issue state; the question-parking writes | `STATUS: COMPLETE` or `INCOMPLETE` |
| `reviewer` | opus, xhigh effort; `Edit`, `Write` and `NotebookEdit` disallowed | none, deliberately: reads the PR through `gh` and `git show origin/<branch>:<path>` | one short verdict comment on the issue; the question-parking writes | `VERDICT: PASS`, `CHANGES_REQUESTED` or `QUESTION` |
| `cleaner` | opus, xhigh effort | its own git worktree | the question-parking writes only | `STATUS: COMPLETE` or `INCOMPLETE`, stating whether any file needed manual resolution |

Every worker shares the standing prohibitions: never create an issue (only you
do; follow-ups are described in the report), never merge, never close an
issue, never push to the default branch, never deploy, never run destructive
data operations, never `git restore` or `git checkout --` to discard changes,
never force-push or rebase a PR branch.

## Developer

Takes one `Ready` or `Changes Requested` issue and lands it as one pull request
into the default branch.

- **Isolation.** Works in its own worktree so several developers run at once.
  A fresh worktree has no dependencies installed; the prompt carries the
  project's install command. It cannot clean its own worktree up (a
  worktree-isolated agent cannot run git against the main checkout, and a
  worktree cannot be removed from inside itself), so its job is to leave
  nothing uncommitted or unpushed for the [pruner](worktrees.md) to trip on.
- **Branch.** `task/<identifier>-<slug>`, given verbatim by the dispatcher.
  The identifier is what maps a branch, a worktree or a PR back to a board
  row and what makes the board link the PR automatically. A resumed branch
  keeps whatever name it has.
- **Identity.** Commits with `dispatcher commit -m "..."` and opens the PR
  with `dispatcher pr --title ... --body-file ...`, never plain `git commit`
  or `gh pr create`, so both are the developer app's ([Two agent
  identities](identities.md)). `dispatcher pr` prints the PR's author and
  any commit not attributed to the bot, and the developer fixes that before
  reporting.
- **Quality.** Follows the project's CLAUDE.md: TDD with the failing test
  first, strong types, every quality gate green. Its PR is read by an
  adversarial reviewer before you see it.
- **Progress.** Ticks each checkbox in the issue description as that piece
  lands. `COMPLETE` requires every box ticked and every gate green.
- **Resuming.** On a `Changes Requested` row it checks out the existing
  branch, reads every review on the PR (yours outrank the AI's, and your
  wording is the spec), addresses every blocking finding, replies to each
  thread, and adds commits without force-pushing.

## Reviewer

Takes one row delegated to the reviewer and hunts for flaws in its PR. It
never writes code and never merges; the bar is high because this is the last
automated gate before your time is spent.

- **Read-only, absolutely.** No edits, checkouts, stashes, installs, or local
  gate runs. It reads files as the PR has them with `git fetch origin
  <branch>` and `git show origin/<branch>:<path>`, and takes gate results
  from CI (`gh pr checks`), because a local run would describe some other
  commit.
- **Method.** Starts from the requirements: unmet acceptance criteria, silent
  scope creep, a ticked checkbox the diff does not deliver. Reads the whole
  diff and around it. Tries to refute correctness. Scrutinizes the tests
  hardest: do they exercise the real path, would they fail if the feature
  broke, was anything weakened or over-mocked. Checks the project's CRITICAL
  rules, the PR plumbing (`Fixes <ref>`, targets the default branch, exactly
  one PR).
- **Where findings go.** One `event: "COMMENT"` review on the PR, posted as
  the reviewer GitHub App with a one-hour token (`GH_TOKEN="$(dispatcher
  token --app reviewer)" gh api .../reviews --input -`), each finding
  anchored to its line and marked blocking or nit. Never `APPROVE`, never
  `REQUEST_CHANGES`: an agent approval must not be able to satisfy a
  required-review rule, and the verdict travels on the report's last line.
  Then one short comment on the issue with the verdict and PR link, tagged
  `--as reviewer`.
- **Honest in both directions.** "No blocking findings" when the work is
  solid, and no rubber-stamping: an empty list means it looked hard.
  `CHANGES_REQUESTED` means at least one blocking finding (correctness bug,
  unmet criterion, violated CRITICAL rule, missing or weakened coverage,
  failing CI). `PASS` is not approval to merge; it means the work is ready
  for you to look at.

## Cleaner

Takes one open PR that conflicts with the default branch and makes it
mergeable again without changing what it does. Exactly one runs at a time, in
a slot of its own, so merge maintenance never competes with the backlog.

- **Scope.** Merge `main` into the branch and resolve the conflicts. No
  features, no refactors, no acting on review findings, even blocking ones;
  another round handles those. A behaviour change the merge genuinely forces
  is made as small as possible, covered by a test, and called out.
- **Merge, never rebase.** A rebase force-pushes and marks every review
  thread outdated.
- **Generated files are regenerated, never hand-merged.** A lockfile is
  resolved by merging the manifests with both sides' entries, discarding the
  conflicted lockfile, and regenerating it with the project's install
  command. A regenerated lockfile that changed any pinned version is a
  finding, not a resolution.
- **Silent semantic conflicts are its primary hunting ground.** A file new on
  the branch has no textual conflict yet may reference an API `main` renamed
  or deleted, and components that ignore unknown props compile and do
  nothing. The prompt names the landmines in the commits being merged;
  typecheck against the merged tree is the detector.
- **Proves nothing was lost.** Diffs every conflicted file against both
  parents; counts test cases and assertions on each parent and the result and
  shows the arithmetic (merged = base + branch delta + main delta).
- **Reports whether any file needed manual resolution**, because the
  dispatcher routes the board on that answer: manual resolution earns a
  merge-scoped review; a clean auto-merge restores the row to where it was.

## Parking a question

All three workers share one escalation path. When the verdict or the work
hinges on a decision only you can make, the worker:

1. writes the question to a file and comments it on the issue
   (`dispatcher board comment <ref> --as <developer|reviewer|cleaner> --body-file <path>`);
2. sets the task's state to `Question` (`dispatcher board state <ref> question`);
3. releases its claim (`dispatcher board release <ref>`), which clears the
   delegate too;
4. preserves what it built (a draft PR for a developer; an un-pushed
   half-merge for a cleaner, rather than pushing a guess);
5. reports `INCOMPLETE` (or `VERDICT: QUESTION`) with the question.

These are the only board writes a worker makes beyond the ones in the table
above. The dispatcher verifies all three happened, fixes any that were missed,
and surfaces the question to you every firing until it is answered.

## What the prompts must carry

The companion skills hold the prompt templates. A developer prompt without any
of these is broken: the checkbox list and the instruction to tick as it goes;
"one PR" stated explicitly; the computed branch name; the `Fixes <ref>` line;
the project's install and quality-gate commands from its CLAUDE.md; on a
resume, the existing branch and PR and your change requests verbatim; the
prohibitions; the report format. A reviewer prompt states the PR's own claims
and tells the reviewer to verify them, names the failure modes worth hunting
for this change, asks for a per-checkbox coverage verdict, lists what is
already known and must not be re-raised, and on a re-review says what was
fixed. A cleaner prompt names the specific renames and deletions that landed
on `main`, includes the loss-proof arithmetic requirement, and states the
out-of-scope rules plainly.

## Worker comments on the board

On Linear every comment goes out under the account the API key belongs to, so
`dispatcher board comment --as <role>` prefixes the body with
`**[developer]**`, `**[reviewer]**`, `**[cleaner]**` or `**[dispatcher]**` on
its first line. An untagged comment is yours. The dispatcher's own claim
comment is a different thing: it reads `**[role]** claimed <stamp> · ...`,
and the CLI keeps it out of the comments a worker prompt embeds.
