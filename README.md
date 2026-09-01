# dispatcher

A stack-agnostic task dispatcher for agent-driven development, shipped as one
self-contained executable per platform. It gives a repository a scriptable
window onto its task board and the agent identity plumbing that makes
agent-authored work reviewable by a human.

One binary carries every command:

- **`board`** - read and write the task board: poll milestones, inspect
  issues, move workflow states, claim and release work, comment, label, and
  attach pull requests. Linear and GitHub Projects v2 backends, selected by
  config.
- **`listen` / `status` / `wait` / `consume`** - a local board-event channel:
  a loopback listener fed by `gh webhook forward` (plus, on Linear, a board
  poller) that lets a long-running agent session react to board changes
  immediately instead of waiting out its polling interval.
- **`token` / `identity` / `pr` / `commit`** - agent GitHub App tooling: mint
  short-lived installation tokens, diagnose installation permissions, open
  pull requests authored by a developer bot (with a commit-attribution
  guard), and commit staged changes under the bot's identity.
- **`review-sync`** - a CI hook that rolls a task back to Changes Requested
  when a human requests changes on its pull request.
- **`prune-worktrees`** - remove finished agent git worktrees safely.

## Install

Download the binary for your platform from
[Releases](https://github.com/backside4charter/dispatcher/releases), put it on
your PATH as `dispatcher` (or invoke it by path), and run `dispatcher help`.

Targets: `windows-x64`, `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`.

## Configure

The dispatcher is driven by a committed `dispatcher.config.json` at the
repository root - it is also the marker the binary locates the repository by.
It names the board platform and project, what the board calls each workflow
state, the repository pull requests land in, and (optionally) the two agent
GitHub Apps and the event-listener port. See
[src/board/config.ts](src/board/config.ts) for the full schema and
[src/testing/board-fixtures.ts](src/testing/board-fixtures.ts) for a complete
example naming both platforms.

Credentials are looked up, never configured: the Linear API key comes from
`LINEAR_API_KEY` or the gitignored `.secrets/api-keys.json` of the main
checkout, GitHub board access uses the caller's `gh` auth, and each GitHub
App's private key sits in `.secrets/<slug>.private-key.pem` (overridable per
app via its configured environment variable).

## Build from source

Requires [Bun](https://bun.sh) at the version pinned in `.bun-version`
(compiled binaries embed the compiling runtime, so the pin is exact) and
optionally [just](https://github.com/casey/just).

```sh
bun install
just check          # typecheck + tests
just run board config
just compile        # host-platform binary into dist/
just compile all    # every target (cross-compiles from any host)
```

Releases are cut by tagging: bump `package.json`, tag `v<version>`, push the
tag, and the release workflow compiles every target and publishes the
binaries.
