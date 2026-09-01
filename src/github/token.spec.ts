import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { TEST_CONFIG } from "../testing/board-fixtures"
import { getAgentApp } from "./apps"
import { base64url, createAppJwt, formatInstallationInfo, githubHeaders, parseInstallation, parseInstallationToken } from "./token"

/**
 * Decode one base64url JWT segment back into a parsed JSON object.
 */
function decodeSegment(segment: string): Record<string, unknown> {
  const decoded = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
  const parsed: unknown = JSON.parse(decoded)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`JWT segment is not a JSON object: ${decoded}`)
  }
  return { ...parsed }
}

/**
 * Read one numeric claim out of a decoded JWT payload.
 */
function numericClaim(claims: Record<string, unknown>, name: string): number {
  const value = claims[name]
  if (typeof value !== "number") throw new Error(`Expected a numeric "${name}" claim, got ${String(value)}`)
  return value
}

/**
 * Decode a base64url JWT signature back into its raw bytes.
 */
function decodeSignature(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

describe("base64url encoding", () => {
  it("swaps the two URL-hostile base64 characters", () => {
    expect(base64url(Buffer.from([0xfb, 0xff, 0xfe]))).toBe("-__-")
  })

  it("strips padding", () => {
    expect(base64url("a")).toBe("YQ")
    expect(base64url("ab")).toBe("YWI")
    expect(base64url("abc")).toBe("YWJj")
  })
})

describe("the app JWT", () => {
  const app = getAgentApp(TEST_CONFIG, "developer")
  let keyDirectory = ""
  let publicKeyPem = ""
  let previousEnv: string | undefined

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    keyDirectory = mkdtempSync(join(tmpdir(), "dispatcher-app-key-"))
    const keyPath = join(keyDirectory, "developer.pem")
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString())
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
    previousEnv = process.env[app.keyEnvVar]
    process.env[app.keyEnvVar] = keyPath
  })

  afterAll(() => {
    if (previousEnv === undefined) delete process.env[app.keyEnvVar]
    else process.env[app.keyEnvVar] = previousEnv
    if (keyDirectory !== "") rmSync(keyDirectory, { recursive: true, force: true })
  })

  it("is an RS256 JWT issued by the app id", () => {
    const [header, payload] = createAppJwt(app).split(".")

    expect(decodeSegment(header ?? "")).toEqual({ alg: "RS256", typ: "JWT" })
    expect(decodeSegment(payload ?? "")).toMatchObject({ iss: 111111 })
  })

  it("backdates iat against clock skew and expires inside GitHub's ten-minute cap", () => {
    const now = Math.floor(Date.now() / 1000)
    const claims = decodeSegment(createAppJwt(app).split(".")[1] ?? "")

    expect(numericClaim(claims, "iat")).toBeLessThanOrEqual(now - 60)
    expect(numericClaim(claims, "iat")).toBeGreaterThan(now - 70)
    expect(numericClaim(claims, "exp") - numericClaim(claims, "iat")).toBe(600)
    expect(numericClaim(claims, "exp") - now).toBeLessThan(600)
  })

  it("signs the header and payload with the app's private key", () => {
    const [header, payload, signature] = createAppJwt(app).split(".")

    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${header}.${payload}`)
    verifier.end()

    expect(verifier.verify(createPublicKey(publicKeyPem), decodeSignature(signature ?? ""))).toBe(true)
  })

  it("does not verify against a different key", () => {
    const [header, payload, signature] = createAppJwt(app).split(".")
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })

    const verifier = createVerify("RSA-SHA256")
    verifier.update(`${header}.${payload}`)
    verifier.end()

    expect(verifier.verify(other.publicKey, decodeSignature(signature ?? ""))).toBe(false)
  })
})

describe("request headers", () => {
  it("sends the pinned API version and an identifiable user agent", () => {
    expect(githubHeaders("tok_123")).toEqual({
      authorization: "Bearer tok_123",
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "dispatcher",
    })
  })
})

describe("reading GitHub's responses", () => {
  it("reads a minted installation token", () => {
    expect(parseInstallationToken({
      token: "ghs_abc",
      expires_at: "2026-08-31T00:52:07Z",
      permissions: { contents: "write", pull_requests: "write" },
    })).toEqual({
      token: "ghs_abc",
      expiresAt: "2026-08-31T00:52:07Z",
      permissions: { contents: "write", pull_requests: "write" },
    })
  })

  it("treats a response with no usable token as no token at all", () => {
    expect(parseInstallationToken({ message: "Bad credentials" })).toBeUndefined()
    expect(parseInstallationToken({ token: "" })).toBeUndefined()
    expect(parseInstallationToken({ token: 42 })).toBeUndefined()
    expect(parseInstallationToken(null)).toBeUndefined()
    expect(parseInstallationToken(["ghs_abc"])).toBeUndefined()
  })

  it("keeps only the permission entries it can render", () => {
    expect(parseInstallationToken({
      token: "ghs_abc",
      permissions: { contents: "write", weird: { nested: true } },
    })?.permissions).toEqual({ contents: "write" })
  })

  it("reads an installation, tolerating fields GitHub omits", () => {
    expect(parseInstallation({
      id: 10000001,
      app_id: 111111,
      app_slug: "acme-developer",
      account: { login: "acme" },
      repository_selection: "all",
      permissions: { contents: "write" },
    })).toEqual({
      id: 10000001,
      appId: 111111,
      appSlug: "acme-developer",
      account: "acme",
      repositorySelection: "all",
      permissions: { contents: "write" },
    })

    expect(parseInstallation({ id: 1, account: null })).toEqual({
      id: 1,
      appId: undefined,
      appSlug: undefined,
      account: undefined,
      repositorySelection: undefined,
      permissions: {},
    })
  })

  it("refuses a payload that is not an installation object", () => {
    expect(() => parseInstallation("nope")).toThrow(/unexpected installation payload/)
    expect(() => parseInstallation(null)).toThrow(/unexpected installation payload/)
  })
})

describe("the identity diagnostic", () => {
  it("prints the granted permissions and the commit identity the app expects", () => {
    const output = formatInstallationInfo(
      getAgentApp(TEST_CONFIG, "reviewer"),
      {
        id: 10000002,
        appId: 222222,
        appSlug: "acme-reviewer",
        account: "acme",
        repositorySelection: "all",
        permissions: { pull_requests: "write", issues: "write" },
      },
      "2026-08-31T00:52:10Z",
    )

    expect(JSON.parse(output)).toEqual({
      role: "reviewer",
      app: "acme-reviewer",
      appId: 222222,
      installationId: 10000002,
      account: "acme",
      repositorySelection: "all",
      permissions: { pull_requests: "write", issues: "write" },
      botLogin: "acme-reviewer[bot]",
      botGitEmail: "100000002+acme-reviewer[bot]@users.noreply.github.com",
      tokenExpiresAt: "2026-08-31T00:52:10Z",
    })
    expect(Object.keys(JSON.parse(output))).toEqual([
      "role",
      "app",
      "appId",
      "installationId",
      "account",
      "repositorySelection",
      "permissions",
      "botLogin",
      "botGitEmail",
      "tokenExpiresAt",
    ])
  })
})
