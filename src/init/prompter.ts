/**
 * Interactive prompting for `dispatcher init`, behind an interface so the
 * init flow is testable with scripted answers. The real implementation is
 * @clack/prompts - the prompt toolkit used by the create-app installers of
 * the modern JS ecosystem - so the wizard gets standard arrow-key selects,
 * styled confirms, and Ctrl+C cancel handling.
 */
import * as clack from "@clack/prompts"

/** Thrown when the user cancels a prompt (Ctrl+C); init exits cleanly on it. */
export class InitCancelledError extends Error {
  constructor() {
    super("init cancelled")
    this.name = "InitCancelledError"
  }
}

/** One selectable option in a choice prompt. */
export interface Choice<T> {
  label: string
  value: T
}

/** The prompt shapes init uses, injectable for tests. */
export interface Prompter {
  /** Free-text question; empty input returns the default (or "" without one). */
  ask(question: string, defaultValue?: string): Promise<string>
  /** Single-choice question. */
  choose<T>(question: string, choices: Choice<T>[], defaultIndex?: number): Promise<T>
  /** Yes/no question. */
  confirm(question: string, defaultValue: boolean): Promise<boolean>
  /** A styled informational note between prompts. */
  note(message: string, title?: string): void
  /** Releases anything the prompter holds. */
  close(): void
}

/**
 * Unwraps a clack result, translating a cancel into InitCancelledError.
 */
function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) throw new InitCancelledError()
  return value as T
}

/**
 * The real prompter over @clack/prompts. Requires an interactive terminal;
 * callers guard on `process.stdin.isTTY` before constructing one.
 */
export function createClackPrompter(): Prompter {
  return {
    async ask(question, defaultValue) {
      const answer = unwrap(await clack.text({
        message: question,
        defaultValue,
        placeholder: defaultValue,
      }))
      const trimmed = answer.trim()
      return trimmed === "" ? defaultValue ?? "" : trimmed
    },
    async choose(question, choices, defaultIndex = 0) {
      // Select over indices rather than the values themselves: clack's
      // Option<T> is conditional on T being primitive, which an unconstrained
      // generic cannot satisfy, and an index round-trip loses nothing.
      const picked = unwrap(await clack.select({
        message: question,
        options: choices.map((choice, index) => ({ value: index, label: choice.label })),
        initialValue: defaultIndex,
      }))
      return choices[picked]!.value
    },
    async confirm(question, defaultValue) {
      return unwrap(await clack.confirm({ message: question, initialValue: defaultValue }))
    },
    note(message, title) {
      clack.note(message, title)
    },
    close() {
      // clack owns no persistent handles; nothing to release.
    },
  }
}
