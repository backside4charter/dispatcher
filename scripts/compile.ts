/**
 * Compiles the unified dispatcher CLI (src/main.ts) into self-contained
 * executables with `bun build --compile` - one binary per target, every
 * subcommand included. Output lands in dist/ as `dispatcher-<target>`
 * (`.exe` on Windows). Cross-compilation works from any host: bun downloads
 * and caches the target runtime on first use.
 *
 * Usage: `just compile [target ...]`
 * - no arguments: the host platform's target
 * - explicit keys: any of the TARGETS below
 * - `all`: every supported target
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, "..")

/** Every OS/arch pair the CLI compiles for, keyed by the name in the filename. */
const TARGETS: Record<string, { bunTarget: string; suffix: string }> = {
  "windows-x64": { bunTarget: "bun-windows-x64", suffix: ".exe" },
  "linux-x64": { bunTarget: "bun-linux-x64", suffix: "" },
  "linux-arm64": { bunTarget: "bun-linux-arm64", suffix: "" },
  "darwin-x64": { bunTarget: "bun-darwin-x64", suffix: "" },
  "darwin-arm64": { bunTarget: "bun-darwin-arm64", suffix: "" },
}

/**
 * Asserts the Bun on PATH is exactly the version pinned in `.bun-version`.
 *
 * `bun build --compile` embeds the compiling runtime in the binary, so the
 * build machine's Bun is a shipped artifact: two Buns produce materially
 * different executables from the same commit. Exact match rather than a
 * floor: a floor would let a later `bun upgrade` bake a different runtime
 * into the same release SHA while the pin went on recording the old one.
 */
function assertPinnedBun(): string {
  const pinPath = path.join(packageRoot, ".bun-version")
  const required = readFileSync(pinPath, "utf8").trim()
  const actual = execFileSync("bun", ["--version"], { encoding: "utf8" }).trim()
  if (actual !== required) {
    throw new Error(
      `bun ${actual} does not match the ${required} pinned in .bun-version, so it must not `
      + "compile a shippable dispatcher binary. Install the pinned runtime with "
      + `\`bun install -g bun@${required}\`, or move the pin deliberately: edit .bun-version `
      + "and install the matching Bun in the same commit.",
    )
  }
  return actual
}

/**
 * The target key matching the machine running this script.
 */
function hostTargetKey(): string {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  return `${os}-${arch}`
}

/**
 * Resolves the argument list to target keys: none means the host, `all` means
 * everything, and anything unrecognized fails loudly with the supported list.
 */
function resolveTargetKeys(args: string[]): string[] {
  const supported = Object.keys(TARGETS)
  if (args.length === 0) {
    const host = hostTargetKey()
    if (!(host in TARGETS)) throw new Error(`no compile target for this machine (${host}); pass one of: ${supported.join(", ")}`)
    return [host]
  }
  if (args.length === 1 && args[0] === "all") return supported
  for (const key of args) {
    if (!(key in TARGETS)) throw new Error(`unknown target "${key}"; supported: ${supported.join(", ")} (or "all")`)
  }
  return args
}

/**
 * Compiles one target into dist/ and returns the output path.
 */
function compileTarget(key: string, version: string): string {
  const target = TARGETS[key]
  if (target === undefined) throw new Error(`unknown target "${key}"`)
  const outFile = path.join(packageRoot, "dist", `dispatcher-${key}${target.suffix}`)
  execFileSync("bun", [
    "build",
    "--compile",
    "--minify",
    `--target=${target.bunTarget}`,
    "--define", `process.env.DISPATCHER_VERSION:"${version}"`,
    path.join(packageRoot, "src", "main.ts"),
    "--outfile", outFile,
  ], { cwd: packageRoot, stdio: "inherit" })
  return outFile
}

const bunVersion = assertPinnedBun()
const packageJson = z.object({ version: z.string() }).parse(
  JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")),
)
const keys = resolveTargetKeys(process.argv.slice(2))

console.log(`compiling dispatcher ${packageJson.version} with bun ${bunVersion}: ${keys.join(", ")}`)
mkdirSync(path.join(packageRoot, "dist"), { recursive: true })
for (const key of keys) {
  const outFile = compileTarget(key, packageJson.version)
  const sizeMb = (statSync(outFile).size / (1024 * 1024)).toFixed(1)
  console.log(`  ${path.relative(packageRoot, outFile)}  ${sizeMb} MB`)
}
