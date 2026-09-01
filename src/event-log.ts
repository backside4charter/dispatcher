import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { boardEventSchema } from "./board-events"
import type { BoardEvent } from "./board-events"
import type { LinearPollState } from "./board/linear/poll"

/**
 * On-disk state layout (all inside one state directory):
 * - `events.jsonl`   append-only log of accepted board events, one per line
 * - `cursor.json`    byte offset up to which the dispatcher has consumed
 * - `listener.json`  the listener's heartbeat (pid, port, forward + Linear poll state)
 * - `waiter.json`    the active wake-waiter's lock (pid)
 */

/** A heartbeat older than this reads as a dead listener. */
export const HEARTBEAT_STALE_MS = 60_000

/** Supervision state of the `gh webhook forward` child process. */
export interface ListenerForwardState {
  /** Whether forwarding was requested at all (false in --no-forward mode). */
  enabled: boolean
  /** Whether the forward child process is currently running. */
  running: boolean
  /** How many times the forward process has been restarted. */
  restarts: number
  /** The most recent forward failure, or null if none. */
  lastError: string | null
}

/** Heartbeat the listener writes so other commands can tell it is alive. */
export interface ListenerHeartbeat {
  pid: number
  port: number
  startedAt: string
  updatedAt: string
  eventsAccepted: number
  eventsIgnored: number
  forward: ListenerForwardState
  /** Health of the Linear poller; absent in heartbeats written before it existed. */
  linear?: LinearPollState
}

/** Lock a waiter takes so only one wake-waiter runs per state dir. */
export interface WaiterLock {
  pid: number
  startedAt: string
}

/** Result of checking whether the listener is up. */
export interface ListenerUpResult {
  up: boolean
  reason?: string
  heartbeat?: ListenerHeartbeat
}

const listenerHeartbeatSchema = z.object({
  pid: z.number(),
  port: z.number(),
  startedAt: z.string(),
  updatedAt: z.string(),
  eventsAccepted: z.number(),
  eventsIgnored: z.number(),
  forward: z.object({
    enabled: z.boolean(),
    running: z.boolean(),
    restarts: z.number(),
    lastError: z.string().nullable(),
  }),
  linear: z.object({
    enabled: z.boolean(),
    running: z.boolean(),
    polls: z.number(),
    errors: z.number(),
    lastPollAt: z.string().nullable(),
    lastError: z.string().nullable(),
  }).optional(),
})

const waiterLockSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
})

const cursorSchema = z.object({
  offset: z.number(),
})

/**
 * Resolves the path of a state file inside the state directory.
 */
function stateFile(dir: string, name: string): string {
  return path.join(dir, name)
}

/**
 * Creates the state directory if it does not exist.
 */
export function ensureStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

/**
 * Reads and validates a JSON state file, returning null when the file is
 * absent or does not match the schema (a corrupt state file must degrade to
 * "no state", never throw).
 */
function readJsonFile<T>(file: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(file)) return null
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Appends one event to the JSONL event log.
 */
