---
title: System breakdown
description: The complete technical description of the dispatcher, written for AI agents and maintainers - terse, exact, and in one place.
---

# System breakdown for AI agents

This page is the whole system in one place, written to be read by an AI agent
(or a maintainer) that needs exact names, rules and invariants rather than an
introduction. Raw Markdown:
`https://raw.githubusercontent.com/backside4charter/dispatcher/main/website/docs/ai/system.md`.
Source: `https://github.com/backside4charter/dispatcher`. Setup steps are on
the separate [setup guide](setup.md).

## Components

| Component | Form | Contents |
| --- | --- | --- |
| `dispatcher` binary | one self-contained executable per platform (`windows-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`), built with `bun build --compile` | `board <subcommand>`, `listen`/`status`/`wait`/`consume`, `token`/`identity`/`pr`/`commit`, `review-sync`, `prune-worktrees`, `init`, `version`, `help` |
| Claude Code plugin `dispatcher@dispatcher` | marketplace `backside4charter/dispatcher` on GitHub; enabled per repository in `.claude/settings.json` | skills `dispatcher:start`, `dispatcher:stop`, `dispatcher:spawn-developer`, `dispatcher:spawn-reviewer`, `dispatcher:spawn-cleaner`; agents `dispatcher:developer`, `dispatcher:reviewer`, `dispatcher:cleaner` (all `model: opus`, `effort: xhigh`; the reviewer has `Edit`, `Write`, `NotebookEdit` disallowed) |
| `dispatcher.config.json` | committed at the repository root; also the marker the binary locates the repository by (walk up from cwd) | platform, project ids, state and label names, repository, agent identities, listener port |

Design rules that hold everywhere: all durable state lives on the board and
on GitHub, never in a session; every worker starts in a fresh context; the
board CLI is the only writer of board state and enforces policy; nothing
project-specific is in the binary's source; credentials are looked up, never
configured.

## Board model

Two backends implement one model: Linear (primary) and GitHub Projects v2.
Issue references are the platform's (`ACM-12`, `#480`), accepted in any case.

### Roles

The dispatcher routes on **roles**; the config maps each to a state name.

| Role | Default name | Linear type | Meaning | Who moves rows in |
| --- | --- | --- | --- | --- |
| `backlog` | Backlog | backlog | never dispatched | owner |
| `ready` | Ready | unstarted | never worked; fresh branch | owner |
| `changesRequested` | Changes Requested | started | worked and sent back; has an open PR; outranks Ready | reviewer verdict, review sync, dispatcher |
| `inProgress` | In Progress | started | a developer or the reviewer holds it; the delegate says which | dispatcher |
| `question` | Question | started | parked on an owner decision; question is an issue comment | the worker that parked it |
| `humanReview` | Human Review | started | PR waits on the owner; no delegate | dispatcher after PASS |
| `done` | Done | completed | merged; written by Linear's GitHub automation, never by an agent | owner's merge |

Linear orders columns by type then position; with these types the board reads
Backlog, Ready, Changes Requested, In Progress, Question, Human Review, Done.
A state no role names has role `null`: left alone everywhere, never rolled
back. `board state <ref> done` (any closed state) is refused on an issue
without a parent. There is deliberately no review state: review is `In
Progress` with the delegate set to the reviewer agent.

### Labels

`labels.confirmWithUser` (default `Confirm with user`): agent-workable but the
owner wants a check-in; skipped, mentioned once. `labels.ui` (default `UI`):
design-sensitive; carried into prompts. A label named `question` is refused
(retired; it is a state now).

### Delegate and claim

- **Delegate** = the Linear agent user the issue is delegated to
  (`linear.agents.developer` or `.reviewer`): which agent *phase* the row is
  in; survives sessions. `dev` and `cleanup` claims delegate to the developer
  agent, `review` claims to the reviewer agent.
- **Claim** = one comment on the issue,
  `` **[developer]** claimed 2026-08-27T14:05Z · `claude --resume <session-id>` ``
  (tag `developer`/`reviewer`/`cleaner`): which *session* works it now; the
  UTC-minute stamp is the heartbeat. Re-claiming edits this comment in place.
  Age is computed from the stamp text, never from the platform's `updatedAt`.
  Stale = older than `claimStaleMinutes` (default 90) and not this session's.
- Delegating on Linear sets the assignee to the API key's account, so
  **human-owned = assignee set and delegate null**. `release` clears both.
  Ready rows: shown as `assignee` and `delegate` columns, read together.
