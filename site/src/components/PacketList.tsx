import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PacketRecord } from '../types'
import { docForTypeName } from '../lib/messages'
import { Inline } from '../lib/inline'
import { formatMs } from '../lib/hex'
import { inRanges, type Range } from '../lib/highlight'
import { rowOffsets, scrollTopToReveal, visibleRowWindow } from '../lib/packetWindow'
import { SessionTag, type SessionBadge } from './SessionTag'

/** Extra rows kept mounted past each edge of the viewport. */
const OVERSCAN_ROWS = 8

/**
 * A gap marker long enough to draw, matching the threshold `PacketList` used
 * before virtualization: back-to-back protocol chatter stays unmarked, a
 * pause long enough to be a human thinking or a query running gets one.
 */
const GAP_THRESHOLD_MS = 100

/**
 * Row heights assumed for the very first paint, before `RowProbe` below has
 * measured the real ones off-screen. Close enough that nothing visibly jumps
 * once the measurement lands a frame later.
 */
const FALLBACK_ROW_HEIGHT = 52
const FALLBACK_GAP_EXTRA_HEIGHT = 21

interface Props {
  packets: PacketRecord[]
  /**
   * Wall-clock time of each packet in `packets`, same order and length.
   *
   * Gap markers are computed from this rather than from `timestamp_ms`: in the
   * tabbed view the two agree, since every packet shares one session's clock,
   * but in the merged view consecutive rows can belong to different sessions,
   * and their `timestamp_ms` values are relative to different start times and
   * are not comparable.
   */
  wallClock: number[]
  /**
   * Each row's owning session id, same order and length as `packets`.
   *
   * A `PacketRecord`'s own `id` is only 1-based and dense within its own
   * session, so in the merged view two different sessions both have a packet
   * 1, a packet 2, and so on. Pairing a row's packet id with its session id
   * (see the `key` below) is what keeps React from treating two different
   * packets that happen to share an id as the same list item, which showed up
   * as rows silently duplicating or vanishing in a real multi-session
   * capture.
   */
  sessionIds: number[]
  selected: number
  onSelect: (index: number) => void
  /** Stretches this scenario exists to show. */
  ranges: readonly Range[]
  /**
   * Present only in the merged view: which session each row in `packets`
   * belongs to. Absent in the tabbed view, where the open tab already says
   * which session is on screen, so no per-row badge is needed.
   */
  sessionBadges?: Array<SessionBadge | undefined>
}

/**
 * The session as an ordered list of messages, in the order they crossed the wire.
 *
 * Every row has the same width and the same columns: number, direction, name and
 * summary, size. The eye tracks one set of columns down the page. Direction is
 * carried by an arrow and a coloured accent bar rather than by indentation, which
 * is what an earlier two-lane layout used and which made the list read as a
 * zigzag of differently sized rows.
 *
 * Timestamps used to be a column here and said almost nothing: a capture is over
 * in milliseconds, so every row read as roughly the same number. The one timing
 * fact worth having is where the session paused, and the gap markers show that on
 * their own.
 *
 * Virtualized the same way `HexDump` virtualizes a packet's bytes: only the
 * rows near the scroll position are ever mounted, while `.packet-list` (the
 * scroll container) is given the height the full list would occupy, so the
 * scrollbar still represents every packet and every row stays reachable by
 * scrolling to it. An uploaded capture's single session can run into the
 * thousands of packets, each row several DOM nodes deep, and mounting one
 * `<li>` per packet was what made stepping through a capture that size feel
 * broken rather than just slow.
 *
 * A packet row is not quite fixed height: a row preceded by a time-gap marker
 * is taller than a plain one. `RowProbe`, rendered once off-screen, measures
 * both real shapes so `packetWindow.ts`'s offset table is built from what the
 * browser actually renders rather than a guess that could drift from
 * styles.css on the next change to either.
 */
