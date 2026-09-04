---
title: Setup guide
description: Step-by-step instructions an AI agent follows to install and configure the dispatcher in a repository, and what to ask the human for.
---

# Setup guide for AI agents

You are setting up the dispatcher in the repository you are running in, on
behalf of its owner. Work through the phases in order, run every verification
command, and stop to ask the human only for the items marked **ask**. Do not
guess ids: discover them with the commands given. When you finish, report
the checklist at the end. The [system breakdown](system.md) explains
everything you touch. Raw Markdown of this page:
`https://raw.githubusercontent.com/backside4charter/dispatcher/main/website/docs/ai/setup.md`.

Commands below run from the repository root. They are POSIX shell; on
Windows use Git Bash or translate to PowerShell.

## Phase 1: the binary

1. Install it (pin a release by setting `DISPATCHER_VERSION`, e.g. `0.3.1`):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.sh | sh
   ```

   ```powershell
   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.ps1 | iex"
   ```

   The installer adds the binary to the user's `PATH` for new shells. In the
   current shell use the full path if needed: `~/.local/bin/dispatcher`
   (macOS/Linux) or `%LOCALAPPDATA%\Programs\dispatcher\dispatcher.exe`.
2. Verify: `dispatcher version` prints a version. `gh auth status` succeeds
   (if not, **ask** the human to run `gh auth login`). `git remote get-url
   origin` names the GitHub repository.

## Phase 2: the Linear API key

1. **Ask** the human for a Linear personal API key for the account the
   dispatcher should act as (Linear > Settings > Account > Security & access
   > Personal API keys). Every board write and comment will post under this
   account.
2. Store it, and keep it out of git:

   ```sh
   mkdir -p .secrets
   printf '{"Linear": "%s"}\n' "$LINEAR_KEY" > .secrets/api-keys.json
   grep -qx '.secrets/' .gitignore 2>/dev/null || printf '\n# dispatcher credentials\n.secrets/\n' >> .gitignore
   git check-ignore -q .secrets/api-keys.json && echo ignored
   ```

3. Verify the key: the query below must return the workspace's `urlKey`.

   ```sh
   LIN() { curl -sS https://api.linear.app/graphql -H "Authorization: $(node -e 'console.log(require("./.secrets/api-keys.json").Linear)')" -H "Content-Type: application/json" -d "$1"; }
   LIN '{"query":"{ organization { urlKey name } }"}'
   ```

## Phase 3: the Linear board

Discover, then create what is missing. Keep the human's existing names where
they exist; the config maps names to roles, so nothing has to be renamed.

1. Teams and projects. **Ask** the human which team and which project is the
   board if there is more than one.

   ```sh
   LIN '{"query":"{ teams { nodes { id name key } } }"}'
   LIN '{"query":"query($t: String!) { team(id: $t) { projects { nodes { id name url } } } }","variables":{"t":"<teamId>"}}'
   ```

2. Workflow states. List them and map each of the seven roles to one state.
   Create any that are missing with the type shown (`Done` must be
   `completed`); Linear's colours for the defaults are listed in the system
   breakdown.

   ```sh
   LIN '{"query":"query($t: String!) { team(id: $t) { states { nodes { id name type color position } } } }","variables":{"t":"<teamId>"}}'
   LIN '{"query":"mutation($i: WorkflowStateCreateInput!) { workflowStateCreate(input: $i) { success } }","variables":{"i":{"teamId":"<teamId>","name":"Changes Requested","type":"started","color":"#eb5757"}}}'
   ```

   | Role | Default name | Type | Colour |
   | --- | --- | --- | --- |
   | backlog | Backlog | backlog | `#bec2c8` |
   | ready | Ready | unstarted | `#0079d4` |
   | changesRequested | Changes Requested | started | `#eb5757` |
   | inProgress | In Progress | started | `#f2c94c` |
   | question | Question | started | `#9b51e0` |
   | humanReview | Human Review | started | `#ff7cb9` |
   | done | Done | completed | `#00a81c` |

3. Labels. Ensure `Confirm with user` and `UI` exist (or note the human's
   names for the same two ideas):

   ```sh
   LIN '{"query":"{ issueLabels { nodes { id name } } }"}'
   LIN '{"query":"mutation($i: IssueLabelCreateInput!) { issueLabelCreate(input: $i) { success } }","variables":{"i":{"name":"Confirm with user","teamId":"<teamId>"}}}'
   ```

4. Milestones. The loop is scoped to project milestones by name; if the
   project has none, **ask** the human what the first one should be called
   and create it:

   ```sh
   LIN '{"query":"mutation($i: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $i) { success } }","variables":{"i":{"projectId":"<projectId>","name":"v1.0.0"}}}'
   ```

5. Agent app users. Two Linear agents are needed, one the developer and one
   the reviewer. They are OAuth applications with agent capability, installed
   into the workspace; this needs a workspace admin in the Linear UI, so
   **ask** the human to create and install them (Settings > API >
   Applications, then install with `actor=app`; Linear's guide is at
   `https://linear.app/developers/agents`). Then find their user ids:

   ```sh
   LIN '{"query":"{ users(filter: { app: { eq: true } }) { nodes { id name displayName active } } }"}'
   ```

   If the human prefers to skip this for now, write `"TODO"` for both ids;
   the read-only board commands work, and claims fail loudly until they are
   set.

6. GitHub integration. **Ask** the human to confirm, in Linear, that the
   GitHub integration is connected to this repository (Settings >
   Integrations > GitHub) and that the team automation *PR merged -> Done* is
   on (Settings > Team > Workflows & automations > Pull request and commit
   automations). Merging is what completes a task; without this the board
   never reaches Done.

## Phase 4: the config and the plugin

1. Write `dispatcher.config.json` at the repository root from what you
   discovered. Template (fill every placeholder):

   ```json
   {
     "platform": "linear",
     "repository": "<owner>/<name>",
     "botUserIds": [],
     "linear": {
       "workspace": "<organization.urlKey>",
       "teamId": "<teamId>",
       "teamKey": "<team key, e.g. ACM>",
       "projectId": "<projectId>",
       "projectUrl": "<project url>",
       "states": {
         "backlog": "Backlog",
         "ready": "Ready",
         "changesRequested": "Changes Requested",
         "inProgress": "In Progress",
         "question": "Question",
         "humanReview": "Human Review",
         "done": "Done"
       },
       "agents": { "developer": "<developer agent user id>", "reviewer": "<reviewer agent user id>" },
       "labels": { "confirmWithUser": "Confirm with user", "ui": "UI" }
     }
   }
   ```

2. Enable the Claude Code plugin by merging these keys into
   `.claude/settings.json` (create the file if absent; keep everything else
   in it):

   ```json
   {
     "extraKnownMarketplaces": {
       "dispatcher": { "source": { "source": "github", "repo": "backside4charter/dispatcher" } }
     },
     "enabledPlugins": { "dispatcher@dispatcher": true }
   }
   ```

3. Verify. `dispatcher init` now has nothing to ask, so it prints a
   checklist and exits 0; `board config` must show the right project and
   states; `board states` must show a role next to each of the seven states;
   `board poll <milestone>` must list the project's open issues.

   ```sh
   dispatcher init
   dispatcher board config
   dispatcher board states
   dispatcher board milestones
   ```

   Commit `dispatcher.config.json` and `.claude/settings.json`.

## Phase 5: the GitHub Apps

Two GitHub Apps give agent work its own identities so the human can approve
every PR. Registration, installation and key download happen in the GitHub
UI, so **ask** the human to do them, giving them this list:

1. Organization Settings > Developer settings > GitHub Apps > New GitHub App,
   twice: a developer app (e.g. `<org>-developer`) with repository
   permissions **Contents: Read and write** and **Pull requests: Read and
   write**, and a reviewer app (e.g. `<org>-reviewer`) with **Pull requests:
   Read and write**. Webhook: uncheck Active.
2. Install both on the organization (the installation id is the number at
   the end of the installation's settings URL).
3. Generate a private key for each and save the PEM files as
   `.secrets/<slug>.private-key.pem` in this repository.

Then collect the ids yourself and add them to the config:

```sh
gh api "users/<developer-slug>%5Bbot%5D" --jq '{login: .login, id: .id}'
gh api "users/<reviewer-slug>%5Bbot%5D"  --jq '{login: .login, id: .id}'
```

```json
"githubApps": {
  "developer": { "appId": <app id>, "installationId": <installation id>, "slug": "<developer-slug>", "botLogin": "<developer-slug>[bot]", "botUserId": <id> },
  "reviewer":  { "appId": <app id>, "installationId": <installation id>, "slug": "<reviewer-slug>",  "botLogin": "<reviewer-slug>[bot]",  "botUserId": <id> }
},
"botUserIds": [<developer bot id>, <reviewer bot id>]
```

Verify: `dispatcher identity` and `dispatcher identity --app reviewer` print
each installation's permissions; `dispatcher token | cut -c1-4` prints the
start of a token. If the human wants to defer this, the board commands work
without it, but agents will open PRs as the human, which the human then
cannot approve.

## Phase 6: the review sync workflow

Write `.github/workflows/board-review-sync.yml` so a "Request changes" review
by the human sends the task back within seconds:

```yaml
name: Board review sync
on:
  pull_request_review:
    types: [submitted]
permissions:
  contents: read
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dispatcher
        env:
          DISPATCHER_VERSION: <the version dispatcher version printed>
        run: |
          curl -fsSL https://raw.githubusercontent.com/backside4charter/dispatcher/main/install.sh | sh
          echo "$HOME/.local/bin" >> "$GITHUB_PATH"
      - name: Sync the board
        env:
          LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}
        run: dispatcher review-sync
```

Add the repository secret from the stored key and commit the workflow:

```sh
node -e 'process.stdout.write(require("./.secrets/api-keys.json").Linear)' | gh secret set LINEAR_API_KEY
```

## Phase 7: the event channel (optional)

Lets board and PR changes wake the loop within seconds instead of at its
timer. Install the extension; the scope refresh opens a browser, so **ask**
the human to run it:

```sh
gh extension install cli/gh-webhook
gh auth refresh -h github.com -s admin:org_hook
```

The human starts it when they work: `dispatcher listen` in its own terminal,
checked with `dispatcher status`.

## Phase 8: hand over

Tell the human:

- to open Claude Code in this repository (a restart picks up the plugin),
  ideally `claude --model opus --effort low`, and run
  `/dispatcher:start <milestone>`; `/dispatcher:stop` stops it;
- which items above are still open, if any (agent app ids, GitHub Apps,
  automation, event channel);
- that the docs for using it day to day are the
  [How it works](../concepts/how-it-works.mdx) and [The board](../concepts/the-board.md) pages.

Final checklist to report, each marked done or open:

1. `dispatcher version` works and `gh` is authenticated.
2. `.secrets/api-keys.json` holds the Linear key and is gitignored.
3. Seven states mapped, labels present, at least one milestone.
4. Agent app user ids in `linear.agents`.
5. GitHub integration connected; *PR merged -> Done* automation on.
6. `dispatcher.config.json` and `.claude/settings.json` committed;
   `dispatcher board poll <milestone>` lists issues.
7. GitHub Apps registered, installed, keys stored; `dispatcher identity` ok.
8. Review sync workflow committed and `LINEAR_API_KEY` secret set.
9. Event channel extension and scope (optional).
