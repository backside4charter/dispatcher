import { existsSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { forwardEventsFor } from "./board-events"
import { CONFIG_FILE_NAME, loadDispatcherConfig, repositoryOwner } from "./board/config"
import type { DispatcherConfig } from "./board/config"
import { LinearClient, resolveLinearApiKey } from "./board/linear/client"
import { consumePendingEvents, isListenerUp, readPendingEvents } from "./event-log"
import { DEFAULT_LINEAR_POLL_MS, DEFAULT_LISTENER_PORT, startListener } from "./listener"
import type { LinearListenerOptions } from "./listener"
import { waitForEvents } from "./waiter"

/**
 * Output sinks for the CLI, injectable so tests can capture what a command
 * prints without spawning a process.
 */
export interface CliIo {
  /** Writes one line to stdout. */
  out: (line: string) => void
  /** Writes one line to stderr. */
  err: (line: string) => void
}

/** Runtime hooks for long-running commands. */
export interface CliRuntime {
  /** Aborting this signal stops a running `listen` command gracefully. */
  signal?: AbortSignal
}

/** Parsed options for the `listen` command. */
export interface ListenCliOptions {
  /** Loopback port to bind; 0 picks an ephemeral port; undefined defers to the config. */
  port?: number
  /** Whether to spawn and supervise `gh webhook forward`. */
  forward: boolean
  /** GitHub organization whose webhooks are forwarded; undefined derives it from the config's repository. */
  org?: string
  /** Webhook event names to subscribe to; undefined means the configured platform's set. */
  events?: string[]
  /** Whether to poll Linear for board changes (only meaningful on the Linear platform). */
  linear: boolean
  /** Linear poll interval in milliseconds. */
  linearPollMs: number
  /** Explicit dispatcher config path, if given. */
  config?: string
  /** Platform override, if given. */
  platform?: string
  /** Explicit state directory, if given. */
  dir?: string
}

const USAGE_LINES = [
  "usage: dispatcher <listen|status|wait|consume> [options]",
  "",
  "commands:",
  "  listen    start the loopback webhook listener + supervised `gh webhook forward` + (on Linear) the poller",
  "            [--port <n>] [--no-forward] [--org <org>] [--events <a,b,c>]",
  "            [--no-linear] [--linear-poll-ms <n>] [--config <path>] [--platform linear|github] [--dir <path>]",
  "  status    report whether the listener is up and how many events are pending",
  "            [--dir <path>]  (exit 0 = up, 1 = down)",
  "  wait      block until new board events arrive, then exit (the dispatcher's wake primitive)",
  "            [--timeout-seconds <n>] [--debounce-ms <n>] [--poll-ms <n>] [--dir <path>]",
  "  consume   print pending events and advance the consumed cursor past them",
  "            [--dir <path>]",
]

/**
 * Resolves the state directory shared by the listener and the dispatcher-side
 * commands: an explicit --dir wins, then DISPATCHER_STATE_DIR, then
 * `.claude/dispatcher` beside the nearest `dispatcher.config.json` at or
 * above the working directory.
 *
 * The config file is the root marker because it is what makes a repository
 * dispatcher-enabled at all, and because it is committed: a git worktree
 * nested under the main checkout's `.claude/worktrees/` carries its own copy,
 * so the walk stops at the worktree instead of climbing out and silently
 * sharing the main checkout's state directory. The walk starts from the
 * working directory rather than this module because in a compiled binary
 * `import.meta.url` points inside the executable, not at any repository.
 */
export function resolveStateDir(
  explicitDir: string | undefined,
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): string {
  if (explicitDir !== undefined && explicitDir !== "") return path.resolve(explicitDir)
  const fromEnv = env.DISPATCHER_STATE_DIR
  if (fromEnv !== undefined && fromEnv !== "") return path.resolve(fromEnv)
  let current = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(current, CONFIG_FILE_NAME))) {
      return path.join(current, ".claude", "dispatcher")
    }
    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`no ${CONFIG_FILE_NAME} found above ${cwd}; run from inside a dispatcher-enabled repository, or pass --dir`)
    }
    current = parent
  }
}

/**
 * Parses a numeric flag value, failing loudly on garbage rather than letting
 * NaN propagate into timers.
 */