export function PacketList({
  packets,
  wallClock,
  sessionIds,
  selected,
  onSelect,
  ranges,
  sessionBadges,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const selectedButtonRef = useRef<HTMLButtonElement>(null)
  const probeRowRef = useRef<HTMLLIElement>(null)
  const probeGapRowRef = useRef<HTMLLIElement>(null)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [rowMetrics, setRowMetrics] = useState({
    rowHeight: FALLBACK_ROW_HEIGHT,
    gapExtraHeight: FALLBACK_GAP_EXTRA_HEIGHT,
  })

  // Present only in the merged view, where every row also carries a session
  // badge. The probe below needs to know, since the badge narrows the space
  // `packet-category` has to wrap in and so changes the real row height.
  const hasBadges = sessionBadges !== undefined

  // Whether the shipped faces have settled, so the probe below can measure
  // again once they have.
  //
  // The site ships its own sans and mono (see the @font-face rules at the top
  // of styles.css), both font-display: swap, so the first paint can use the
  // fallback and the real face can arrive after this component has already
  // measured. Row heights are mostly immune, because every line-height in the
  // stylesheet is a unitless multiple and so depends on font-size rather than
  // on the face's own metrics. `.time-gap` is the exception: its text wraps,
  // and a face even slightly wider can flip a gap label from one line to two.
  // That would leave the offset table short by a line's height on every gap
  // row, which is the same overlap the probe exists to prevent.
  const [fontsSettled, setFontsSettled] = useState(
    () => typeof document === 'undefined' || document.fonts?.status === 'loaded',
  )
  useEffect(() => {
    if (fontsSettled || typeof document === 'undefined' || !document.fonts) return
    let live = true
    document.fonts.ready.then(() => {
      if (live) setFontsSettled(true)
    })
    return () => {
      live = false
    }
  }, [fontsSettled])

  // Measure the two real row shapes off-screen, again whenever hasBadges
  // flips: toggling sessions in and out of the merged view can turn the
  // badge on or off without unmounting PacketList, and the probe's own
  // markup changes along with it, so the last measurement no longer applies.
  // And again once the fonts settle, for the reason just above.
  useLayoutEffect(() => {
    const rowEl = probeRowRef.current
    const gapRowEl = probeGapRowRef.current
    if (!rowEl || !gapRowEl) return
    const rowHeight = rowEl.getBoundingClientRect().height
    const gapExtraHeight = gapRowEl.getBoundingClientRect().height - rowHeight
    if (rowHeight > 0) {
      setRowMetrics({ rowHeight, gapExtraHeight: Math.max(0, gapExtraHeight) })
    }
  }, [hasBadges, fontsSettled])

  // Measure the actual scroll container, the same as HexDump: a ResizeObserver
  // keeps it right across window resizes and the responsive breakpoint that
  // changes the panel's own height.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Which rows carry a time-gap marker above them, so the offset table below
  // can give those rows their extra height. A plain array rather than
  // recomputing per row during render, since every consumer of "does row i
  // have a gap" (the offset table, the row itself) needs the same answer.
  const gapBefore = useMemo(
    () => packets.map((_, index) => index > 0 && wallClock[index]! - wallClock[index - 1]! > GAP_THRESHOLD_MS),
    [packets, wallClock],
  )

  const offsets = useMemo(
    () => rowOffsets(gapBefore, rowMetrics.rowHeight, rowMetrics.gapExtraHeight),
    [gapBefore, rowMetrics],
  )
  const totalHeight = offsets[offsets.length - 1] ?? 0

  // Ensure the selected row's slot is within the scrolled range. This runs
  // before the window below is computed, so if the selected row was not
  // mounted (a keyboard step or Home/End landed outside the current window),
  // adjusting scrollTop here is what brings it into the window this same
  // render pass computes.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const next = scrollTopToReveal(offsets, selected, el.scrollTop, el.clientHeight)
    if (next !== el.scrollTop) {
      el.scrollTop = next
      setScrollTop(next)
    }
  }, [selected, offsets])

  const { start, end } = visibleRowWindow(offsets, scrollTop, viewportHeight, OVERSCAN_ROWS)

  // Focus the selected row once it is actually mounted, but only in response
  // to a genuinely new selection, not to every scroll-driven change of
  // `start`/`end`. `lastFocusedSelection` is what tells the two apart: it is
  // this effect's own memory of which selection it has already handled.
  //
  // The gate on `[start, end]` matters because the row is not always mounted
  // on the first render after `selected` changes. A step that lands outside
  // the previous window is not: the layout effect above changes scrollTop,
  // which changes `start`/`end` on the *next* render, and only then does the
  // row actually exist in the DOM to focus. Without also re-running when
  // `start`/`end` change, a fast run of `j` could ask to focus a button that
  // was never mounted.
  //
  // The `lastFocusedSelection` gate is what keeps this from fighting the
  // reader's own scrolling the rest of the time: scrolling with the wheel or
  // the scrollbar changes `start`/`end` too, every time, with `selected`
  // unchanged, and without the gate this effect used to re-focus (and
  // `scrollIntoView`) the still-selected row on every one of those, snapping
  // the list straight back and making it look like the scrollbar did not
  // work at all.
  //
  // Focus follows the selection too, but only while it is already inside the
  // list. Without this, stepping with the arrow keys left focus on whichever
  // row was last clicked, so the next space or enter activated that row and
  // threw the reader back to it. Moving focus with the selection keeps the two
  // in step, and the roving tabindex below means tabbing in lands on the
  // selected row rather than on the first one.
  const lastFocusedSelection = useRef<number | null>(null)
  useEffect(() => {
    if (selected < start || selected > end) return
    if (lastFocusedSelection.current === selected) return
    lastFocusedSelection.current = selected

    const active = document.activeElement
    if (active !== selectedButtonRef.current && active && scrollRef.current?.contains(active)) {
      selectedButtonRef.current?.focus()
    }
  }, [selected, start, end])

  const rows: number[] = []
  for (let index = start; index <= end; index++) rows.push(index)

  return (
    <div className="panel packet-list-panel">
      <div className="panel-head">
        <h2>Messages</h2>
        <div className="lane-legend">
          <span className="lane-legend-item c2s">client →</span>
          <span className="lane-legend-item s2c">← server</span>
        </div>
      </div>

      <div
        className="packet-list"
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <ol className="packet-list-sizer" style={{ height: totalHeight }}>
          {rows.map((index) => {
            const packet = packets[index]!
            const doc = docForTypeName(packet.type_name)
            const isSelected = index === selected
            const badge = sessionBadges?.[index]

            const classes = [
              'packet-row',
              packet.direction === 'C2S' ? 'c2s' : 's2c',
              isSelected ? 'selected' : '',
              inRanges(ranges, index) ? 'key-message' : '',
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <li
                key={`${sessionIds[index]}:${packet.id}`}
                className="packet-list-row"
                style={{ top: offsets[index] }}
              >
                {/* A visible marker for pauses long enough to be a human thinking
                    or a query running, rather than back-to-back protocol chatter. */}
                {gapBefore[index] && (
                  <div className="time-gap">
                    {formatMs(wallClock[index]! - wallClock[index - 1]!)} pause
                  </div>
                )}

                <button
                  className={classes}
                  ref={isSelected ? selectedButtonRef : undefined}
                  tabIndex={isSelected ? 0 : -1}
                  onClick={() => onSelect(index)}
                  aria-current={isSelected}
                >
                  <span className="packet-index">{packet.id}</span>
                  {/* Merged view only: which session this row came from. The
                      text is what disambiguates it; the colour is decoration on
                      top, so a colour-blind reader loses nothing. */}
                  {badge && <SessionTag badge={badge} />}
                  {/* Direction as a fixed-width glyph in its own column, so every
                      row is exactly the same shape. Colour carries it too, but the
                      arrow means it does not rely on colour alone. */}
                  <span
                    className="packet-dir"
                    aria-label={packet.direction === 'C2S' ? 'client to server' : 'server to client'}
                  >
                    {packet.direction === 'C2S' ? '→' : '←'}
                  </span>
                  <span className="packet-body">
                    <span className="packet-name">
                      <span className="packet-type">{packet.type_name}</span>
                      {packet.type_char && <code className="type-char">{packet.type_char}</code>}
                    </span>
                    {/* No category colour here. Teal and purple already mean
                        client and server on this row, so colouring the summary by
                        category put two unrelated meanings in one colour. */}
                    <span className="packet-category">
                      <Inline text={doc.summary} />
                    </span>
                  </span>
                  <span className="packet-length">{packet.length} B</span>
                </button>
              </li>
            )
          })}
        </ol>

        <RowProbe rowRef={probeRowRef} gapRowRef={probeGapRowRef} showBadge={hasBadges} />
      </div>
    </div>
  )
}

