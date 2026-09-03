import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

/**
 * The one sidebar, in reading order: a two-page understanding first, then
 * doing (getting started, setup), then looking things up (reference), and
 * last the full mechanics for anyone who wants them. Ids are file paths under
 * `docs/` without the extension.
 */
const sidebars: SidebarsConfig = {
  docs: [
    "index",
    {
      type: "category",
      label: "Concepts",
      collapsed: false,
      items: [
        "concepts/how-it-works",
        "concepts/the-board",
      ],
    },
    {
      type: "category",
      label: "Getting started",
      collapsed: false,
      items: [
        "getting-started/install",
        "getting-started/init",
        "getting-started/first-run",
      ],
    },
    {
      type: "category",
      label: "Setup guides",
      collapsed: false,
      items: [
        "setup/linear",
        "setup/github-apps",
        "setup/review-sync",
        "setup/event-channel",
        "setup/github-projects",
      ],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: [
        "reference/cli",
        "reference/config",
        "reference/credentials",
        "reference/plugin",
      ],
    },
    {
      type: "category",
      label: "In depth",
      collapsed: true,
      items: [
        "in-depth/board-model",
        "in-depth/lifecycle",
        "in-depth/dispatcher-loop",
        "in-depth/workers",
        "in-depth/claims",
        "in-depth/identities",
        "in-depth/event-channel",
        "in-depth/review-sync",
        "in-depth/worktrees",
      ],
    },
    "development",
  ],
}

export default sidebars
