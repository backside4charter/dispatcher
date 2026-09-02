import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseDispatcherConfig } from "../board/config"
import type { LinearGraphql } from "../board/linear/client"
import { InitNeedsTerminalError, runInitCli } from "./init-cli"
import type { InitDeps } from "./init-cli"
import type { Choice, Prompter } from "./prompter"

/** Captured output for assertions. */
function capture() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line: string) => { out.push(line) }, err: (line: string) => { err.push(line) } } }
}

/**
 * A prompter that answers from a script: `ask` and `confirm` consume queued
 * answers by question substring; `choose` picks by label substring, falling
 * back to the default.
 */
function scriptedPrompter(script: {
  answers?: Array<[question: string, answer: string]>
  picks?: Array<[question: string, label: string]>
  confirms?: Array<[question: string, answer: boolean]>
}): Prompter {
  const answers = [...(script.answers ?? [])]
  const picks = [...(script.picks ?? [])]
  const confirms = [...(script.confirms ?? [])]
  return {
    ask(question, defaultValue) {
      const index = answers.findIndex(([fragment]) => question.includes(fragment))
      if (index >= 0) {
        const [, answer] = answers.splice(index, 1)[0]!
        return Promise.resolve(answer)
      }
      return Promise.resolve(defaultValue ?? "")
    },
    choose<T>(question: string, choices: Choice<T>[], defaultIndex = 0) {
      const index = picks.findIndex(([fragment]) => question.includes(fragment))
      if (index >= 0) {
        const [, label] = picks.splice(index, 1)[0]!
        const found = choices.find((choice) => choice.label.includes(label))
        if (found === undefined) throw new Error(`no choice labelled ~"${label}" for: ${question}`)
        return Promise.resolve(found.value)
      }
      return Promise.resolve(choices[defaultIndex]!.value)
    },
    confirm(question, defaultValue) {
      const index = confirms.findIndex(([fragment]) => question.includes(fragment))
      if (index >= 0) {
        const [, answer] = confirms.splice(index, 1)[0]!
        return Promise.resolve(answer)
      }
      return Promise.resolve(defaultValue)
    },
    note() {},
    close() {},
  }
}

/** A fake Linear API serving one workspace, team, project and state set. */
const fakeLinear: LinearGraphql = {
  query(document: string) {
    if (document.includes("organization")) {
      return Promise.resolve({ organization: { urlKey: "acme", name: "Acme" } } as never)
    }
    if (document.includes("teams(")) {
      return Promise.resolve({ teams: { nodes: [{ id: "team-1", name: "Widgets", key: "ACM" }] } } as never)
    }
    if (document.includes("projects(")) {
      return Promise.resolve({ team: { projects: { nodes: [{ id: "proj-1", name: "Widgets Board", url: "https://linear.app/acme/project/widgets" }] } } } as never)
    }
    if (document.includes("states")) {
      return Promise.resolve({
        team: {
          states: {
            nodes: [
              { name: "Backlog", type: "backlog", position: 0 },
              { name: "Ready", type: "unstarted", position: 1 },
              { name: "Changes Requested", type: "unstarted", position: 2 },
              { name: "In Progress", type: "started", position: 3 },
              { name: "Question", type: "started", position: 4 },
              { name: "Human Review", type: "started", position: 5 },
              { name: "Done", type: "completed", position: 6 },
            ],
          },
        },
      } as never)
    }
    throw new Error(`unexpected document: ${document}`)
  },
}

