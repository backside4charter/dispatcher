import type { SidebarsConfig } from "@docusaurus/plugin-content-docs"

/**
 * The one sidebar, in reading order: a two-page understanding, then getting
 * started (the AI-assisted route first, the manual route as an Advanced
 * category at the end), then the two pages written for AI agents. Ids are
 * file paths under `docs/` without the extension.
 */
const sidebars: SidebarsConfig = {
  docs: [
    "index",
    {
      type: "category",
      label: "Concepts",
      collapsed: false,
      items: ["concepts/how-it-works", "concepts/the-board"],
    },
    {
      type: "category",
      label: "Getting started",
      collapsed: false,
      items: [
        "getting-started/get-started",
        "getting-started/first-run",
        {
          type: "category",
          label: "Advanced: manual setup",
          collapsed: true,
          items: [
            "getting-started/install",
            "getting-started/init",
            "setup/linear",
            "setup/github-apps",
            "setup/review-sync",
            "setup/event-channel",
          ],
        },
      ],
    },
    {
      type: "category",
      label: "For AI agents",
      collapsed: false,
      items: ["ai/setup", "ai/system"],
    },
  ],
}

export default sidebars
