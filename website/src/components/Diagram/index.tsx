import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { FlowDiagram, DiagramStage, Tone } from "@site/src/diagrams/types"

/**
 * An interactive flow diagram: an SVG drawn from a `FlowDiagram` whose stages
 * are clickable. Hovering a stage scales it up a little; clicking (or Enter /
 * Space) scales it up more, dims everything else on the page, and opens a
 * popover beside it with the stage's explanation, taken from the `<Stage>`
 * children. Escape, the close button, or a click elsewhere closes it. A stage
 * named in the URL as `#stage-<id>` opens on load.
 *
 * Usage in MDX:
 *
 *   <Diagram flow={howItWorks}>
 *     <Stage id="ready" title="Ready" k="you">
 *
 *     Prose, with ordinary Markdown links.
 *
 *     </Stage>
 *   </Diagram>
 */

/** Props of a `<Stage>`: the popover content for one stage id. */
export interface StageProps {
  /** Matches a stage id in the diagram. */
  id: string
  /** Popover heading. */
  title: string
  /** Small uppercase label above the heading, e.g. who acts here. */
  k?: string
  children?: React.ReactNode
}

/**
 * Declares a stage's popover content. Renders nothing itself; `<Diagram>`
 * reads its props from its children.
 */
export function Stage(_props: StageProps): null {
  return null
}

interface DiagramProps {
  flow: FlowDiagram
  /** Optional caption under the diagram. */
  caption?: React.ReactNode
  children?: React.ReactNode
}

/** How long the fade-out takes, matching the CSS transitions. */
const FADE_MS = 240

/** Fired on `document` when a diagram opens a stage, so the others close. */
const OPEN_EVENT = "dispatcher-diagram-open"

const HINT_ICON = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3 1.5 L12.5 8.2 L8.3 9 L10.8 13.6 L9 14.5 L6.5 9.9 L3.6 13 Z" fill="currentColor" />
  </svg>
)

/**
 * Collects the `<Stage>` children into a lookup by id.
 */
function collectStages(children: React.ReactNode): Map<string, StageProps> {
  const map = new Map<string, StageProps>()
  React.Children.forEach(children, (child) => {
    if (React.isValidElement<StageProps>(child) && child.type === Stage) {
      map.set(child.props.id, child.props)
    }
  })
  return map
}

/**
 * The marker id for an edge tone, per diagram instance so two diagrams on one
 * page never share ids.
 */
function markerFor(uid: string, tone: string | undefined): string {
  return `${uid}-arr${tone ? `-${tone}` : ""}`
}

/**
 * The interactive diagram.
 */
