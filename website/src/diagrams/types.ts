/**
 * The geometry of an interactive flow diagram, as `<Diagram>` draws it. A
 * diagram file lists its stages (the clickable boxes), the edges between
 * them, and any zones grouping stages; the stage's explanatory text lives
 * beside the diagram in the page's MDX as `<Stage>` children, so it is
 * ordinary prose with ordinary links.
 *
 * Coordinates are SVG user units inside `viewBox`. A stage's detail goes in
 * its popover rather than on the arrows.
 */

/**
 * The colour of a stage: one of the board's workflow states, using the same
 * colours Linear shows for them, or `plain` for anything that is not a state.
 */
export type Tone = "backlog" | "ready" | "changes" | "progress" | "question" | "review" | "done" | "plain"

/** A clickable box. */
export interface DiagramStage {
  /** Stable id, also usable in a page URL as `#stage-<id>` to open it on load. */
  id: string
  tone: Tone
  /** Bold first line. */
  label: string
  /** Smaller second line. */
  sub?: string
  x: number
  y: number
  w: number
  h: number
}

/** A label beside an edge. */
export interface EdgeLabel {
  text: string
  x: number
  y: number
  anchor?: "start" | "middle" | "end"
  tone?: "bad" | "ok"
}

/** An arrow. `d` is an SVG path; the arrowhead follows the tone. */
export interface DiagramEdge {
  d: string
  tone?: "muted" | "bad" | "ok"
  dash?: boolean
  /** Draw no arrowhead: a connector that joins another edge's line. */
  noArrow?: boolean
  label?: EdgeLabel
}

/**
 * A rectangle grouping stages. `dashed` (the default) is an outline with a
 * small uppercase label at its top right; `column` is a filled board column
 * with a Linear-style header (a coloured dot and the state name) at its top
 * left.
 */
export interface DiagramZone {
  x: number
  y: number
  w: number
  h: number
  style?: "dashed" | "column"
  tone?: Tone
  label?: string
  labelX?: number
  labelY?: number
}

/** One entry of the legend under a diagram. */
export interface LegendEntry {
  tone: Tone
  label: string
}

/** One diagram. */
export interface FlowDiagram {
  /** `viewBox` attribute, e.g. "0 0 1130 300". */
  viewBox: string
  /** Rendered width cap in CSS pixels. */
  maxWidth: number
  /** Below this width the diagram scrolls sideways instead of shrinking further. */
  minWidth?: number
  /** Accessible description of the whole picture. */
  label: string
  zones?: DiagramZone[]
  edges: DiagramEdge[]
  stages: DiagramStage[]
  legend?: LegendEntry[]
}
