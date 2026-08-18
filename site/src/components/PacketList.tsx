import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { PacketRecord } from '../types'
import { docForTypeName } from '../lib/messages'
import { Inline } from '../lib/inline'
import { formatMs } from '../lib/hex'
import { inRanges, type Range } from '../lib/highlight'
import { SessionTag, type SessionBadge } from './SessionTag'

/** Extra rows kept mounted past each edge of the viewport. */
const OVERSCAN_ROWS = 8

/** A pause long enough to be a human thinking or a query running, not just back-to-back protocol chatter. */
const GAP_THRESHOLD_MS = 100

/** Rough sizes for the virtualizer's initial layout; real rows are measured once mounted. */
const ESTIMATED_ROW_HEIGHT = 52
const ESTIMATED_GAP_EXTRA_HEIGHT = 21

// Given to the virtualizer, not CSS: see the same note in HexDump.tsx.
const VERTICAL_PADDING = 6.4

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
 * is taller than a plain one. The virtualizer measures each mounted row for
 * real (see `measureElement` below) rather than trusting a guess, so a row's
 * true height, including a font-swap or a badge that narrows its text, is
 * always what the offset table reflects.
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

  // Which rows carry a time-gap marker above them, used both for the
  // estimated row height below and to render the marker itself.
  const gapBefore = useMemo(
    () => packets.map((_, index) => index > 0 && wallClock[index]! - wallClock[index - 1]! > GAP_THRESHOLD_MS),
    [packets, wallClock],
  )

  const rowVirtualizer = useVirtualizer({
    count: packets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      gapBefore[index] ? ESTIMATED_ROW_HEIGHT + ESTIMATED_GAP_EXTRA_HEIGHT : ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    paddingStart: VERTICAL_PADDING,
    paddingEnd: VERTICAL_PADDING,
  })

  // Brings a newly selected row into view, flush against whichever edge it
  // fell off ('auto': a no-op if it's already visible). A layout effect, so
  // this settles before paint rather than flashing the old scroll position
  // first.
  useLayoutEffect(() => {
    rowVirtualizer.scrollToIndex(selected, { align: 'auto' })
  }, [selected, rowVirtualizer])

  const virtualRows = rowVirtualizer.getVirtualItems()
  const range = rowVirtualizer.range

  // Focus the selected row once it is actually mounted, but only in response
  // to a genuinely new selection, not to every scroll-driven change of
  // `range`. `lastFocusedSelection` is what tells the two apart: it is this
  // effect's own memory of which selection it has already handled.
  //
  // The gate on `range` matters because the row is not always mounted on the
  // first render after `selected` changes: a step that lands outside the
  // current window needs the scroll effect above to move it into range first,
  // which happens on a later render, and only then does the row exist in the
  // DOM to focus.
  //
  // The `lastFocusedSelection` gate is what keeps this from fighting the
  // reader's own scrolling the rest of the time: scrolling with the wheel or
  // the scrollbar changes `range` too, every time, with `selected` unchanged,
  // and without the gate this effect used to re-focus (and scroll) the
  // still-selected row on every one of those, snapping the list back and
  // making it look like the scrollbar did not work.
  //
  // Focus follows the selection too, but only while it is already inside the
  // list. Without this, stepping with the arrow keys left focus on whichever
  // row was last clicked, so the next space or enter activated that row and
  // threw the reader back to it. The roving tabindex below means tabbing in
  // lands on the selected row rather than on the first one.
  const lastFocusedSelection = useRef<number | null>(null)
  useEffect(() => {
    if (!range || selected < range.startIndex || selected > range.endIndex) return
    if (lastFocusedSelection.current === selected) return
    lastFocusedSelection.current = selected

    const active = document.activeElement
    if (active !== selectedButtonRef.current && active && scrollRef.current?.contains(active)) {
      // preventScroll because the layout effect above owns scrolling. focus()
      // reveals an off-screen element instantly, which during the smooth scroll
      // that effect just started would cancel it and jump instead.
      selectedButtonRef.current?.focus({ preventScroll: true })
    }
  }, [selected, range])

  return (
    <div className="panel packet-list-panel">
      <div className="panel-head">
        <h2>Messages</h2>
        <div className="lane-legend">
          <span className="lane-legend-item c2s">client →</span>
          <span className="lane-legend-item s2c">← server</span>
        </div>
      </div>

      <div className="packet-list" ref={scrollRef}>
        <ol className="packet-list-sizer" style={{ height: rowVirtualizer.getTotalSize() }}>
          {virtualRows.map((virtualRow) => {
            const index = virtualRow.index
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
                data-index={index}
                ref={rowVirtualizer.measureElement}
                className="packet-list-row"
                style={{ top: virtualRow.start }}
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
      </div>
    </div>
  )
}