export function Diagram({ flow, caption, children }: DiagramProps): React.ReactElement {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "")
  const rootRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | null>(null)
  const stageEls = useRef(new Map<string, SVGGElement>())
  const stages = useMemo(() => collectStages(children), [children])

  const [activeId, setActiveId] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [raised, setRaised] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [style, setStyle] = useState<React.CSSProperties>({})

  useEffect(() => { setMounted(true) }, [])

  /**
   * Positions the popover beside the stage: to its right, else its left, else
   * centred below it; full width below it on a narrow screen.
   */
  const place = useCallback((id: string) => {
    const root = rootRef.current
    const pop = popRef.current
    const g = stageEls.current.get(id)
    if (!root || !pop || !g) return
    const w = root.getBoundingClientRect()
    const r = g.getBoundingClientRect()
    const narrow = window.matchMedia("(max-width: 700px)").matches
    if (narrow) {
      setStyle({ width: "100%", left: 0, top: r.bottom - w.top + 10 })
      return
    }
    const pw = pop.offsetWidth
    let left = r.right - w.left + 14
    let top = r.top - w.top
    if (left + pw > w.width) left = r.left - w.left - pw - 14
    if (left < 0) {
      left = Math.max(0, Math.min(r.left - w.left + (r.width - pw) / 2, w.width - pw))
      top = r.bottom - w.top + 10
    }
    setStyle({ left, top })
  }, [])

  const close = useCallback(() => {
    setShown(false)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => {
      setActiveId(null)
      setRaised(false)
      closeTimer.current = null
    }, FADE_MS)
  }, [])

  const open = useCallback((id: string) => {
    if (!stages.has(id)) return
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    // A stage click stops propagation, so another diagram on the page would
    // not see it as a click elsewhere; tell the others to close explicitly.
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: uid }))
    setActiveId(id)
    setRaised(true)
  }, [stages, uid])

  // Another diagram opening closes this one.
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== uid) close()
    }
    document.addEventListener(OPEN_EVENT, onOther)
    return () => { document.removeEventListener(OPEN_EVENT, onOther) }
  }, [uid, close])

  const toggle = useCallback((id: string) => {
    if (activeId === id && shown) close()
    else open(id)
  }, [activeId, shown, open, close])

  // Once the popover for the active stage is in the DOM, measure and place
  // it, then start the fade-in on the next frame so the transition runs.
  useLayoutEffect(() => {
    if (activeId === null) return
    place(activeId)
    const frame = window.requestAnimationFrame(() => { setShown(true) })
    return () => { window.cancelAnimationFrame(frame) }
  }, [activeId, place])

  // Escape and clicks elsewhere close; the window resizing re-places.
  useEffect(() => {
    if (activeId === null) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close() }
    const onClick = () => { close() }
    const onResize = () => { place(activeId) }
    document.addEventListener("keydown", onKey)
    document.addEventListener("click", onClick)
    window.addEventListener("resize", onResize)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("click", onClick)
      window.removeEventListener("resize", onResize)
    }
  }, [activeId, close, place])

  // A stage named in the URL opens on load.
  useEffect(() => {
    const match = /^#stage-(.+)$/.exec(window.location.hash)
    if (match?.[1] !== undefined && stages.has(match[1])) open(match[1])
    // Only on mount: the hash is read once, like a deep link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  const active = activeId === null ? null : stages.get(activeId) ?? null
  const activeStage: DiagramStage | undefined = flow.stages.find((s) => s.id === activeId)
  const popTone: Tone = activeStage?.tone ?? "plain"

  return (
    <figure className="diagram-figure">
      <p className="click-hint">{HINT_ICON}Click any stage for more info</p>
      <div ref={rootRef} className={`diagram${shown ? " focus" : ""}${raised ? " raised" : ""}`}>
        <div className="diagram-scroll">
        <svg
          className="narrow"
          style={{ maxWidth: flow.maxWidth, minWidth: flow.minWidth }}
          viewBox={flow.viewBox}
          role="img"
          aria-label={flow.label}
        >
          <defs>
            {(["", "muted", "bad", "ok"] as const).map((tone) => (
              <marker
                key={tone || "plain"}
                id={markerFor(uid, tone || undefined)}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" className={`arr${tone ? ` ${tone}` : ""}`} />
              </marker>
            ))}
          </defs>
          {flow.zones?.map((zone, i) => (zone.style === "column" ? (
            <React.Fragment key={`zone-${i}`}>
              <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx="12" className="col-bg" />
              {zone.label && (
                <>
                  {zone.tone && (
                    <circle cx={(zone.labelX ?? zone.x + 14) + 4} cy={(zone.labelY ?? zone.y + 24) - 4} r="4" className={`dot ${zone.tone}`} />
                  )}
                  <text x={(zone.labelX ?? zone.x + 14) + (zone.tone ? 14 : 0)} y={zone.labelY ?? zone.y + 24} textAnchor="start" className="t col-l">
                    {zone.label}
                  </text>
                </>
              )}
            </React.Fragment>
          ) : (
            <React.Fragment key={`zone-${i}`}>
              <rect x={zone.x} y={zone.y} width={zone.w} height={zone.h} rx="14" className={`zone${zone.tone ? ` ${zone.tone}` : ""}`} />
              {zone.label && (
                <text
                  x={zone.labelX ?? zone.x + zone.w - 15}
                  y={zone.labelY ?? zone.y + 22}
                  textAnchor="end"
                  className={`t zone-l${zone.tone ? ` ${zone.tone}` : ""}`}
                >
                  {zone.label}
                </text>
              )}
            </React.Fragment>
          )))}
          {/* edges first, so stages paint on top */}
          {flow.edges.map((edge, i) => (
            <React.Fragment key={`edge-${i}`}>
              <path
                d={edge.d}
                className={`e${edge.tone ? ` ${edge.tone}` : ""}${edge.dash ? " dash" : ""}`}
                markerEnd={edge.noArrow ? undefined : `url(#${markerFor(uid, edge.tone)})`}
              />
              {edge.label && (
                <text
                  x={edge.label.x}
                  y={edge.label.y}
                  textAnchor={edge.label.anchor ?? "start"}
                  className={`el${edge.label.tone ? ` ${edge.label.tone}` : ""}`}
                >
                  {edge.label.text}
                </text>
              )}
            </React.Fragment>
          ))}
          {flow.stages.map((stage) => {
            const hasContent = stages.has(stage.id)
            const isActive = stage.id === activeId
            return (
              <g
                key={stage.id}
                ref={(el) => { if (el) stageEls.current.set(stage.id, el); else stageEls.current.delete(stage.id) }}
                className={`hot${isActive ? " active" : ""}`}
                data-stage={stage.id}
                data-tone={stage.tone}
                tabIndex={hasContent ? 0 : -1}
                role="button"
                aria-label={`${stage.label} - show details`}
                aria-expanded={isActive && shown}
                onClick={(e) => { e.stopPropagation(); toggle(stage.id) }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    toggle(stage.id)
                  }
                }}
              >
                <rect x={stage.x} y={stage.y} width={stage.w} height={stage.h} rx="10" className={`node ${stage.tone}`} />
                <text x={stage.x + stage.w / 2} y={stage.y + (stage.sub ? 27 : 38)} textAnchor="middle" className="t b">{stage.label}</text>
                {stage.sub && (
                  <text x={stage.x + stage.w / 2} y={stage.y + 47} textAnchor="middle" className="t s">{stage.sub}</text>
                )}
              </g>
            )
          })}
        </svg>
        </div>
        {active && (
          <div
            ref={popRef}
            className={`pop ${popTone}${shown ? " show" : ""}`}
            style={style}
            role="dialog"
            aria-label={active.title}
            onClick={(e) => { e.stopPropagation() }}
          >
            <button className="close" type="button" aria-label="Close" onClick={close}>×</button>
            {active.k && <span className="k">{active.k}</span>}
            <h3>{active.title}</h3>
            {active.children}
          </div>
        )}
      </div>
      {flow.legend && (
        <ul className="legend" aria-label="Legend">
          {flow.legend.map((entry) => (
            <li key={entry.tone}><span className={`swatch ${entry.tone}`} aria-hidden="true" />{entry.label}</li>
          ))}
        </ul>
      )}
      {caption && <figcaption>{caption}</figcaption>}
      {mounted && createPortal(<div className={`dim${shown ? " show" : ""}`} aria-hidden="true" />, document.body)}
    </figure>
  )
}

export default Diagram
