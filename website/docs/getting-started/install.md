---
title: Install
description: Put the dispatcher binary on your machine and check the tools it works alongside.
---

# Install

The dispatcher is a single executable with no runtime to install. The
installers download the latest release, put it on your `PATH`, and print the
next step.

## Prerequisites

| Tool | Needed for | Check |
| --- | --- | --- |
| [Claude Code](https://claude.com/claude-code) | running the loop and its workers | `claude --version` |
| [GitHub CLI](https://cli.github.com) (`gh`), logged in | reading PRs, the event channel, and the GitHub Projects backend | `gh auth status` |
| git | worktrees, branches, commits | `git --version` |
| A Linear workspace with a personal API key | the board (see [Set up Linear](../setup/linear.md)) | |

Optional, for the pieces that use them:

- `gh extension install cli/gh-webhook` and
  `gh auth refresh -h github.com -s admin:org_hook` for the
  [event channel](../setup/event-channel.md).
- Two GitHub Apps for bot-authored commits, PRs and reviews
  ([Set up the GitHub Apps](../setup/github-apps.md)). The board commands
  work without them; `dispatcher commit`, `pr`, `token` and `identity` do not.

`dispatcher init` checks all of these and prints a checklist, so you do not
have to get them right before installing.

## One-line install

```powershell
# Windows (Windows PowerShell 5.1 or PowerShell 7)
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.ps1 | iex"
```

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.sh | sh
```

What the installers do:

- Download `dispatcher-<os>-<arch>` from the latest GitHub release, retrying a
  dropped connection.
- Install to `%LOCALAPPDATA%\Programs\dispatcher\dispatcher.exe` on Windows or
  `~/.local/bin/dispatcher` elsewhere.
- Add that directory to your user `PATH` once (Windows: the user environment;
  macOS/Linux: an export appended to `~/.bashrc` and `~/.zshrc` when they
  exist, guarded by a marker comment).
- Print the installed version.

Open a new terminal afterwards so the `PATH` change is picked up, then:

```sh
dispatcher version
dispatcher help
```

### Pinning a version and choosing a directory

| Variable | Effect |
| --- | --- |
| `DISPATCHER_VERSION` | Install that release instead of the latest, for example `0.3.1` (no `v`). Consuming projects should pin: a `dispatcher.config.json` is written for a release, and the plugin's skills assume the matching binary. |
| `DISPATCHER_INSTALL` | Install directory override. |

```sh
DISPATCHER_VERSION=0.3.1 curl -fsSL https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.sh | sh
```

```powershell
$env:DISPATCHER_VERSION = "0.3.1"
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.ps1 | iex"
```

## Manual install

Download the binary for your platform from the
[Releases](https://github.com/backside4charter/dispatcher/releases) page:
`windows-x64`, `linux-x64`, `linux-arm64`, `darwin-x64` or `darwin-arm64`.
Rename it to `dispatcher` (`dispatcher.exe` on Windows), mark it executable,
and put it on your `PATH`. Every subcommand is inside the one file; there is
nothing else to download.

## Upgrading

Run the installer again. It overwrites the binary in place and reports the new
version. Nothing in your repository changes on an upgrade; if a release changes
the config schema, `dispatcher board config` tells you what is invalid.

## Next

Run the setup wizard inside your repository: [`dispatcher init`](init.md).
