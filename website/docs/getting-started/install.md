---
title: Install
description: Manual setup, step one - put the binary on your machine.
---

# Install

The manual route, for when you would rather not [hand setup to an
AI](get-started.md). One binary, no runtime.

You need [Claude Code](https://claude.com/claude-code), the
[GitHub CLI](https://cli.github.com) logged in (`gh auth login`), git, and a
Linear workspace.

```powershell
# Windows
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.ps1 | iex"
```

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.sh | sh
```

The installer downloads the latest release, puts it on your `PATH`
(`%LOCALAPPDATA%\Programs\dispatcher` or `~/.local/bin`), and prints the
version. Open a new terminal, then `dispatcher version`.

- Pin a release with `DISPATCHER_VERSION=0.3.1` before the command; choose
  the directory with `DISPATCHER_INSTALL`.
- Or download a binary from the
  [Releases](https://github.com/backside4charter/dispatcher/releases) page and
  put it on your `PATH` yourself.
- Upgrade by running the installer again.

Next: [Set up a repository](init.md).
