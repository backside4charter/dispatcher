import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { themes as prismThemes } from "prism-react-renderer"

/**
 * The dispatcher documentation site. Docs are served at the site root (there
 * is no landing page or blog), and every page is plain Markdown under
 * `docs/` so the same files render on GitHub. Mermaid diagrams are enabled
 * so the flow charts are text in the repository, not exported images.
 */
const config: Config = {
  title: "dispatcher",
  tagline: "An autonomous backlog dispatcher for agent-driven development",
  favicon: "img/favicon.svg",

  url: "https://backside4charter.github.io",
  baseUrl: "/dispatcher/",
  organizationName: "backside4charter",
  projectName: "dispatcher",
  trailingSlash: false,

  onBrokenLinks: "throw",
  onBrokenAnchors: "throw",
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },
  themes: ["@docusaurus/theme-mermaid"],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  stylesheets: [
    {
      href: "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@500;600;700&family=Source+Sans+3:ital,wght@0,400;0,600;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap",
      type: "text/css",
    },
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          path: "docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/backside4charter/dispatcher/edit/main/website/",
          showLastUpdateTime: false,
        },
        blog: false,
        pages: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    docs: {
      sidebar: {
        hideable: false,
        autoCollapseCategories: false,
      },
    },
    navbar: {
      title: "dispatcher",
      logo: {
        alt: "dispatcher",
        src: "img/favicon.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Docs",
        },
        {
          href: "https://github.com/backside4charter/dispatcher/releases",
          label: "Releases",
          position: "right",
        },
        {
          href: "https://github.com/backside4charter/dispatcher",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "light",
      links: [
        {
          title: "Start",
          items: [
            { label: "Install", to: "/getting-started/install" },
            { label: "Set up Linear", to: "/setup/linear" },
            { label: "Set up the GitHub Apps", to: "/setup/github-apps" },
          ],
        },
        {
          title: "Understand",
          items: [
            { label: "How it works", to: "/concepts/how-it-works" },
            { label: "The board", to: "/concepts/the-board" },
            { label: "In depth", to: "/in-depth/board-model" },
          ],
        },
        {
          title: "Look up",
          items: [
            { label: "CLI reference", to: "/reference/cli" },
            { label: "Config reference", to: "/reference/config" },
            { label: "Claude Code plugin", to: "/reference/plugin" },
          ],
        },
      ],
      copyright: "dispatcher is MIT licensed.",
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "graphql", "powershell", "yaml"],
    },
    mermaid: {
      theme: { light: "dark", dark: "dark" },
      options: {
        fontFamily: "Source Sans 3, Segoe UI, system-ui, sans-serif",
        themeVariables: {
          background: "#0e1319",
          primaryColor: "#1b2a3d",
          primaryBorderColor: "#7fb0ea",
          primaryTextColor: "#e6ebf0",
          secondaryColor: "#161d25",
          tertiaryColor: "#1d2630",
          lineColor: "#c3ccd5",
          textColor: "#e6ebf0",
          fontSize: "14px",
        },
      },
    },
  } satisfies Preset.ThemeConfig,
}

export default config