function parseNumberFlag(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name}: ${raw}`)
  return value
}

/**
 * Parses the `listen` command's flags into listener options.
 */
export function parseListenOptions(argv: string[]): ListenCliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      port: { type: "string" },
      org: { type: "string" },
      events: { type: "string" },
      "no-forward": { type: "boolean" },
      "no-linear": { type: "boolean" },
      "linear-poll-ms": { type: "string" },
      config: { type: "string" },
      platform: { type: "string" },
    },
    strict: true,
  })
  let port: number | undefined
  if (values.port !== undefined) {
    port = parseNumberFlag("--port", values.port, DEFAULT_LISTENER_PORT)
    if (!Number.isInteger(port) || port > 65535) throw new Error(`invalid --port: ${values.port}`)
  }
  const events = values.events === undefined
    ? undefined
    : values.events.split(",").map((event) => event.trim()).filter((event) => event !== "")
  const linearPollMs = parseNumberFlag("--linear-poll-ms", values["linear-poll-ms"], DEFAULT_LINEAR_POLL_MS)
  if (linearPollMs < 1000) throw new Error(`invalid --linear-poll-ms: ${values["linear-poll-ms"]} (minimum 1000)`)
  return {
    port,
    forward: values["no-forward"] !== true,
    org: values.org,
    events,
    linear: values["no-linear"] !== true,
    linearPollMs,
    config: values.config,
    platform: values.platform,
    dir: values.dir,
  }
}

/**
 * Resolves the listen settings that layer flags over the config: an explicit
 * --port wins over the config's `listener.port` over the default, and an
 * explicit --org wins over the owner of the config's repository.
 */
export function resolveListenSettings(
  options: Pick<ListenCliOptions, "port" | "org">,
  config: DispatcherConfig,
): { port: number; org: string } {
  return {
    port: options.port ?? config.listener?.port ?? DEFAULT_LISTENER_PORT,
    org: options.org ?? repositoryOwner(config),
  }
}

/**
 * Parses the single `--dir` flag shared by status and consume.
 */
function parseDirOnly(argv: string[]): string | undefined {
  const { values } = parseArgs({
    args: argv,
    options: { dir: { type: "string" } },
    strict: true,
  })
  return values.dir
}

/**
 * `status`: reports listener liveness, forward-channel health, and the count
 * of unconsumed events. Exits 0 when the listener is up, 1 when it is down,
 * so scripts can branch on it; the dispatcher reads the text either way.
 */
function commandStatus(argv: string[], io: CliIo): number {
  const dir = resolveStateDir(parseDirOnly(argv), process.env)
  const pending = readPendingEvents(dir).events.length
  const result = isListenerUp(dir)
  if (result.up && result.heartbeat !== undefined) {
    const { heartbeat } = result
    io.out(`listener: up (pid ${heartbeat.pid}, port ${heartbeat.port})`)
    if (!heartbeat.forward.enabled) {
      io.out("forward: disabled (--no-forward)")
    } else if (heartbeat.forward.running) {
      io.out(`forward: running (restarts ${heartbeat.forward.restarts})`)
    } else {
      io.out(`forward: NOT running (restarts ${heartbeat.forward.restarts})`)
    }
    if (heartbeat.forward.lastError !== null) {
      io.out(`forward error: ${heartbeat.forward.lastError}`)
    }
    const { linear } = heartbeat
    if (linear === undefined || !linear.enabled) {
      io.out(`linear: off${linear?.lastError == null ? "" : ` - ${linear.lastError}`}`)
    } else {
      const last = linear.lastPollAt === null ? "never" : linear.lastPollAt
      io.out(`linear: ${linear.running ? "polling" : "stopped"} (${linear.polls} polls, ${linear.errors} errors, last ${last})`)
      if (linear.lastError !== null) io.out(`linear error: ${linear.lastError}`)
    }
    io.out(`events: ${heartbeat.eventsAccepted} accepted, ${heartbeat.eventsIgnored} ignored since start`)
    io.out(`pending: ${pending} unconsumed event(s)`)
    return 0
  }
  io.out(`listener: down - ${result.reason ?? "unknown"}`)
  io.out(`pending: ${pending} unconsumed event(s)`)
  return 1
}

/**
 * `consume`: prints all pending events and advances the consumed cursor past
 * them, so the next wait blocks until something genuinely new arrives.
 */
function commandConsume(argv: string[], io: CliIo): number {
  const dir = resolveStateDir(parseDirOnly(argv), process.env)
  const events = consumePendingEvents(dir)
  if (events.length === 0) {
    io.out("no pending events")
    return 0
  }
  for (const event of events) {
    io.out(`[${event.receivedAt}] ${event.summary}`)
  }
  io.out(`consumed ${events.length} event(s)`)
  return 0
}

/**
 * `wait`: blocks until new board events land in the log, then exits - the
 * dispatcher runs this as a background task and its completion is the wake.
 * Never consumes anything (only `consume` advances the cursor), and always
 * exits 0: every outcome (wake, timeout, channel-down, already-waiting) is a
 * normal state the dispatcher routes on from the first output line.
 */
async function commandWait(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: "string" },
      "timeout-seconds": { type: "string" },
      "debounce-ms": { type: "string" },
      "poll-ms": { type: "string" },
    },
    strict: true,
  })
  const dir = resolveStateDir(values.dir, process.env)
  const timeoutSeconds = parseNumberFlag("--timeout-seconds", values["timeout-seconds"], 1740)
  const debounceMs = parseNumberFlag("--debounce-ms", values["debounce-ms"], 5000)
  const pollIntervalMs = parseNumberFlag("--poll-ms", values["poll-ms"], 1000)
  const outcome = await waitForEvents({
    dir,
    timeoutMs: timeoutSeconds * 1000,
    debounceMs,
    pollIntervalMs,
  })
  switch (outcome.kind) {
    case "events":
      io.out(`wake: ${outcome.events.length} new board event(s)`)
      for (const event of outcome.events) {
        io.out(`[${event.receivedAt}] ${event.summary}`)
      }
      return 0
    case "channel-down":
      io.out(`channel-down: ${outcome.reason}`)
      return 0
    case "already-waiting":
      io.out(`already-waiting: another waiter (pid ${outcome.pid}) is already running`)
      return 0
    case "timeout":
      io.out(`timeout: no board events within ${timeoutSeconds}s`)
      return 0
    default:
      return 0
  }
}

/**
 * `listen`: starts the loopback listener plus (unless --no-forward) the
 * supervised `gh webhook forward` child, then runs until the runtime signal
 * aborts (SIGINT/SIGTERM in a real process). Stopping removes the heartbeat
 * so the channel reads as down immediately.
 */
async function commandListen(argv: string[], io: CliIo, runtime: CliRuntime): Promise<number> {
  const options = parseListenOptions(argv)
  const dir = resolveStateDir(options.dir, process.env)
  const { config, path: configPath } = loadDispatcherConfig({ explicitPath: options.config, platformOverride: options.platform })
  const { port, org } = resolveListenSettings(options, config)
  const events = options.events ?? forwardEventsFor(config.platform)
  // A missing Linear API key degrades the channel to GitHub deliveries alone
  // rather than refusing to start: the PR side still accelerates the loop.
  let linear: LinearListenerOptions | undefined
  let linearDisabledReason: string | undefined
  if (config.platform !== "linear") {
    linearDisabledReason = `board platform is ${config.platform}`
  } else if (!options.linear) {
    linearDisabledReason = "disabled (--no-linear)"
  } else if (config.linear === undefined) {
    linearDisabledReason = "no linear section in the dispatcher config"
  } else {
    try {
      linear = {
        client: new LinearClient(resolveLinearApiKey()),
        projectId: config.linear.projectId,
        intervalMs: options.linearPollMs,
      }
    } catch (error) {
      linearDisabledReason = error instanceof Error ? error.message : String(error)
    }
  }
  const handle = await startListener({
    dir,
    port,
    forward: options.forward,
    org,
    platform: config.platform,
    events,
    linear,
    linearDisabledReason,
  })
  io.out(`dispatcher event listener started (pid ${process.pid})`)
  io.out(`state dir: ${dir}`)
  io.out(`board: ${config.platform} (${configPath})`)
  io.out(`webhook endpoint: http://127.0.0.1:${handle.port}/webhook`)
  if (options.forward) {
    io.out(`forwarding org "${org}" events via gh webhook forward: ${events.join(", ")}`)
  } else {
    io.out("forwarding disabled (--no-forward); POST GitHub deliveries to the endpoint manually")
  }
  if (linear !== undefined) {
    io.out(`polling Linear project ${linear.projectId} every ${options.linearPollMs}ms`)
  } else {
    io.out(`Linear polling off: ${linearDisabledReason ?? "unknown"}`)
  }
  await new Promise<void>((resolve) => {
    const { signal } = runtime
    if (signal === undefined) return // run until the process is killed
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener("abort", () => { resolve() }, { once: true })
  })
  await handle.stop()
  io.out("listener stopped")
  return 0
}