describe("runInitCli", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dispatcher-init-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Deps against the temp repo with a fake git remote and Linear API. */
  function deps(prompter: Prompter, withLinear = true): InitDeps {
    return {
      prompter,
      repoRoot: dir,
      probe: (command, args) => {
        if (command === "git" && args[0] === "remote") return { ok: true, stdout: "git@github.com:acme/widgets.git\n" }
        return { ok: false, stdout: "" }
      },
      env: { LINEAR_API_KEY: withLinear ? "lin_api_test" : undefined },
      linearClient: withLinear ? () => fakeLinear : undefined,
    }
  }

  it("creates a valid Linear config via discovery, wires the plugin, and prints the checklist", async () => {
    const captured = capture()
    const code = await runInitCli(deps(scriptedPrompter({})), captured.io)
    expect(code).toBe(0)

    const raw: unknown = JSON.parse(readFileSync(path.join(dir, "dispatcher.config.json"), "utf8"))
    const config = parseDispatcherConfig(raw)
    expect(config.platform).toBe("linear")
    expect(config.repository).toBe("acme/widgets")
    expect(config.linear?.teamKey).toBe("ACM")
    expect(config.linear?.projectId).toBe("proj-1")
    expect(config.linear?.states.humanReview).toBe("Human Review")
    expect(config.githubApps).toBeUndefined()

    const settings: unknown = JSON.parse(readFileSync(path.join(dir, ".claude", "settings.json"), "utf8"))
    expect((settings as Record<string, unknown>).enabledPlugins).toEqual({ "dispatcher@dispatcher": true })

    const text = captured.out.join("\n")
    expect(text).toContain("wrote")
    expect(text).toContain("checklist:")
    expect(text).toContain("Linear API key")
  })

  it("collects the agent apps when asked to, and lists their bot ids in botUserIds", async () => {
    const prompter = scriptedPrompter({
      confirms: [["agent GitHub Apps", true]],
      answers: [
        ["developer app id", "111111"],
        ["developer org installation id", "10000001"],
        ["developer app slug", "acme-developer"],
        ["developer bot account", "100000001"],
        ["reviewer app id", "222222"],
        ["reviewer org installation id", "10000002"],
        ["reviewer app slug", "acme-reviewer"],
        ["reviewer bot account", "100000002"],
      ],
    })
    const captured = capture()
    expect(await runInitCli(deps(prompter), captured.io)).toBe(0)
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, "dispatcher.config.json"), "utf8"))
    const config = parseDispatcherConfig(raw)
    expect(config.githubApps?.developer.slug).toBe("acme-developer")
    expect(config.githubApps?.reviewer.botLogin).toBe("acme-reviewer[bot]")
    expect(config.botUserIds).toEqual([100000001, 100000002])
  })

  it("keeps an existing config and stays idempotent on the settings", async () => {
    writeFileSync(path.join(dir, "dispatcher.config.json"), JSON.stringify({
      platform: "linear",
      repository: "acme/widgets",
      botUserIds: [],
      linear: {
        workspace: "acme",
        teamId: "team-1",
        teamKey: "ACM",
        projectId: "proj-1",
        projectUrl: "https://linear.app/acme/project/widgets",
        states: {
          backlog: "Backlog", ready: "Ready", changesRequested: "Changes Requested", inProgress: "In Progress", question: "Question", humanReview: "Human Review", done: "Done",
        },
        agents: { developer: "u1", reviewer: "u2" },
        labels: { confirmWithUser: "Confirm with user", ui: "UI" },
      },
    }))
    const first = capture()
    expect(await runInitCli(deps(scriptedPrompter({})), first.io)).toBe(0)
    expect(first.out.join("\n")).toContain("already exists")

    const second = capture()
    expect(await runInitCli(deps(scriptedPrompter({})), second.io)).toBe(0)
    expect(second.out.join("\n")).toContain("already enabled")
  })

  it("runs the no-op path without prompting, so non-interactive stdin still verifies", async () => {
    // A prompter that fails like the non-TTY one: if any prompt fires on the
    // idempotent path, this test catches it.
    const failing: Prompter = {
      ask: () => Promise.reject(new InitNeedsTerminalError()),
      choose: () => Promise.reject(new InitNeedsTerminalError()),
      confirm: () => Promise.reject(new InitNeedsTerminalError()),
      note: () => {},
      close: () => {},
    }
    // First a run that needs prompts: it must fail cleanly, not hang or throw raw.
    const blocked = capture()
    expect(await runInitCli(deps(failing), blocked.io)).toBe(1)
    expect(blocked.err.join("\n")).toContain("interactive terminal")

    // With the config in place, the same prompter sails through.
    const first = capture()
    expect(await runInitCli(deps(scriptedPrompter({})), first.io)).toBe(0)
    const second = capture()
    expect(await runInitCli(deps(failing), second.io)).toBe(0)
    expect(second.out.join("\n")).toContain("already exists")
    expect(second.out.join("\n")).toContain("checklist:")
  })

  it("builds a manual Linear config when no API key is available", async () => {
    const prompter = scriptedPrompter({
      answers: [
        ["workspace URL key", "acme"],
        ["Team key", "ACM"],
      ],
    })
    const captured = capture()
    expect(await runInitCli(deps(prompter, false), captured.io)).toBe(0)
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, "dispatcher.config.json"), "utf8"))
    const config = parseDispatcherConfig(raw)
    expect(config.linear?.workspace).toBe("acme")
    expect(config.linear?.states).toEqual({
      backlog: "Backlog", ready: "Ready", changesRequested: "Changes Requested", inProgress: "In Progress", question: "Question", humanReview: "Human Review", done: "Done",
    })
  })
})
