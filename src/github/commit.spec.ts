import { describe, expect, it } from "vitest"
import { TEST_CONFIG } from "../testing/board-fixtures"
import { getAgentApp } from "./apps"
import { buildCommitGitArgs } from "./commit"

const developer = getAgentApp(TEST_CONFIG, "developer")

describe("buildCommitGitArgs", () => {
  it("sets the bot identity per invocation, never touching repo config", () => {
    expect(buildCommitGitArgs(developer, { message: "Fix the thing" })).toEqual([
      "-c", "user.name=acme-developer[bot]",
      "-c", "user.email=100000001+acme-developer[bot]@users.noreply.github.com",
      "commit", "-m", "Fix the thing",
    ])
  })

  it("commits from a message file for multi-paragraph messages", () => {
    expect(buildCommitGitArgs(developer, { file: "msg.txt" }).slice(4)).toEqual(["commit", "-F", "msg.txt"])
  })

  it("requires exactly one message source", () => {
    expect(() => buildCommitGitArgs(developer, {})).toThrow(/exactly one/)
    expect(() => buildCommitGitArgs(developer, { message: "m", file: "f" })).toThrow(/exactly one/)
  })
})
