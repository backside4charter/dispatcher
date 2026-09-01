import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { forwardEventsFor, mapWebhookDelivery } from "./board-events"
import type { LinearGraphql } from "./board/linear/client"
import { createLinearPoller } from "./board/linear/poll"
import type { LinearPollState } from "./board/linear/poll"
import type { BoardPlatform } from "./board/types"
import { appendEvent, clearListenerHeartbeat, ensureStateDir, writeListenerHeartbeat } from "./event-log"
import type { ListenerForwardState } from "./event-log"

/** Default loopback port the listener binds; override per project via the config's `listener.port`. */
export const DEFAULT_LISTENER_PORT = 47831

/**
 * Default Linear poll interval. Two queries per poll at this rate is ~240
 * requests an hour against Linear's 2,500/hour budget, leaving the dispatcher
 * session's own calls plenty of room.
 */
export const DEFAULT_LINEAR_POLL_MS = 30_000

/** A command to run as the forward child process. */
export interface ForwardCommand {
  command: string
  args: string[]
}

/** How the listener polls Linear for board changes. */
export interface LinearListenerOptions {
  client: LinearGraphql
  projectId: string
  intervalMs?: number
}

/** Options for starting the webhook listener. */
export interface ListenerOptions {
  /** State directory for the event log, cursor, and heartbeat. */
  dir: string
  /** Loopback port to listen on; 0 picks an ephemeral port. */
  port: number
  /** Whether to spawn and supervise `gh webhook forward`. */
  forward: boolean
  /** GitHub organization whose webhooks to forward; required when `forward` is on and no `forwardCommand` is injected. */
  org?: string
  /** Which platform the board lives on; decides which webhook events carry board signal. */
  platform?: BoardPlatform
  /** Webhook event names to subscribe to; defaults to the platform's set. */
  events?: string[]
  /** Test override for the forward command; receives the local webhook URL. */
  forwardCommand?: (url: string) => ForwardCommand
  /** Restart backoff bounds for the forward process. */
  restartBackoffMs?: { initial: number; max: number }
  /** How often the heartbeat file is refreshed. */
  heartbeatIntervalMs?: number
  /** Poll Linear for board changes; omit to run on GitHub deliveries alone. */
  linear?: LinearListenerOptions
  /** Why Linear polling is off (recorded in the heartbeat when `linear` is omitted). */
  linearDisabledReason?: string
}

/** A running listener. */
export interface ListenerHandle {
  /** The actual port the listener bound to. */
  port: number
  /** Stops the listener, the forward child, and the heartbeat. */
  stop: () => Promise<void>
}

/** Maximum accepted webhook body size; GitHub caps payloads at 25 MB, board payloads are tiny. */
const MAX_BODY_BYTES = 1024 * 1024

/** A forward child that survives at least this long resets the restart backoff. */
const BACKOFF_RESET_AFTER_MS = 120_000

/**
 * Builds the real `gh webhook forward` command for an org-level webhook.
 */
function defaultForwardCommand(org: string, events: string[]): (url: string) => ForwardCommand {
  return (url: string) => ({
    command: "gh",
    args: ["webhook", "forward", `--org=${org}`, `--events=${events.join(",")}`, `--url=${url}`],
  })
}

/**
 * Sends a JSON response.
 */
function respondJson(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json" })
  res.end(payload)
}

/**
 * Reads a request body up to MAX_BODY_BYTES, rejecting anything larger.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")) })
    req.on("error", reject)
  })
}

/**
 * Starts the loopback webhook listener and, unless disabled, the supervised
 * `gh webhook forward` child process that feeds it.
 *
 * Features:
 * - POST /webhook accepts GitHub deliveries (as forwarded by `gh webhook
 *   forward`), maps them through mapWebhookDelivery, and appends accepted
 *   events to the JSONL log; ignored deliveries are acknowledged but not
 *   logged.
 * - GET /healthz serves the current heartbeat.
 * - A heartbeat file is refreshed on an interval and after every delivery so
 *   the waiter and status commands can tell the listener is alive.
 * - The forward child is restarted with exponential backoff when it exits or
 *   fails to spawn; failures are recorded in the heartbeat rather than thrown,
 *   so a missing `gh` or a dropped connection degrades to polling instead of
 *   killing the channel.
 */
