---
title: Set up the GitHub Apps
description: Two GitHub Apps give agent work its own identities, so you can approve every PR.
---

# Set up the GitHub Apps

GitHub will not let an account approve its own pull request. Agent commits
and PRs are therefore made by a **developer** app and reviews by a separate
**reviewer** app. Without them the board still works, but agents open PRs as
you, which you cannot approve.

1. **Register two apps** under the organization's Settings > Developer
   settings > GitHub Apps. Webhook: uncheck Active. Permissions:

   | App | Repository permissions |
   | --- | --- |
   | developer (e.g. `acme-developer`) | Contents: Read and write; Pull requests: Read and write |
   | reviewer (e.g. `acme-reviewer`) | Pull requests: Read and write |

2. **Install both** on the organization. The installation id is the number at
   the end of the installation's settings URL.
3. **Generate a private key** for each and save it as
   `.secrets/<slug>.private-key.pem` in the repository (gitignored).
4. **Collect the ids** and add them to `dispatcher.config.json`:

   ```sh
   gh api "users/acme-developer%5Bbot%5D" --jq '{login: .login, id: .id}'
   gh api "users/acme-reviewer%5Bbot%5D"  --jq '{login: .login, id: .id}'
   ```

   ```json
   "githubApps": {
     "developer": { "appId": 111111, "installationId": 10000001, "slug": "acme-developer", "botLogin": "acme-developer[bot]", "botUserId": 100000001 },
     "reviewer":  { "appId": 222222, "installationId": 10000002, "slug": "acme-reviewer",  "botLogin": "acme-reviewer[bot]",  "botUserId": 100000002 }
   },
   "botUserIds": [100000001, 100000002]
   ```

5. **Verify:** `dispatcher identity` and `dispatcher identity --app reviewer`
   print each app's permissions and the identity it will commit as.

The reviewer only ever posts comment reviews, never approvals, so a
required-review rule stays yours to satisfy. A ruleset that restricts pushes
must allow the developer app.