- A delegate that is neither configured agent is another agent's row: skipped;
  `claim`, `assign` and `release` refuse to touch it.
- On GitHub Projects the claim is the text field `Claimed By` holding
  `dev:<session>@<stamp>`; there is no delegate.

| Row | Meaning | Action |
| --- | --- | --- |
| In Progress, delegate developer, no/stale claim | queued for a developer | dispatch developer (tier 1) |
| In Progress, delegate reviewer, no/stale claim, open non-draft PR | queued for review | dispatch reviewer |
| any, fresh claim of another session | live worker | leave alone |
| Human Review or Question, no delegate | owner's | leave alone |

### Eligibility

Given the milestone set the loop was started with, in order:

1. `Backlog` and `Question`: never.
2. Assignee set and delegate null: human-owned, skip.
3. Delegate not one of the two agents: skip.
4. Parent issue in the same milestone: skip (the parent is the unit).
5. Fresh claim from another session: skip.
6. Queue by state: reviewer queue (In Progress + reviewer delegate + open
   non-draft PR); developer tier 1 (In Progress + developer delegate or
   none); tier 2 `Changes Requested`; tier 3 `Ready`. Tiers 2 and 3 also
   require no `Confirm with user` label, no open blocker, no "needs human
   attention" comment. Board order ranks within a tier only. Blocked means a
   blocking issue is still open, i.e. its PR has not merged.

### Poll output

`board poll <milestone>...` prints TSV in board order:
`milestone state delegate claim issue labels assignee blockers prs parent subs title`;
`claim` renders `dev:<session>@<stamp>(<age>m)`; `prs` lists linked PRs;
`parent`/`subs` (`closed/total`) populate only on legacy tasks with
sub-issues. A PR whose branch and body both miss the identifier is found with
`board pr-issues <pr>` and attached with `board link-pr <ref> <pr>`.

## Task lifecycle

### Transitions

| From | To | Writer | Trigger / command |
| --- | --- | --- | --- |
| Backlog | Ready | owner | decides it is ready |
| Ready | In Progress (developer) | dispatcher | `board claim <ref> dev`, `board state <ref> in-progress`, spawn |
| In Progress (developer) | In Progress (reviewer) | dispatcher | developer COMPLETE and verified: `board assign <ref> reviewer` (moves delegate, deletes claim) |
| In Progress (reviewer) | Human Review | dispatcher | `VERDICT: PASS` and no unaddressed owner change request: `board state <ref> human-review`, `board release <ref>` |
| In Progress (reviewer) | Changes Requested | dispatcher | `VERDICT: CHANGES_REQUESTED`, or PASS overridden by an owner change request: `board state <ref> changes-requested`, `board release <ref>` |
| Human Review | Changes Requested | review sync (CI) | owner submits a "Request changes" review |
| Changes Requested | In Progress (developer) | dispatcher | dispatch resuming the existing PR and branch |
| In Progress | Question | worker | comment question, `board state <ref> question`, `board release <ref>` |
| Question | Ready or Changes Requested | owner | replies on the issue and moves the row |
| Human Review | Done | owner's merge | Linear GitHub automation, PR merged -> Done |

Never written by an agent: `Done` on a top-level task; any move out of
`Backlog` or `Question`. Every state write first re-checks the PR: if it
reads `MERGED`, write nothing, release the claim, report.

### Rework

