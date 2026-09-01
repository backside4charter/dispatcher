import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"
import { LinearClient, LinearError, resolveLinearApiKey } from "./client"
import type { FetchLike } from "./client"

/**
 * Builds a fetch double that answers every call with the given status and body.
 */
function respondWith(status: number, body: string): { fetch: FetchLike; requests: { url: string; body: string; headers: Record<string, string> }[] } {
  const requests: { url: string; body: string; headers: Record<string, string> }[] = []
  return {
    requests,
    fetch: async (url, init) => {
      requests.push({ url, body: init.body, headers: init.headers })
      return { ok: status >= 200 && status < 300, status, text: async () => body }
    },
  }
}

describe("resolveLinearApiKey", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "linear-key-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("prefers the environment variable, which is how CI supplies it", () => {
    expect(resolveLinearApiKey({ LINEAR_API_KEY: "lin_api_env" }, dir)).toBe("lin_api_env")
  })

  it("reads the Linear entry of .secrets/api-keys.json outside a git checkout's worktree", () => {
    mkdirSync(path.join(dir, ".secrets"))
    writeFileSync(path.join(dir, ".secrets", "api-keys.json"), JSON.stringify({ Linear: "lin_api_file", Other: "x" }))
    expect(resolveLinearApiKey({}, dir)).toBe("lin_api_file")
  })

  it("fails loudly, naming the file, when no key can be found", () => {
    expect(() => resolveLinearApiKey({}, dir)).toThrow("api-keys.json")
  })
})

describe("LinearClient", () => {
  const schema = z.object({ viewer: z.object({ name: z.string() }) })

  it("posts the document with the raw key as the Authorization header and returns validated data", async () => {
    const transport = respondWith(200, JSON.stringify({ data: { viewer: { name: "repo-owner" } } }))
    const client = new LinearClient("lin_api_test", transport.fetch)
    const data = await client.query("{ viewer { name } }", {}, schema)
    expect(data.viewer.name).toBe("repo-owner")
    expect(transport.requests[0]?.headers.authorization).toBe("lin_api_test")
    expect(JSON.parse(transport.requests[0]?.body ?? "{}")).toEqual({ query: "{ viewer { name } }", variables: {} })
  })

  it("throws a LinearError carrying the errors list when the response has errors", async () => {
    const transport = respondWith(200, JSON.stringify({ errors: [{ message: "Entity not found: Issue" }] }))
    const client = new LinearClient("k", transport.fetch)
    await expect(client.query("{ x }", {}, schema)).rejects.toMatchObject({
      name: "LinearError",
      errors: [{ message: "Entity not found: Issue" }],
    })
  })

  it("throws on a non-2xx status, a non-JSON body, and data that misses the schema", async () => {
    await expect(new LinearClient("k", respondWith(429, JSON.stringify({ data: null })).fetch).query("{ x }", {}, schema))
      .rejects.toBeInstanceOf(LinearError)
    await expect(new LinearClient("k", respondWith(502, "<html>bad gateway</html>").fetch).query("{ x }", {}, schema))
      .rejects.toThrow("non-JSON")
    await expect(new LinearClient("k", respondWith(200, JSON.stringify({ data: { viewer: {} } })).fetch).query("{ x }", {}, schema))
      .rejects.toThrow("expected shape")
  })
})