/**
 * Two rows in the exact real markup, measured purely so `PacketList` can
 * learn how tall a plain row and a gap-marked row actually render.
 *
 * Rendered as a normal-flow child of `.packet-list`, the same scroll
 * container real rows render in, so it is exactly as wide as a real row and
 * wraps `.time-gap`'s text the same way a real row would. It used to render
 * off-screen instead, positioned with `position: fixed` at a corner far
 * outside the viewport. A fixed position escapes every ancestor's width
 * constraint along with its layout, so the probe measured at the viewport's
 * full width, wider than the real narrow column the row list actually lives
 * in. `.time-gap`'s text wraps onto two lines at the real width but not at
 * that wider one, so the probe under-measured a gap row's true height, and
 * every row after a gap marker overlapped it by the shortfall. `height: 0`
 * plus `overflow: hidden` on `.packet-list-probe` is what keeps it from
 * being seen or adding scroll height while still living at the right width:
 * a zero-height box clips its overflowing children from the rendered page
 * without changing its own contribution to its parent's layout, and
 * `getBoundingClientRect()` on the children still reports their full,
 * correct size regardless of the clip. `visibility: hidden` and
 * `tabIndex={-1}` take it out of sight and out of the tab order, belt and
 * suspenders.
 *
 * A separate component rather than inline JSX only so the measurement effect
 * in `PacketList` reads as "measure the probe" instead of scrolling past a
 * second copy of the row markup to find the real one.
 *
 * `showBadge` mirrors whether the real rows carry a session badge (the
 * merged view only). The badge sits in the same button as `packet-category`,
 * so it narrows the space that text has to wrap in. Leaving it out of the
 * probe measured a plain-row and gap-row height that fit the tabbed view but
 * ran short in the merged view, wherever a summary happened to wrap onto a
 * second line only once the badge ate part of the width. That showed up as
 * the same kind of overlap as the fixed-position bug above, just present at
 * every row rather than only after a gap. `S99` is not a real id, only a
 * placeholder two digits wide, on the assumption that erring toward a
 * slightly wider badge (and so a slightly taller probe) leaves unused space
 * rather than an overlap if a real id is ever narrower.
 *
 * Both probe rows also carry `packet-list-row` itself, the same class real
 * rows use, for a subtler reason than width: `.time-gap`'s `margin-top`
 * collapses into its containing block when that block is a normal in-flow
 * element, the shape the probe's `<li>` used to have, but a real row's `<li>`
 * is `position: absolute`, which starts a new block formatting context and
 * stops that collapse. The margin then adds to the row's rendered height
 * instead of disappearing into it, so a gap row measured a few pixels
 * shorter off the in-flow probe than it actually rendered, and every row
 * after it overlapped the gap marker by that shortfall. Giving the probe the
 * same `position: absolute` puts it under the same rule, so the measurement
 * includes the margin the same way the real row's does. The inline
 * `top: 0` only satisfies `position: absolute` needing *some* offset to
 * resolve against; where it lands is irrelevant, since `.packet-list-probe`
 * clips it from view regardless.
 */
