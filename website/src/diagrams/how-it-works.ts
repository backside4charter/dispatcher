import type { FlowDiagram } from "./types"

/**
 * A task's journey across the Linear board, drawn as the board: seven
 * columns left to right in workflow order, one card per column: the main
 * flow on the top row, the two detour states on the lower row. Colours are the board's own state
 * colours as Linear shows them. Solid arrows are the main flow; dashed ones
 * are the detours through Question and Changes Requested. Columns are 150
 * wide on a 160 pitch; cards are 134 by 64 on two rows.
 */
const COLUMN_W = 150
const PITCH = 160
const CARD_W = 134
const CARD_H = 64
const ROW_1 = 80
const ROW_2 = 180

/** Left edge of column `i`. */
const col = (i: number): number => 10 + i * PITCH
/** Left edge of a card in column `i`. */
const card = (i: number): number => col(i) + 8

export const howItWorks: FlowDiagram = {
  viewBox: "0 0 1130 300",
  maxWidth: 1130,
  minWidth: 900,
  label:
    "The board's seven columns left to right: Backlog, Ready, Changes Requested, In Progress, Question, Human Review, Done. "
    + "Solid arrows run Backlog to Ready to In Progress to Human Review to Done along the top row. "
    + "Dashed arrows on the lower row: In Progress to Question, Question back to Ready, Question and In Progress back to Changes Requested, "
    + "Human Review back to Changes Requested, and Changes Requested back to In Progress.",
  zones: [
    { style: "column", tone: "backlog", label: "Backlog", x: col(0), y: 10, w: COLUMN_W, h: 280 },
    { style: "column", tone: "ready", label: "Ready", x: col(1), y: 10, w: COLUMN_W, h: 280 },
    { style: "column", tone: "changes", label: "Changes Requested", x: col(2), y: 10, w: COLUMN_W, h: 280 },
    { style: "column", tone: "progress", label: "In Progress", x: col(3), y: 10, w: COLUMN_W, h: 280 },
    { style: "column", tone: "question", label: "Question", x: col(4), y: 10, w: COLUMN_W, h: 280 },
    { style: "column", tone: "review", label: "Human Review", x: col(5), y: 10, w: COLUMN_W, h: 280 },
    { style: "column", tone: "done", label: "Done", x: col(6), y: 10, w: COLUMN_W, h: 280 },
  ],
  edges: [
    // the main flow, along the top row
    { d: "M152 112 L178 112" },
    { d: "M312 112 L498 112" },
    { d: "M632 112 L818 112" },
    { d: "M952 112 L978 112" },
    // detours, along the lower row
    { d: "M610 144 L610 198 L658 198", tone: "muted", dash: true, label: { text: "asks you", x: 616, y: 172 } },
    { d: "M725 180 L725 58 L245 58 L245 80", tone: "muted", dash: true, label: { text: "you answer", x: 485, y: 54, anchor: "middle" } },
    { d: "M658 226 L472 226", tone: "muted", dash: true, label: { text: "you answer, PR exists", x: 600, y: 240, anchor: "middle" } },
    { d: "M540 144 L540 226", tone: "muted", dash: true, noArrow: true, label: { text: "finds problems", x: 546, y: 190 } },
    { d: "M472 196 L485 196 L485 128 L498 128", tone: "muted", dash: true, label: { text: "re-dispatched", x: 479, y: 166, anchor: "end" } },
    { d: "M920 144 L920 262 L405 262 L405 244", tone: "muted", dash: true, label: { text: "you request changes", x: 926, y: 204 } },
  ],
  stages: [
    { id: "backlog", tone: "backlog", label: "Backlog", sub: "not yet", x: card(0), y: ROW_1, w: CARD_W, h: CARD_H },
    { id: "ready", tone: "ready", label: "Ready", sub: "go · never worked", x: card(1), y: ROW_1, w: CARD_W, h: CARD_H },
    { id: "changes-requested", tone: "changes", label: "Changes Requested", sub: "same PR, more commits", x: card(2), y: ROW_2, w: CARD_W, h: CARD_H },
    { id: "in-progress", tone: "progress", label: "agents at work", sub: "build, then review", x: card(3), y: ROW_1, w: CARD_W, h: CARD_H },
    { id: "question", tone: "question", label: "Question", sub: "needs your decision", x: card(4), y: ROW_2, w: CARD_W, h: CARD_H },
    { id: "human-review", tone: "review", label: "Human Review", sub: "the PR waits for you", x: card(5), y: ROW_1, w: CARD_W, h: CARD_H },
    { id: "done", tone: "done", label: "Done", sub: "merged", x: card(6), y: ROW_1, w: CARD_W, h: CARD_H },
  ],
}
