---
title: Development
description: Building the binary from source, running the checks, cutting a release, and the architecture rules the code keeps.
---

# Development

## Build from source

Requires [Bun](https://bun.sh) at the version pinned in `.bun-version` and
optionally [just](https://github.com/casey/just).

```sh
bun install
just check          # typecheck + tests (vitest, with coverage)
just run board config
just compile        # host-platform binary into dist/
just compile all    # every target, cross-compiled from any host
just docs           # this documentation site, locally with live reload
just docs-build     # build it exactly as the Pages workflow does
```

The Bun pin is exact and enforced by `scripts/compile.ts`, because `bun build
--compile` embeds the compiling runtime: two Buns produce materially
different binaries from the same commit. Moving the pin is a deliberate pair
of edits in one commit (install the new Bun, update `.bun-version`).

Every dependency version is written exact, and adding one requires a
supply-chain check first (search the package and version for compromise
reports, confirm the release at the source repository). The binary's
dependency list is deliberately tiny: `zod` for validating external input,
`@clack/prompts` for the init wizard, `tsx` to run from source.

## Layout

```
src/main.ts                    the one entrypoint: routes to every command group
src/cli.ts                     listen / status / wait / consume
src/listener.ts, waiter.ts, event-log.ts, board-events.ts
src/board-cli.ts               dispatcher board
src/board/                     config schema, platform-neutral types, claims, policy, formatting
src/board/linear/              the Linear backend, client, poller, PR link resolution
src/board/github/              the GitHub Projects v2 backend and webhook mapping
src/github/                    apps, tokens, pr, commit
src/review-status-sync*.ts     the CI hook
src/worktree-prune*.ts         the pruner
src/init/                      the wizard
src/testing/                   fictional acme/widgets fixtures and an in-memory board
skills/, agents/               the Claude Code plugin
scripts/compile.ts             bun build --compile for every target
website/                       this site (Docusaurus)
```

## Architecture rules

- **`src/main.ts` is the only entrypoint.** Command modules export
  `run*FromProcess()` functions and carry no "am I being executed" guard,
  because bundling gives every module the entry's `import.meta.url`.
- **Never resolve paths from `import.meta.url` at runtime.** In a compiled
  binary it points inside the executable. The repository is found by walking
  up from the working directory to `dispatcher.config.json`; the main checkout
  by `git rev-parse --git-common-dir`.
- **Everything project-specific comes from the config.** No organization
  names, board ids, ports or app identities in source. The schema is
  `src/board/config.ts`.
- **Fixtures are fictional.** `acme/widgets` throughout; no real identifiers
  in the repository.
- **The decision logic is pure and the I/O is injected**, so the rules that
  protect the board and the working tree (rollback allow-list, prune keep
  rules, claim staleness) are unit-tested rather than trusted.

## Tests

Test-driven: a failing test first, exercised as close to end-to-end as
practical (drive `runMain`, `runBoardCli`, or the real listener over loopback
HTTP), with real implementations and doubles only for the external APIs.
`just check` must be green with zero failures before anything is done.

## Releases

1. Bump `version` in `package.json` and commit.
2. Tag `v<version>` (it must match) and push the tag.
3. The release workflow typechecks, tests, compiles every target with the
   pinned Bun, and publishes the binaries to a GitHub Release.

Tags are never moved or reused. The installers fetch `releases/latest` by
default and a specific release when `DISPATCHER_VERSION` is set.

## Documentation

This site is a Docusaurus project under `website/` with its own
`package.json` and lockfile, so its dependencies never enter the binary's
tree. Pages are plain Markdown with Mermaid fences under `website/docs/`; the
sidebar is `website/sidebars.ts`. The `docs` workflow builds the site on every
pull request that touches it (a broken link fails the build) and deploys to
GitHub Pages on pushes to `main`.
