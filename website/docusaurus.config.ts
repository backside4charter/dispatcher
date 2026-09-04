import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { themes as prismThemes } from "prism-react-renderer"

/**
 * The dispatcher documentation site. Docs are served at the site root (there
 * is no landing page or blog), and every page is plain Markdown under
 * `docs/`; the flow charts are interactive SVG drawn by the Diagram
 * component from small geometry files, never exported images.
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
    hooks: {
      onBrokenMarkdownLinks: "throw",
    },
  },

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
          title: "Understand",
          items: [
            { label: "How it works", to: "/concepts/how-it-works" },
            { label: "The board", to: "/concepts/the-board" },
          ],
        },
        {
          title: "Use",
          items: [
            { label: "Get started", to: "/getting-started/get-started" },
            { label: "Run the loop", to: "/getting-started/first-run" },
          ],
        },
        {
          title: "For AI agents",
          items: [
            { label: "Setup guide", to: "/ai/setup" },
            { label: "System breakdown", to: "/ai/system" },
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
  } satisfies Preset.ThemeConfig,
}

export default config
