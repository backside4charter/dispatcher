---
title: Set up a repository
description: Manual setup, step two - dispatcher init writes the config and enables the plugin.
---

# Set up a repository with `dispatcher init`

Put your Linear API key where the binary looks for it (either works):

- `LINEAR_API_KEY` in the environment, or
- `.secrets/api-keys.json` at the repository root containing
  `{"Linear": "lin_api_..."}`, with `.secrets/` in `.gitignore`.

Then, at the repository root:

```sh
dispatcher init
```

It asks for the repository (defaulted from the git remote) and the platform,
lets you pick the team, the project and which state plays each of the seven
roles, asks for the two label names, and optionally for the two GitHub Apps.
It writes `dispatcher.config.json`, enables the Claude Code plugin in
`.claude/settings.json`, and prints a checklist of anything still missing.
Running it again changes nothing that exists.

Two values it cannot discover are written as `TODO`: the ids of the two
Linear agent app users in `linear.agents`. [Set up Linear](../setup/linear.md)
shows how to create them and find the ids.

Verify:

```sh
dispatcher board config
dispatcher board states
dispatcher board poll <milestone>
```

Then do the one-time [Linear](../setup/linear.md) and
[GitHub Apps](../setup/github-apps.md) setup, add the
[review sync workflow](../setup/review-sync.md), and
[run the loop](first-run.md).
