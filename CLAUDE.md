# Claude Code Guidelines

## What this is

A stack-agnostic task dispatcher for agent-driven development: a task-board
CLI (Linear or GitHub Projects v2), a local board-event channel, agent GitHub
App identity tooling, a review-to-board sync, and a worktree pruner - all in
one TypeScript codebase compiled into a self-contained executable per
platform with `bun build --compile`. Consuming projects download a pinned
release binary and drive it through a committed `dispatcher.config.json` at
their repository root; nothing project-specific lives in this source.

## ⛔ ALL QUALITY CHECKS MUST PASS — NO EXCEPTIONS ⛔

**Before any task can be considered complete, ALL quality checks (typecheck,
test) must pass with ZERO failures.** A failing test is ALWAYS your problem,
whether or not it looks related to your changes. Never skip or `.todo()` a
failing test to get green, and never declare work done with failures
outstanding. `just check` runs everything.

## CRITICAL

**CRITICAL:** If you need a library, install it in the project properly -
never work around a missing dependency.
**CRITICAL:** Write the proper version first instead of a temporary
workaround.
**CRITICAL:** If you ever need to revert/checkout files using git, stop and
ask for help instead - reverting can destroy intentional changes.
**CRITICAL:** Always use strong types. Never `any` (use `unknown` and narrow
with type guards); avoid unsafe casts (`as Type`) - prefer inferred types,
since casts bypass type checking.
**CRITICAL:** Before installing any new dependency or bumping a pinned
version, web-search the package name + version + "compromised" / "malware" /
"supply chain", and check the changelog at the official source repository to
confirm the exact version is a legitimate release. npm supply-chain
compromises are common; the 30-second search is trivial next to shipping
credential-stealing code. Any signal of compromise: stop and tell the user.

## Dependencies

Every dependency version is written **exact** (`bunfig.toml` sets
`[install] exact = true`) - no `^`/`~` ranges, so no upgrade lands without a
deliberate, reviewable edit. Adding a brand-new dependency requires explicit
user approval. Keep the dependency count minimal: this ships as a compiled
binary, and every package is supply-chain surface.

**The Bun version is pinned in `.bun-version` and is a shipped artifact, not
just a local tool**: `bun build --compile` embeds the compiling runtime, so
two Buns produce materially different binaries from the same commit.
`scripts/compile.ts` enforces the pin as an exact match, and CI installs from
the pin file. Moving to a new Bun is a deliberate pair of edits in one
commit: install it, and update `.bun-version`.

## Architecture constraints

- **`src/main.ts` is the only entrypoint.** Sub-CLI modules export
  `run*FromProcess()` functions and carry no module-level "am I being
  executed" guards: bundling gives every module the entry's
  `import.meta.url`, so such a guard misfires in the compiled binary.
- **Never resolve paths from `import.meta.url` in runtime code.** In a
  compiled binary it points inside the executable. Repository discovery
  walks up from the working directory to `dispatcher.config.json`; the main
  checkout (for `.secrets/`) is found via `git rev-parse --git-common-dir`.
- **Everything project-specific comes from `dispatcher.config.json`.** No
  hardcoded org names, board ids, ports, or app identities; a new consumer
  writes a config, never edits source. The schema lives in
  `src/board/config.ts`.
- **Test fixtures are fictional.** `src/testing/board-fixtures.ts` uses the
  made-up "acme/widgets" project; never put a real organization's ids,
  URLs, or identifiers in this repository.

## Development (TDD)

1. **Write a failing test first** that exercises the feature or reproduces
   the bug as close to end-to-end as practical, and verify it fails for the
   right reason.
2. **Implement until it passes**, then refactor with tests green.
3. Prefer integration-shaped tests (drive `runMain`/`runBoardCli`/the real
   listener over loopback HTTP) over trivial unit tests; use real
   implementations, mocking only external APIs (GitHub, Linear). Cover edge
   cases and error paths, not just the happy path.
4. Verify compiled-mode behavior for anything touching process wiring or
   path resolution: `just compile` and smoke-test the binary.

```sh
just check          # typecheck + tests - must be green before any commit
just run <command>  # run the CLI from source
just compile [all]  # build the binary (host, or every target)
```

Releases: bump `package.json`, commit, tag `v<version>` (must match), push
the tag; the release workflow compiles every target and publishes the
binaries. Tags are never moved or reused.

## Code Style

- TypeScript strict mode with `noUncheckedIndexedAccess`
- Double quotes, no semicolons, 2-space indentation
- Never use `.js`/`.ts` extensions in imports; never add barrel files
  (index.ts that just re-exports)
- Don't leave commented-out code; never put mock/test code in production
  files
- Zod for runtime validation of external input (config files, API payloads)

### Code Comments

Every function and method gets a JSDoc comment explaining what it does, in
multi-line format even for single-line descriptions:

```typescript
/**
 * Description of what this function does.
 */
function myFunction() {
  // ...
}
```

Classes and modules include a summary of features. Single-line `/** ... */`
is acceptable for interface properties and type fields. Inline comments
state constraints the code can't show - not what the next line does.

## Documentation

The documentation site is a Docusaurus project under `website/`, published
to GitHub Pages by `.github/workflows/docs.yml`. It has its own
`package.json` and lockfile so the binary's dependency tree stays small.
When a command, config field, workflow rule or skill changes, update the
matching page under `website/docs/` in the same change; `just docs-build`
must pass (it fails on broken links).

## Writing Style

- **Never use emdashes (—).** Use a regular hyphen (-), or commas, periods,
  semicolons, parentheses.
- Don't create new documentation files unless instructed.
- The README describes the current version only - no history or
  "previously known as" references.
