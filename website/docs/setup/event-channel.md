---
title: Event channel setup
description: One-time machine setup for immediate wakes - the gh webhook extension, the org hook scope, and running the listener.
---

# Event channel setup

The [event channel](../in-depth/event-channel.md) is optional. Without it the
loop wakes on worker completions and its fallback timer; with it, a board
change or a PR event wakes the loop within seconds.

## One-time machine setup

1. Install the official `gh` webhook-forwarding extension:

   ```sh
   gh extension install cli/gh-webhook
   ```

2. Grant `gh` the scope organization webhooks need:

   ```sh
   gh auth refresh -h github.com -s admin:org_hook
   ```

   Without it the forward child fails with `HTTP 404 (orgs/<owner>/hooks)`;
   the listener records the error and keeps retrying with backoff, and the
   loop keeps running on polling alone.

3. On Linear, have the API key in place (`LINEAR_API_KEY` or
   `.secrets/api-keys.json`, the same one `dispatcher board` uses). Without
   it the listener starts with the Linear side off and records PR events only.

`dispatcher init` reports the first two in its checklist.

## Running the listener

In a terminal of its own, at the repository root (or anywhere below it):

```sh
dispatcher listen
```

It prints where it is listening and what it is doing:

```
dispatcher event listener started (pid 41120)
state dir: /home/someuser/widgets/.claude/dispatcher
board: linear (/home/someuser/widgets/dispatcher.config.json)
webhook endpoint: http://127.0.0.1:47831/webhook
forwarding org "acme" events via gh webhook forward: pull_request, pull_request_review
polling Linear project proj-1 every 30000ms
```

Leave it running. It serves every dispatcher session on the machine, and
`/dispatcher:stop` never stops it; Ctrl+C does.

### Options

| Flag | Effect |
| --- | --- |
| `--port <n>` | loopback port to bind (default 47831, or `listener.port` from the config) |
| `--no-forward` | do not spawn `gh webhook forward`; POST deliveries to the endpoint yourself |
| `--org <org>` | organization whose webhooks to forward (default: the owner of the config's repository) |
| `--events <a,b>` | webhook events to subscribe to (default: the platform's set) |
| `--no-linear` | do not poll Linear |
| `--linear-poll-ms <n>` | Linear poll interval, minimum 1000 (default 30000) |
| `--config <path>`, `--platform <linear\|github>`, `--dir <path>` | the usual overrides |

Several dispatcher-enabled repositories on one machine each need their own
listener on their own port: set `listener.port` in each config.

## Checking it

```sh
dispatcher status
```

```
listener: up (pid 41120, port 47831)
forward: running (restarts 0)
linear: polling (118 polls, 0 errors, last 2026-09-03T14:21:07.412Z)
events: 9 accepted, 31 ignored since start
pending: 0 unconsumed event(s)
```

Exit 0 means up, 1 means down (`listener: down - <reason>`). `forward: NOT
running` with an error line usually means the extension or the scope is
missing; `linear: off - <reason>` names what is missing on the Linear side.

Two more commands you will rarely run by hand, because the dispatcher runs
them: `dispatcher consume` prints pending events and advances the cursor, and
`dispatcher wait [--timeout-seconds <n>] [--debounce-ms <n>]` blocks until
new events arrive.

## Trying it end to end

With the listener up, move an issue in the Linear project from `Backlog` to
`Ready`. Within about 30 seconds `dispatcher status` shows one more accepted
event and `dispatcher consume` prints it:

```
[2026-09-03T14:21:37.010Z] linear ACM-12 state Backlog -> Ready: Fix chat widget scroll pinning
consumed 1 event(s)
```

Open or close a PR in the repository and the same happens for the GitHub side,
provided the actor was not one of the bots.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `forward error: forward process exited (code 1 ...)` and `HTTP 404 (orgs/...)` | `gh` lacks `admin:org_hook` | `gh auth refresh -h github.com -s admin:org_hook` |
| `forward error: ... spawn gh ENOENT` | `gh` not on the listener's `PATH` | install `gh`, restart the listener |
| `linear: off - no Linear API key ...` | key not found | set `LINEAR_API_KEY` or write `.secrets/api-keys.json` |
| `listener: down - listener heartbeat is stale` | the listener process hung or the machine slept | restart it; a crashed listener reads as down within 60 seconds |
| `already-waiting: pid N` in the dispatcher's waiter output | another session's waiter holds the lock | expected with two sessions; that session gets the wake, this one runs on its timer |
| No `.claude/dispatcher/` directory | the command ran outside a repository with `dispatcher.config.json` | run it inside the repository or pass `--dir` |
