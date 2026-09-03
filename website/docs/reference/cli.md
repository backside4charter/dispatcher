---
title: CLI reference
description: Every dispatcher command, its flags, its output and its exit codes.
---

# CLI reference

```
dispatcher <command> [options]
```

Every command finds the repository by walking up from the working directory
to the nearest `dispatcher.config.json` (`--config <path>` or
`DISPATCHER_CONFIG` overrides it). Errors print to stderr and exit 2 unless
stated otherwise, so a skill sees the reason in its output.

| Command | Group |
| --- | --- |
| [`board <subcommand>`](#board) | the task board |
| [`listen`](#listen), [`status`](#status), [`wait`](#wait), [`consume`](#consume) | the event channel |
| [`token`](#token), [`identity`](#identity), [`pr`](#pr), [`commit`](#commit) | agent GitHub App identities |
| [`review-sync`](#review-sync) | CI hook |
| [`prune-worktrees`](#prune-worktrees) | worktree cleanup |
| [`init`](#init) | repository setup |
| `version`, `help` | |

## board

```
dispatcher board [--config <path>] [--platform linear|github] <subcommand> [options]
```

The global flags come first. `--platform` (or `DISPATCHER_BOARD_PLATFORM`)
overrides the config's platform for one command; the named section must
exist. `<ref>` is the platform's issue reference in any case (`acm-12`,
`ACM-12`, `#480`, `480`). Output is tab-separated, one row per line, or
Markdown; it is written to be read by an agent.

### Reads

| Subcommand | Output |
| --- | --- |
| `config` | the resolved config path, platform, repository, project, the state name for each role, the label names, and the staleness window |
| `states` | `name  role  closed  id` for every workflow state on the board, in board order; role is `-` for a state no role claims |
| `milestones` | `milestone  open` with open-issue counts, plus `(none)` when open issues carry no milestone |
| `poll <milestone>... [--all]` | one row per open issue in those milestones, board order: `milestone state delegate claim issue labels assignee blockers prs parent subs title`. `--all` includes closed issues; `--all-milestones` replaces the names |
| `issue <ref> [--comments <n>] [--json]` | one issue as Markdown for a worker prompt: header (URL, state, milestone, labels, assignee with a human-owned / agent-workable verdict, delegate, claim, GitHub issue, PRs, parent, blockers), a `## Sub-issues` table when there are any, the description verbatim, and the last `n` comments (default 10, `0` for none). `--json` prints the raw record. The claim comment is reported as the claim and left out of the comments |
| `claims [--session <id>]` | every open issue carrying a claim or a delegate, project-wide, plus every `Question` row: `kind milestone state delegate claim age-min issue title`, kind being `own-claim`, `claim`, `stale-claim`, `queued` or `question` |
| `pr-issues <pr-number\|url>` | the board issues a PR belongs to: `issue state via title`, via being `attachment`, `identifier` or `github-issue` |

### Writes

| Subcommand | Effect |
| --- | --- |
| `state <ref> <state>` | moves the issue. `<state>` is a role (`backlog`, `ready`, `changes-requested`, `in-progress`, `question`, `human-review`, `done`; `hold` and `user-review` are accepted aliases) or the platform's display name. Refuses `done` (any closed state) on an issue with no parent: the owner's merge completes a top-level task. Refuses the retired `ai-review` role with a pointer to `assign`. Prints `ACM-12: Ready -> In Progress` or `ACM-12 already at In Progress` |
| `claim <ref> <dev\|review\|cleanup> [--session <id>]` | delegates the issue to the role's agent and writes or re-stamps the claim comment. Session id from `--session`, else `CLAUDE_CODE_SESSION_ID`, else `unknown-<random>`. Prints what it replaced. Refuses a delegate that is not one of the configured agents |
| `assign <ref> <developer\|reviewer>` | sets the delegate and deletes any claim comment: the row is queued for that agent with nobody on it. Prints the previous agent and the cleared claim |
| `release <ref> [--session <id>]` | clears the claim comment and the delegate (and the assignee delegation set). With `--session`, a claim from a different session is left alone and reported; a row with no claim is still cleared. Idempotent |
| `comment <ref> --as <role> --body-file <path>` | posts the file's contents as a comment prefixed with `**[<role>]**`; roles are `dispatcher`, `developer`, `reviewer`, `cleaner`. Prints the comment URL |
| `label <ref> add\|remove <label name>` | adds or removes one existing label by name (case-insensitive lookup); the owner creates labels. Refuses the retired `question` label. Prints the resulting label list |
| `link-pr <ref> <pr-url\|number>` | attaches a pull request to the issue through Linear's GitHub integration so the merge completes it. On GitHub Projects it explains that PRs link through `Fixes #N` |

## listen

```
dispatcher listen [--port <n>] [--no-forward] [--org <org>] [--events <a,b,c>]
                  [--no-linear] [--linear-poll-ms <n>] [--config <path>]
                  [--platform linear|github] [--dir <path>]
```

Starts the loopback webhook listener, the supervised `gh webhook forward`
child (unless `--no-forward`) and, on Linear, the board poller. Runs until
SIGINT or SIGTERM; a clean stop removes the heartbeat so the channel reads as
down immediately. See [Event channel setup](../setup/event-channel.md).

## status

```
dispatcher status [--dir <path>]
```

Prints listener liveness, forward and Linear poller health, counters, and the
number of unconsumed events. Exit 0 when the listener is up, 1 when down.

## wait

```
dispatcher wait [--timeout-seconds <n>] [--debounce-ms <n>] [--poll-ms <n>] [--dir <path>]
```

Blocks until new board events land in the log, then exits 0 with one of four
first lines: `wake: N new board event(s)` (followed by the events),
`timeout: ...` (default 1740 s), `channel-down: <reason>`, or
`already-waiting: another waiter (pid N) is already running`. Never consumes.
Defaults: 5000 ms debounce after the last event, 1000 ms poll.

## consume

```
dispatcher consume [--dir <path>]
```

Prints every pending event as `[receivedAt] summary` and advances the cursor
past them, or `no pending events`.

## token

```
dispatcher token [--app developer|reviewer]
```

Mints a one-hour installation access token for the app (default `developer`)
and prints the token and nothing else, so it pipes straight into `GH_TOKEN`.
A bare `--app` is an error. Needs the `githubApps` section and the app's
private key.

## identity

```
dispatcher identity [--app developer|reviewer]
```

Prints JSON describing the app's installation: slug, app id, installation id,
account, repository selection, granted permissions, the bot login, the git
author email commits must carry, and the minted token's expiry.

## pr

```
dispatcher pr --title <t> [--body-file <p> | --body <t>] [--base <b>] [--head <b>]
              [--repo <owner/name>] [--draft]
```

Opens a pull request as the developer app through the REST API. `--head`
defaults to the current branch, `--base` to `main`, `--repo` to the `origin`
remote. Refuses to open a PR from the base into itself. Prints the PR URL,
`opened by: <login> (<type>)` with a warning if the author is not the bot, and
either `all commits attributed to <bot>` or a warning listing each commit that
is not. Exit 1 on failure.

## commit

```
dispatcher commit (-m <message> | -F <file>)
```

Runs `git commit` on the staged changes with the developer bot's author
identity (`user.name=<botLogin>`, `user.email=<botUserId>+<botLogin>@users.noreply.github.com`)
set for that invocation only. git's output streams through; its exit code is
returned. Exactly one of `-m`/`--message` or `-F`/`--file`.

## review-sync

```
dispatcher review-sync
```

Reads the `pull_request_review` payload at `GITHUB_EVENT_PATH`, and for a
submitted `changes_requested` review by a non-bot user, moves each linked
issue that is at `Human Review` or `In Progress` delegated to the reviewer to
`Changes Requested` and releases it. Logs every decision. Exit 0 whether or
not it acted; exit 1 on an API failure. See [Review sync
workflow](../setup/review-sync.md).

## prune-worktrees

```
dispatcher prune-worktrees [--dry-run]
```

Removes every agent worktree under `.claude/worktrees/` that holds nothing:
not locked by a running agent (a lock whose pid is dead is reclaimed and
reported), no uncommitted or untracked files, no unpushed commits. Then
deletes directories under `.claude/worktrees/` that git no longer tracks. Prints
`keep`, `reclaim`, `removed`, `deleted` and `FAILED` lines and a summary.
Exit 1 only when git still lists a worktree it tried to remove. Runs from any
directory inside the repository. See [Worktrees and
pruning](../in-depth/worktrees.md).

## init

```
dispatcher init
```

Interactive setup at the repository root: creates `dispatcher.config.json`
(kept if present), enables the Claude Code plugin in `.claude/settings.json`,
and prints a checklist. Prompts only when it has a question; without a
terminal it exits 1 if it would need one. See [Set up a
repository](../getting-started/init.md).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success (for `wait`, every outcome; for `review-sync`, acted or deliberately did not) |
| 1 | `status` when the listener is down; `pr`, `review-sync`, `init` and `prune-worktrees` failures |
| 2 | usage or argument errors, board command failures, unknown commands |
