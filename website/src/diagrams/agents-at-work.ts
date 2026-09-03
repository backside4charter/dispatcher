import type { FlowDiagram } from "./types"

/**
 * Inside the In Progress column: the round a task takes between the
 * dispatcher session and the agents, as a narrow top-to-bottom spine. Each
 * card names the step with who does it underneath. The dashed loop on the
 * right is a send-back; the cleaner sits beside Human Review because it
 * serves PRs that are waiting to be merged.
 */
export const agentsAtWork: FlowDiagram = {
  viewBox: "-30 0 550 504",
  maxWidth: 571,
  label:
    "Top to bottom: the dispatcher claims and spawns, the developer agent builds one PR, the dispatcher verifies it, the reviewer agent reviews it, and the task reaches Human Review. "
    + "A dashed loop on the right sends a task from review back to build. Beside Human Review, the cleaner agent resolves conflicts with main and hands the PR back.",
  edges: [
    { d: "M120 84 L120 120", label: { text: "spawns", x: 128, y: 106 } },
    { d: "M120 184 L120 220", label: { text: "PR opened", x: 128, y: 206 } },
    { d: "M120 284 L120 320", label: { text: "hands over", x: 128, y: 306 } },
    { d: "M120 384 L120 420", label: { text: "passes", x: 128, y: 406 } },
    { d: "M220 352 L300 352 L300 152 L220 152", tone: "muted", dash: true, label: { text: "sent back · same PR", x: 308, y: 256 } },
    { d: "M220 440 L300 440", tone: "muted", dash: true, label: { text: "conflicts", x: 260, y: 432, anchor: "middle" } },
    { d: "M300 464 L220 464", tone: "muted", dash: true, label: { text: "mergeable", x: 260, y: 480, anchor: "middle" } },
  ],
  stages: [
    { id: "claim", tone: "plain", label: "claim & spawn", sub: "dispatcher", x: 20, y: 20, w: 200, h: 64 },
    { id: "build", tone: "progress", label: "build one PR", sub: "developer agent", x: 20, y: 120, w: 200, h: 64 },
    { id: "verify", tone: "plain", label: "verify", sub: "dispatcher", x: 20, y: 220, w: 200, h: 64 },
    { id: "review", tone: "progress", label: "review the PR", sub: "reviewer agent", x: 20, y: 320, w: 200, h: 64 },
    { id: "human-review", tone: "review", label: "Human Review", sub: "you", x: 20, y: 420, w: 200, h: 64 },
    { id: "clean", tone: "progress", label: "resolve conflicts", sub: "cleaner agent", x: 300, y: 420, w: 200, h: 64 },
  ],
}