/**
 * Dispatches one CLI invocation. Returns the process exit code; never throws
 * (argument errors print to stderr and exit 2).
 */
export async function runCli(argv: string[], io: CliIo, runtime: CliRuntime = {}): Promise<number> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case "listen":
        return await commandListen(rest, io, runtime)
      case "status":
        return commandStatus(rest, io)
      case "consume":
        return commandConsume(rest, io)
      case "wait":
        return await commandWait(rest, io)
      default:
        for (const line of USAGE_LINES) io.err(line)
        return 2
    }
  } catch (error) {
    io.err(`error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

/**
 * Runs the event-channel CLI with real process wiring: output to
 * stdout/stderr, SIGINT/SIGTERM aborting a running `listen` gracefully.
 * Execution belongs to main.ts alone - a module-level "am I the entrypoint"
 * guard here would misfire in the compiled binary, where bundling gives every
 * module the entry's `import.meta.url`.
 */
export async function runCliFromProcess(argv: string[]): Promise<number> {
  const controller = new AbortController()
  process.once("SIGINT", () => { controller.abort() })
  process.once("SIGTERM", () => { controller.abort() })
  const io: CliIo = {
    out: (line) => { console.log(line) },
    err: (line) => { console.error(line) },
  }
  return runCli(argv, io, { signal: controller.signal })
}