export function appendEvent(dir: string, event: BoardEvent): void {
  ensureStateDir(dir)
  appendFileSync(stateFile(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8")
}

/**
 * Returns the current byte size of the event log.
 */
export function logSize(dir: string): number {
  const file = stateFile(dir, "events.jsonl")
  if (!existsSync(file)) return 0
  return statSync(file).size
}

/**
 * Reads the consumed-cursor byte offset, clamped to the current log size so a
 * deleted or recreated log resets cleanly.
 */
function readCursorOffset(dir: string): number {
  const cursor = readJsonFile(stateFile(dir, "cursor.json"), cursorSchema)
  const size = logSize(dir)
  if (cursor === null || cursor.offset < 0 || cursor.offset > size) return 0
  return cursor.offset
}

/**
 * Reads events between the consumed cursor and the end of the log, without
 * advancing the cursor. Only complete (newline-terminated) lines are counted,
 * so a partially written last line is left for the next read. Unparseable
 * lines are skipped but still consumed.
 */
export function readPendingEvents(dir: string): { events: BoardEvent[]; endOffset: number } {
  const file = stateFile(dir, "events.jsonl")
  const offset = readCursorOffset(dir)
  if (!existsSync(file)) return { events: [], endOffset: 0 }
  const buffer = readFileSync(file)
  const slice = buffer.subarray(offset)
  const lastNewline = slice.lastIndexOf(0x0a)
  if (lastNewline === -1) return { events: [], endOffset: offset }
  const complete = slice.subarray(0, lastNewline + 1).toString("utf8")
  const events: BoardEvent[] = []
  for (const line of complete.split("\n")) {
    if (line.trim() === "") continue
    try {
      const parsed = boardEventSchema.safeParse(JSON.parse(line))
      if (parsed.success) events.push(parsed.data)
    } catch {
      // Skip unparseable lines; they are still consumed via endOffset.
    }
  }
  return { events, endOffset: offset + lastNewline + 1 }
}

/**
 * Reads pending events and advances the cursor past them.
 */
export function consumePendingEvents(dir: string): BoardEvent[] {
  const { events, endOffset } = readPendingEvents(dir)
  ensureStateDir(dir)
  writeFileSync(stateFile(dir, "cursor.json"), JSON.stringify({ offset: endOffset }), "utf8")
  return events
}

/**
 * Writes the listener heartbeat file.
 */
export function writeListenerHeartbeat(dir: string, heartbeat: ListenerHeartbeat): void {
  ensureStateDir(dir)
  writeFileSync(stateFile(dir, "listener.json"), JSON.stringify(heartbeat, null, 2), "utf8")
}

/**
 * Reads the listener heartbeat file, or null when absent or unparseable.
 */
export function readListenerHeartbeat(dir: string): ListenerHeartbeat | null {
  return readJsonFile(stateFile(dir, "listener.json"), listenerHeartbeatSchema)
}

/**
 * Removes the listener heartbeat file if present.
 */
export function clearListenerHeartbeat(dir: string): void {
  rmSync(stateFile(dir, "listener.json"), { force: true })
}

/**
 * Checks whether a pid refers to a live process. Signal 0 performs a liveness
 * probe without sending anything; EPERM still means the process exists.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

/**
 * Checks whether a live listener owns the state dir: a heartbeat file exists,
 * is fresh, and its pid is alive.
 */
export function isListenerUp(dir: string, nowMs = Date.now()): ListenerUpResult {
  const heartbeat = readListenerHeartbeat(dir)
  if (heartbeat === null) {
    return { up: false, reason: "no listener heartbeat (listener not started?)" }
  }
  const age = nowMs - Date.parse(heartbeat.updatedAt)
  if (Number.isNaN(age) || age > HEARTBEAT_STALE_MS) {
    return { up: false, reason: `listener heartbeat is stale (${Math.round(age / 1000)}s old)`, heartbeat }
  }
  if (!isPidAlive(heartbeat.pid)) {
    return { up: false, reason: `listener process ${heartbeat.pid} is not running`, heartbeat }
  }
  return { up: true, heartbeat }
}

/**
 * Reads the waiter lock, or null when absent or unparseable.
 */
export function readWaiterLock(dir: string): WaiterLock | null {
  return readJsonFile(stateFile(dir, "waiter.json"), waiterLockSchema)
}

/**
 * Writes the waiter lock.
 */
export function writeWaiterLock(dir: string, lock: WaiterLock): void {
  ensureStateDir(dir)
  writeFileSync(stateFile(dir, "waiter.json"), JSON.stringify(lock), "utf8")
}

/**
 * Removes the waiter lock if present.
 */
export function clearWaiterLock(dir: string): void {
  rmSync(stateFile(dir, "waiter.json"), { force: true })
}