Everything that sends work back lands in `Changes Requested`, never `Ready`.
The next developer checks out the existing branch, reads every review surface
(`gh pr view <N> --comments`, `gh api repos/<o>/<r>/pulls/<N>/reviews`,
`.../pulls/<N>/comments`), addresses every blocking finding (owner requests
outrank the AI's and are carried verbatim), replies per thread, adds commits,
never force-pushes. Changes Requested outranks Ready in the queue. A `Ready`
row with an open PR is a board error: treat as rework and set Changes
Requested. A `Changes Requested` row with no PR: comment "needs human
attention" and skip.

### Questions

A worker that hits a decision only the owner can make (ambiguous requirement
with materially different readings, product call, breaking change, wrong
premise; not anything settled by reading code or with an obvious default):

1. `board comment <ref> --as <developer|reviewer|cleaner> --body-file <path>`
   with the decision, options with consequences, recommendation.
2. `board state <ref> question`.
3. `board release <ref>` (clears delegate too).
4. Push what is worth showing as a draft PR (developer); leave a half-merge
   unpushed (cleaner).
5. Report `INCOMPLETE` / `VERDICT: QUESTION`.

The dispatcher verifies the three writes, fixes any missed, and repeats the
question in its status text every firing. The owner answers by replying on
the issue and moving the row to Ready (no PR) or Changes Requested (PR
exists); the next prompt carries question and answer verbatim. A row moved
out of Question without a reply is not dispatched.

### One task, one PR

A task is exactly one branch `task/<identifier-lowercased>-<short-slug>` and
one PR whose body carries `Fixes <IDENTIFIER>` (plus `Fixes #<n>` for an
imported legacy issue). Steps are a Markdown checkbox list in the issue
description; the developer ticks boxes as pieces land (the one sanctioned
issue edit); review is gated on every box ticked. Issue text demanding split
PRs is overridden and flagged. Nobody but the owner creates issues,
sub-issues included; follow-ups are reported in prose.

### Legacy sub-issues

Tracking only. A child whose parent is in the milestone is never dispatched.
The developer sets its own task's children `in-progress` / `done` as it builds
them (allowed because they have a parent and no PR); the dispatcher reconciles
the child table against the report before review and re-reads it on every
dispatch against such a task.

## The loop

`dispatcher:start <milestone>...` runs as Claude Code `/loop` dynamic mode in
one session. Milestones are the only scope filter; poll names every one of
them. Recommended session model: `claude --model opus --effort low`; workers
pin their own model.

### Wake signals

Worker completion notifications (primary); the background `dispatcher wait`
exiting (event channel); `ScheduleWakeup` fallback (1800 s while workers run,
60 s when drained). The re-arm prompt is
`/loop /dispatcher:start <milestones...>` plus the last swept `main` SHA.

### One firing

1. `dispatcher consume` (hints only).
2. Process every finished worker (routes below).
3. Re-stamp this session's live claims (`board claim` again).
4. `board poll <all milestones>`; top up: reviewer queue first (cap 2), then
   developer tiers (cap 2), claim-then-spawn until a cap or no eligible row.
5. Freshen open PRs behind `main` (only when `main` moved; max 5).
6. Spawn the cleaner at a conflicting PR if none is running (own slot, cap 1).
7. Stranded-row scan, project-wide: `board claims`.
8. `dispatcher prune-worktrees`.
9. One-line status; re-arm `ScheduleWakeup` and `dispatcher wait`.

Caps: 2 developers, 2 reviewers, 1 cleaner, 5 total. Poll every firing; keep
topping up until a cap or out of work.

### Dispatch

`board issue <ref>` (description, checkboxes, sub-issues, blockers, last 10
comments; `--comments 30` for long threads); on a resume read every review on
the PR. Then `board claim <ref> <dev|review|cleanup>`, `board state <ref>
in-progress` (developer/cleaner; a review keeps In Progress), then the Agent
tool: `dispatcher:developer` with `isolation: "worktree"`,
`dispatcher:reviewer` with no worktree, `dispatcher:cleaner` with a worktree;
all `run_in_background: true`. Never fall back to a general-purpose agent.

### Routing a developer's result

1. PR `MERGED`: write nothing, release, report.
2. Verify: PR exists, targets `main`, not draft, author `app/<developer
   slug>`, CI green (`gh pr checks <N> --watch` if pending), linked to the
   issue (`board link-pr` if not), every checkbox ticked, legacy children
   reconciled.
3. Verified: comment PR link + how to verify (`--as dispatcher`), then `board
   assign <ref> reviewer`.
4. Failed once: comment progress notes; retry once with failure context,
   existing branch and PR.
5. Failed twice: comment `needs human attention: 2 failed dispatcher
   attempts - <reason>`, leave In Progress, release, skip.
6. Parked: verify the parking writes; surface the question every firing.

### Routing a reviewer's verdict

| Report | Action |
| --- | --- |
| PR already `MERGED` | write nothing, release, still report findings |
| `VERDICT: PASS`, no unaddressed owner change request (filter reviews by the reviewer bot's login; the rest with a body are the owner's) | `board state <ref> human-review`, `board release <ref>`, comment verdict + PR link |
| `VERDICT: PASS` with an unaddressed owner change request | as CHANGES_REQUESTED, requests carried verbatim |
| `VERDICT: CHANGES_REQUESTED` | `board state <ref> changes-requested`, `board release <ref>`, one comment with PR link; PR stays open |
| `VERDICT: QUESTION` | verify parking writes; surface every firing |
| no verdict / failed | retry once, then comment "needs human attention: AI review failed twice", leave delegated to the reviewer |

No cap on review rounds. Report open-PR counts from `gh pr list --state
open`, never from counting Human Review rows.

### Routing a cleaner's result

PR `MERGED`: write nothing. Verify `MERGEABLE`, CI green, commits attributed
to the developer bot. Any file needed manual resolution: `board assign <ref>
reviewer` for a merge-scoped review. Nothing conflicted: restore the state and
delegate it came from. Never promote past where it was. Unresolvable conflict:
the cleaner parks a Question. Other failure: comment `needs human attention:
conflict resolution failed - <reason>`, restore, release, no retry until head
or `main` moves.

### Maintenance every firing

- **Freshen PRs.** Check `gh api repos/<o>/<r>/commits/main --jq .sha` against
  the last swept SHA; if moved, for open PRs measure `gh api
  repos/<o>/<r>/compare/main...<head> --jq .behind_by` (never
  `mergeStateStatus`; re-query `mergeable` if `UNKNOWN`). Skip PRs not authored
  by the developer app, branches checked out in any local worktree (`git
  worktree list`), drafts; conflicting ones go to the cleaner. Update by merge
  through the app token, most-behind first, max 5:
  `GH_TOKEN="$(dispatcher token)" gh api -X PUT repos/<o>/<r>/pulls/<N>/update-branch -f expected_head_sha=<sha>`.
  Never rebase or force-push. A 422 means conflict.
- **Conflicts.** Scan open PRs (not board rows), re-query `mergeable` after a
  pause, skip drafts, worktree-held branches, claimed issues, and (head,
  `main`) pairs already attempted; owner PRs are in scope. Order by
  `behind_by` desc. Claim `cleanup`, set In Progress, record prior state and
  delegate.
- **Stranded rows.** `board claims` kinds: `own-claim`, `claim` (another live
  session), `stale-claim`, `queued` (delegate, no claim), `question`. Stale +
  reviewer delegate + open PR: steal (`board claim <ref> review`) and dispatch
  the review whatever the milestone. Stale In Progress inside scope: normal
  tier 1. Stale outside scope or anything else: release and surface. Every
  `question` row: surface.
- **Prune.** `dispatcher prune-worktrees`; non-zero exit means git still
  lists a worktree it tried to remove: report.

### Status text

Each firing ends in exactly one: **at a cap** (what is running), **out of
work** (polled now; why nothing qualified), **blocked on the owner** (PR count
from `gh pr list`). Also surface: Question rows in full, stolen stale claims,
skipped `Confirm with user` rows, worker follow-ups (never filed as issues),
PRs not updated or conflicting. Count from queries in the same turn.

### Stopping

`dispatcher:stop` (drain) or `dispatcher:stop now` (abort), in the loop's
session: `ScheduleWakeup stop:true` first; `TaskStop` the waiter; inventory
`board claims` (`own-claim` and `queued` rows this session dispatched); drain
(run completion sections, no top-up) or abort (`TaskStop` workers, prune,
restore rows); release with `board release <ref> --session <id>`. Restore
table: `dev` claim without PR -> `ready`; with open PR -> `changes-requested`;
PR merged -> nothing; `review` claim -> `board assign <ref> reviewer` only
(never release: an undelegated In Progress row is developer tier 1);
`cleanup` -> the recorded prior state and delegate. Never touch another
session's fresh claim; never stop the listener.

## Workers

Shared prohibitions: never create issues, merge, close issues, push to the
default branch, deploy, run destructive data operations, `git restore` /
`git checkout --`, force-push or rebase a PR branch. The final message is the
only thing the dispatcher sees.

### Developer

Own worktree under `.claude/worktrees/` (`isolation: "worktree"`; a fresh
worktree needs the project's install command first; it cannot remove itself).
Branch `task/<id>-<slug>` from an up-to-date origin default branch, or the
existing branch on a resume. Follows the project CLAUDE.md: TDD, strong types,
all gates green. Commits with `dispatcher commit -m|-F`, opens with
`dispatcher pr --title ... --body-file ... [--draft]` (never `git commit` /
`gh pr create`); `dispatcher pr` reports author and unattributed commits.
Ticks checkboxes as it goes; legacy children `in-progress`/`done`. Report:
`STATUS: COMPLETE|INCOMPLETE`, what was done, branch and PR URL, per-checkbox
outcome, gate results, how to verify, follow-ups described.

### Reviewer

No worktree; read-only. Reads through `gh pr view/diff`, `gh api
.../pulls/<N>/files`, and `git fetch origin <branch>` + `git show
origin/<branch>:<path>`; gate results from CI (`gh pr checks`), never local
runs. Method: requirements first (unmet criteria, scope creep, ticked box not
delivered), whole diff plus surroundings, refute correctness, scrutinise
tests, project CRITICAL rules, PR plumbing (`Fixes <ref>`, targets default,
exactly one PR). Posts one review as the reviewer app:
`GH_TOKEN="$(dispatcher token --app reviewer)" gh api repos/<o>/<r>/pulls/<N>/reviews --input -`
with `event: "COMMENT"` only (never APPROVE / REQUEST_CHANGES), findings
line-anchored and marked blocking or nit; then one short issue comment `--as
reviewer`. If the token fails, stop; never fall back to the owner's auth.
Last line exactly `VERDICT: PASS|CHANGES_REQUESTED|QUESTION`;
CHANGES_REQUESTED on any blocking finding (correctness bug, unmet criterion,
violated CRITICAL rule, missing/weak tests, failing CI).

### Cleaner

Own worktree; one at a time. Merge `origin/main` into the PR branch (never
rebase), keep both sides' intent, regenerate generated files and lockfiles
(manifests merged both sides first; a changed pinned version is a finding),
hunt silent semantic conflicts (files new on the branch against renamed or
removed APIs; typecheck is the detector), prove nothing lost (diff against
both parents; count test cases and assertions: merged = base + branch delta +
main delta). No feature work, no acting on review findings. Commits as the
developer app, `git push origin HEAD`, never `dispatcher pr`. Report: files
conflicted and how resolved, whether any manual resolution (routes the board),
semantic conflicts found and method, loss arithmetic, gates, mergeable state.

### Prompt must-haves

Developer: task and issue URL; computed branch; checkbox list + tick-as-you-go
instruction; "one PR" explicit; `Fixes <ref>`; project install and gate
commands from its CLAUDE.md; on resume the PR, branch, owner requests verbatim,
no force-push; prohibitions; report format. Reviewer: the PR's own claims to
verify, failure modes to hunt, per-checkbox coverage verdict, known issues not
to re-raise, re-review deltas, parking path, `COMMENT`-only rule. Cleaner: PR,
branch, `behind_by`, landmines in the merged commits, semantic-conflict
warning, loss arithmetic requirement, out-of-scope statement, issue
identifier, gates.

Comments: on Linear every comment posts under the API key's account;
`board comment --as <role>` prefixes `**[<role>]**` (roles `dispatcher`,
`developer`, `reviewer`, `cleaner`). Untagged comments are the owner's.

## Claims

`board claim <ref> <dev|review|cleanup> [--session <id>]`: writes delegate
first, then creates or edits the claim comment (session from `--session`,
else `CLAUDE_CODE_SESSION_ID`, else `unknown-<random>`). Last-writer-wins:
poll, then claim from that poll. `board assign <ref> <developer|reviewer>`:
moves delegate, deletes the claim comment (handoff, no session). `board
release <ref> [--session <id>]`: deletes the comment and clears delegate and
assignee; with `--session`, another session's claim is left alone, but a row
with no claim is still cleared. Exactly one of `assign`/`release` follows
every processed result. Two dispatchers coexist by claim-before-spawn, own
re-stamps only, stale-only stealing, `--session` on release, and the waiter
lock.

## Agent identities

Two GitHub Apps because GitHub forbids approving one's own PR: **developer**
authors commits, opens PRs, and is the identity of freshness-sweep merge
commits; **reviewer** posts reviews. Auth: RS256 JWT (iat-60 s, exp 9 min,
iss = appId) signed with the app's PEM, exchanged at
`POST /app/installations/<installationId>/access_tokens` for a 1-hour token;
never cached.

| Command | Behaviour |
| --- | --- |
| `dispatcher commit (-m <msg> \| -F <file>)` | `git -c user.name=<botLogin> -c user.email=<botUserId>+<botLogin>@users.noreply.github.com commit ...`; per-invocation, no repo config change |
| `dispatcher pr --title <t> [--body-file <p> \| --body <t>] [--base main] [--head <cur>] [--repo o/n] [--draft]` | `POST /repos/<o>/<r>/pulls` as the developer app via REST (not `gh pr create`: `GET /user` 403s for installation tokens); refuses head == base; prints URL, `opened by:`, and attribution warnings for commits whose GitHub author id != `botUserId` |
| `dispatcher token [--app developer\|reviewer]` | prints the token only; bare `--app` is an error |
| `dispatcher identity [--app ...]` | prints installation permissions, account, repository selection, bot login, expected git email, token expiry |

Rules: reviewer reviews are `COMMENT` only; `gh api` not `gh pr review` under
app tokens; `GH_TOKEN` scoped to one command; a PR authored by the owner is
sent back to be reopened with `dispatcher pr`; `botUserIds` excludes bot
reviews from the review sync and bot senders from the event channel.

## Event channel

Accelerator only; the loop runs at polling latency without it.

- `dispatcher listen [--port n] [--no-forward] [--org o] [--events a,b]
  [--no-linear] [--linear-poll-ms n>=1000] [--config p] [--platform x]
  [--dir p]`: loopback HTTP on `listener.port` (default 47831); `POST
  /webhook` accepts GitHub deliveries, `GET /healthz`; supervises `gh webhook
  forward --org=<repo owner> --events=pull_request,pull_request_review
  --url=...` with exponential backoff (5 s to 300 s); on Linear polls the
  project every 30 s (issues `updatedAt > last`, comments `createdAt >
  start`) and diffs state, assignee, labels, milestone, order, parent,
  links, title; heartbeat every 15 s.
- State dir `.claude/dispatcher/` beside the nearest config (`--dir`,
  `DISPATCHER_STATE_DIR`): `events.jsonl`, `cursor.json`, `listener.json`
  (heartbeat; stale after 60 s or dead pid = down), `waiter.json` (lock).
- `dispatcher status [--dir]`: exit 0 up / 1 down; prints forward and poller
  health and pending count.
- `dispatcher wait [--timeout-seconds 1740] [--debounce-ms 5000] [--poll-ms
  1000]`: exits 0 with first line `wake: N new board event(s)` |
  `timeout: ...` | `channel-down: <reason>` | `already-waiting: ... (pid N)`;
  never consumes. On `channel-down` do not re-arm this firing; on
  `already-waiting` do not arm.
- `dispatcher consume [--dir]`: prints pending events, advances the cursor.
- Filters: bot senders dropped; `pull_request` actions opened, reopened,
  closed, ready_for_review, converted_to_draft; `pull_request_review`
  submitted; the claim comment excluded from comment events; on `platform:
  github` also `projects_v2_item`, `issues`, `issue_comment`, `sub_issues`
  with `Claimed By` edits dropped.
- Machine setup: `gh extension install cli/gh-webhook`; `gh auth refresh -h
  github.com -s admin:org_hook`; the Linear API key for the poller.

## Review sync

`dispatcher review-sync` in a GitHub Actions workflow on
`pull_request_review: [submitted]`, reading `GITHUB_EVENT_PATH`:

1. Not `submitted` -> exit 0 `not-submitted`.
2. State != `changes_requested` -> exit 0 `not-a-change-request`.
3. Reviewer id in `botUserIds` -> exit 0 `bot-reviewer`.
4. Resolve PR -> issues (Linear attachment; identifier in head/title/body;
   `Fixes #n` legacy GitHub issue URL attachment).
5. Per issue: closed -> skip; role not `humanReview` and not (`inProgress`
   with reviewer delegate) -> skip; else `setState(changesRequested)` then
   `release`.

API failure exits 1. Needs `LINEAR_API_KEY` (or `GH_TOKEN` with `project`
scope on GitHub Projects). The dispatcher does not re-implement this as a
poll.

## Worktrees

`dispatcher prune-worktrees [--dry-run]`, run every firing and after every
completion, from any directory in the repo (operates on the main checkout via
`--git-common-dir`). Per registered worktree: keep the main checkout; keep
anything outside `.claude/worktrees/`; keep if locked and the lock's pid is
alive or absent (reclaim, logged, if the pid is dead); keep if uncommitted or
untracked files; keep if unpushed commits (no upstream: any own commit); else
`git worktree unlock` + `remove`. Then re-list and delete directories under
`.claude/worktrees/` git no longer tracks. Exit 1 only if a removal is still
registered. Refuses to plan from a list without a main worktree.

## CLI

Global for board commands: `dispatcher board [--config <path>] [--platform
linear|github] <subcommand>`; config from `--config`, `DISPATCHER_CONFIG`,
else nearest `dispatcher.config.json` upward from cwd. Errors exit 2.

| Subcommand | Effect |
| --- | --- |
| `config` | resolved config: path, platform, repository, project, role -> state names, labels, stale minutes |
| `states` | `name role closed id` |
| `milestones` | `milestone open` (+ `(none)`) |
| `poll <m>... [--all] [--all-milestones]` | rows, see Poll output |
| `issue <ref> [--comments n] [--json]` | Markdown detail (claim comment excluded from comments) |
| `claims [--session id]` | `kind milestone state delegate claim age-min issue title` |
| `pr-issues <pr\|url>` | `issue state via title` |
| `state <ref> <role\|name>` | roles `backlog ready changes-requested in-progress question human-review done` (`hold`, `user-review` aliases; `ai-review` refused); refuses closing a parentless issue |
| `claim <ref> <dev\|review\|cleanup> [--session id]` | write/re-stamp |
| `assign <ref> <developer\|reviewer>` | handoff |
| `release <ref> [--session id]` | clear |
| `comment <ref> --as <role> --body-file <p>` | tagged comment |
| `label <ref> add\|remove <name>` | existing labels only |
| `link-pr <ref> <url\|n>` | Linear attachment (GitHub: explains `Fixes #N`) |

Other commands: `listen`, `status`, `wait`, `consume`, `token`, `identity`,
`pr`, `commit`, `review-sync`, `prune-worktrees`, `init` (interactive setup;
non-interactive when nothing needs asking, then a checklist verifier; exit 1
if it would need a terminal), `version`, `help`. Exit codes: 0 ok; 1 `status`
down, `pr`/`review-sync`/`init`/`prune` failures; 2 usage or board errors.

## Configuration

```json
{
  "platform": "linear",
  "repository": "acme/widgets",
  "botUserIds": [100000001, 100000002],
  "claimStaleMinutes": 90,
  "listener": { "port": 47831 },
  "githubApps": {
    "developer": { "appId": 111111, "installationId": 10000001, "slug": "acme-developer", "botLogin": "acme-developer[bot]", "botUserId": 100000001 },
    "reviewer":  { "appId": 222222, "installationId": 10000002, "slug": "acme-reviewer",  "botLogin": "acme-reviewer[bot]",  "botUserId": 100000002 }
  },
  "linear": {
    "workspace": "acme",
    "teamId": "team-1",
    "teamKey": "ACM",
    "projectId": "proj-1",
    "projectUrl": "https://linear.app/acme/project/widgets-0a1b2c3d4e5f",
    "states": { "backlog": "Backlog", "ready": "Ready", "changesRequested": "Changes Requested", "inProgress": "In Progress", "question": "Question", "humanReview": "Human Review", "done": "Done" },
    "agents": { "developer": "<linear user id of the developer agent app>", "reviewer": "<linear user id of the reviewer agent app>" },
    "labels": { "confirmWithUser": "Confirm with user", "ui": "UI" }
  },
  "github": {
    "owner": "acme", "projectNumber": 2, "projectId": "PVT_...", "statusFieldId": "PVTSSF_...", "claimedByFieldId": "PVTF_...",
    "states": { "backlog": { "name": "Hold", "optionId": "..." }, "ready": { "name": "Ready", "optionId": "..." }, "changesRequested": { "name": "Changes Requested", "optionId": "..." }, "inProgress": { "name": "In Progress", "optionId": "..." }, "humanReview": { "name": "User Review", "optionId": "..." }, "done": { "name": "Done", "optionId": "..." } },
    "labels": { "confirmWithUser": "confirm-with-user", "ui": "ui" }
  }
}
```

Rules: `platform` selects the section, which must exist (`--platform` /
`DISPATCHER_BOARD_PLATFORM` override per command); `repository` is
`owner/name` (owner = webhook org); `botUserIds` may be empty; `listener`,
`githubApps`, and the unused platform section are optional; `github.states.
question` is optional, every other role required; per app `keyFile` (default
`<slug>.private-key.pem`) and `keyEnvVar` (default
`DISPATCHER_GITHUB_APP_KEY_<ROLE>`) are optional. Validation reports every
violation at once with field paths. State names are resolved against the live
board on every write; a rename fails loudly.

## Credentials and environment

| Credential | Lookup |
| --- | --- |
| Linear API key | `LINEAR_API_KEY`, else `.secrets/api-keys.json` in the main checkout: `{"Linear": "lin_api_..."}` |
| GitHub board (Projects v2) | caller's `gh` auth; `GH_TOKEN` in CI |
| App private keys | `<keyEnvVar>`, else `.secrets/<keyFile>` in the main checkout (resolved via `git rev-parse --git-common-dir`, so it works from any worktree) |
| Org webhooks | `gh` auth with `admin:org_hook` |

Environment: `LINEAR_API_KEY`, `DISPATCHER_CONFIG`, `DISPATCHER_BOARD_PLATFORM`,
`DISPATCHER_STATE_DIR`, `DISPATCHER_GITHUB_APP_KEY_DEVELOPER|REVIEWER`,
`CLAUDE_CODE_SESSION_ID`, `GITHUB_EVENT_PATH`, `GH_TOKEN`; installer-only
`DISPATCHER_VERSION`, `DISPATCHER_INSTALL`. Files: `.secrets/` gitignored;
`.claude/dispatcher/` gitignored; `.claude/settings.json` committed with
`extraKnownMarketplaces.dispatcher = { source: { source: "github", repo:
"backside4charter/dispatcher" } }` and `enabledPlugins["dispatcher@dispatcher"]
= true`.

## Platform setup facts

### Linear

Seven team states with the types in the Roles table (`Done` must be a
`completed` type); two labels; two agent app users (OAuth applications with
agent capability, installed with `actor=app`, needing access to the team);
their ids via `{ users(filter: { app: { eq: true } }) { nodes { id name
displayName } } }`; GitHub integration connected to the repository with the
team automation *PR merged -> Done* on and closing magic words recognised;
personal API key of the acting account (all comments post under it). Linear
paints the default-named states grey `#bec2c8`, blue `#0079d4`, red
`#eb5757`, yellow `#f2c94c`, purple `#9b51e0`, pink `#ff7cb9`, green
`#00a81c` in board order.

### GitHub Apps

Register two apps (webhook inactive). Developer permissions: Contents
read/write, Pull requests read/write. Reviewer: Pull requests read/write.
Install both on the organization (installation id in the installation URL).
Generate a private key each; store as `.secrets/<slug>.private-key.pem`. Ids:
`appId` from the app page; `slug` from its URL; `botLogin` = `<slug>[bot]`;
`botUserId` = `gh api "users/<slug>%5Bbot%5D" --jq .id`. Verify with
`dispatcher identity [--app reviewer]`. Rulesets restricting pushes must
allow the developer app.

### GitHub Projects v2 backend

Org-level project with a `Status` single-select (one option per role;
`question` optional) and a `Claimed By` text field; repository milestones and
labels. Ids via `gh api graphql` (`organization.projectsV2`, `ProjectV2.fields`
with `options`). Refs are `#N`; claims live in `Claimed By`; no delegate; PRs
link only via `Fixes #N`; board access is the caller's `gh` auth; the event
channel forwards the board's own webhooks; review sync needs a `GH_TOKEN` with
`project` scope.

## Development

Bun pinned exactly in `.bun-version` (the compiled binary embeds the runtime;
`scripts/compile.ts` enforces the pin); every dependency exact; new
dependencies need a supply-chain check and approval. `just check` (tsc +
vitest) must be green; `just run <cmd>` runs from source; `just compile
[all]`; `just docs` / `just docs-build` for this site (Docusaurus under
`website/`, own lockfile, deployed by `.github/workflows/docs.yml`). Layout:
`src/main.ts` sole entrypoint (no module-level execution guards elsewhere);
`src/cli.ts` event channel; `src/board-cli.ts` + `src/board/**` board model
and backends; `src/github/**` apps, token, pr, commit;
`src/review-status-sync*.ts`; `src/worktree-prune*.ts`; `src/init/**`;
`src/testing/**` fictional `acme/widgets` fixtures; `skills/`, `agents/` the
plugin. Never resolve paths from `import.meta.url` at runtime. Releases: bump
`package.json`, tag `v<version>`, push; the release workflow compiles every
target and publishes. Tags are never moved.