function RowProbe({
  rowRef,
  gapRowRef,
  showBadge,
}: {
  rowRef: React.RefObject<HTMLLIElement | null>
  gapRowRef: React.RefObject<HTMLLIElement | null>
  showBadge: boolean
}) {
  return (
    <ol className="packet-list-probe" aria-hidden="true">
      <li ref={rowRef} className="packet-list-row" style={{ top: 0 }}>
        <button className="packet-row c2s" tabIndex={-1}>
          <span className="packet-index">0</span>
          {showBadge && <span className="session-badge">S99</span>}
          <span className="packet-dir">→</span>
          <span className="packet-body">
            <span className="packet-name">
              <span className="packet-type">Probe</span>
            </span>
            <span className="packet-category">probe row, never shown</span>
          </span>
          <span className="packet-length">0 B</span>
        </button>
      </li>
      <li ref={gapRowRef} className="packet-list-row" style={{ top: 0 }}>
        <div className="time-gap">0ms pause</div>
        <button className="packet-row c2s" tabIndex={-1}>
          <span className="packet-index">0</span>
          {showBadge && <span className="session-badge">S99</span>}
          <span className="packet-dir">→</span>
          <span className="packet-body">
            <span className="packet-name">
              <span className="packet-type">Probe</span>
            </span>
            <span className="packet-category">probe row, never shown</span>
          </span>
          <span className="packet-length">0 B</span>
        </button>
      </li>
    </ol>
  )
}