export async function startListener(options: ListenerOptions): Promise<ListenerHandle> {
  const {
    dir,
    forward,
    org,
    platform = "linear",
    events = forwardEventsFor(platform),
    heartbeatIntervalMs = 15_000,
    restartBackoffMs = { initial: 5_000, max: 300_000 },
  } = options
  if (forward && org === undefined && options.forwardCommand === undefined) {
    throw new Error("forward requires an org (derived from the config's repository) or an injected forwardCommand")
  }

  ensureStateDir(dir)

  const startedAt = new Date().toISOString()
  let eventsAccepted = 0
  let eventsIgnored = 0
  let stopping = false
  let child: ChildProcess | null = null
  let restartTimer: NodeJS.Timeout | null = null
  let backoffStep = 0
  let spawnedAtMs = 0
  let boundPort = options.port
  const forwardState: ListenerForwardState = {
    enabled: forward,
    running: false,
    restarts: 0,
    lastError: null,
  }
  let linearState: LinearPollState = {
    enabled: false,
    running: false,
    polls: 0,
    errors: 0,
    lastPollAt: null,
    lastError: options.linearDisabledReason ?? null,
  }

  /**
   * Writes the current heartbeat snapshot.
   */
  const writeHeartbeat = (): void => {
    if (stopping) return
    writeListenerHeartbeat(dir, {
      pid: process.pid,
      port: boundPort,
      startedAt,
      updatedAt: new Date().toISOString(),
      eventsAccepted,
      eventsIgnored,
      forward: forwardState,
      linear: linearState,
    })
  }

  /**
   * Handles one incoming HTTP request.
   */
  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (req.method === "GET" && req.url === "/healthz") {
      respondJson(res, 200, {
        pid: process.pid,
        port: boundPort,
        eventsAccepted,
        eventsIgnored,
        forward: { ...forwardState },
        linear: { ...linearState },
      })
      return
    }
    if (req.method !== "POST" || req.url !== "/webhook") {
      respondJson(res, 404, { error: "not found" })
      return
    }
    const eventHeader = req.headers["x-github-event"]
    const eventName = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader
    if (!eventName) {
      respondJson(res, 400, { error: "missing x-github-event header" })
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(await readBody(req))
    } catch {
      respondJson(res, 400, { error: "unparseable body" })
      return
    }
    const mapping = mapWebhookDelivery(eventName, payload, platform)
    if (mapping.accepted) {
      appendEvent(dir, {
        receivedAt: new Date().toISOString(),
        event: eventName,
        action: mapping.action,
        summary: mapping.summary,
      })
      eventsAccepted += 1
      writeHeartbeat()
      console.log(`[listener] event: ${mapping.summary}`)
      respondJson(res, 202, { accepted: true, summary: mapping.summary })
    } else {
      eventsIgnored += 1
      writeHeartbeat()
      respondJson(res, 200, { accepted: false, reason: mapping.reason })
    }
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      respondJson(res, 500, { error: String(error) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  const address: string | AddressInfo | null = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("listener did not bind a TCP port")
  }
  boundPort = address.port

  const webhookUrl = `http://127.0.0.1:${boundPort}/webhook`
  // The early guard above makes org defined whenever this fallback is reached
  // with forwarding on; the throw is unreachable and satisfies the narrowing.
  const makeCommand = options.forwardCommand ?? (org === undefined
    ? () => { throw new Error("forward requires an org") }
    : defaultForwardCommand(org, events))

  /**
   * Schedules a forward restart with exponential backoff. No-ops when one is
   * already scheduled or the listener is stopping.
   */
  const scheduleRestart = (): void => {
    if (stopping || restartTimer !== null) return
    const lived = Date.now() - spawnedAtMs
    if (lived >= BACKOFF_RESET_AFTER_MS) backoffStep = 0
    const delay = Math.min(restartBackoffMs.initial * 2 ** backoffStep, restartBackoffMs.max)
    backoffStep += 1
    forwardState.restarts += 1
    writeHeartbeat()
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnForward()
    }, delay)
  }

  /**
   * Spawns the forward child process and wires up supervision.
   */
  const spawnForward = (): void => {
    if (stopping) return
    const { command, args } = makeCommand(webhookUrl)
    spawnedAtMs = Date.now()
    const spawned = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    child = spawned
    forwardState.running = true
    writeHeartbeat()
    spawned.stdout?.on("data", (data: Buffer) => {
      console.log(`[gh-forward] ${data.toString("utf8").trimEnd()}`)
    })
    spawned.stderr?.on("data", (data: Buffer) => {
      console.error(`[gh-forward] ${data.toString("utf8").trimEnd()}`)
    })
    spawned.on("error", (error) => {
      forwardState.running = false
      forwardState.lastError = String(error)
      console.error(`[gh-forward] failed to start: ${String(error)}`)
      scheduleRestart()
    })
    spawned.on("exit", (code, signal) => {
      if (stopping) return
      forwardState.running = false
      forwardState.lastError = `forward process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`
      console.error(`[gh-forward] ${forwardState.lastError}; restarting`)
      scheduleRestart()
    })
  }

  /**
   * The Linear poller, when configured. Its events land in the same log as
   * webhook deliveries; its health rides in the heartbeat next to the forward
   * channel's.
   */
  const poller = options.linear === undefined ? null : createLinearPoller({
    client: options.linear.client,
    projectId: options.linear.projectId,
    intervalMs: options.linear.intervalMs ?? DEFAULT_LINEAR_POLL_MS,
    onEvent: (event) => {
      appendEvent(dir, event)
      eventsAccepted += 1
      writeHeartbeat()
      console.log(`[listener] event: ${event.summary}`)
    },
    onState: (state) => {
      linearState = state
      writeHeartbeat()
    },
  })

  const heartbeatTimer = setInterval(writeHeartbeat, heartbeatIntervalMs)
  writeHeartbeat()
  if (forward) spawnForward()
  if (poller !== null) await poller.start()

  /**
   * Stops the listener, the forward child, the Linear poller and the
   * heartbeat, and removes the heartbeat file so the channel reads as down
   * immediately.
   */
  const stop = async (): Promise<void> => {
    stopping = true
    poller?.stop()
    clearInterval(heartbeatTimer)
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (child !== null) {
      child.kill()
      child = null
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    clearListenerHeartbeat(dir)
  }

  return { port: boundPort, stop }
}
