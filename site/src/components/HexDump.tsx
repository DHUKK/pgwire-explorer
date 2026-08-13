import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { byteToHex, byteToPrintable, decodeHexRange } from '../lib/hex'
import {
  highlightEdge,
  rowCountFor,
  rowForOffset,
  scrollTopToReveal,
  visibleRowWindow,
} from '../lib/hexWindow'

const BYTES_PER_ROW = 16

/** Must match `.hex-row`'s fixed height in styles.css. */
const ROW_HEIGHT = 20

/** Extra rows kept mounted past each edge of the viewport. */
const OVERSCAN_ROWS = 6

interface Props {
  /**
   * The packet's bytes as hex, undecoded.
   *
   * Deliberately not a `Uint8Array`. Only the mounted rows are ever decoded, so
   * a packet's size stops mattering: a 20MB `CopyData` costs the same to open as
   * a 20-byte `Sync`.
   */
  hex: string
  /** Inclusive [start, end] range to highlight, or null. */
  highlight: [number, number] | null
  onSelectByte: (offset: number) => void
  /**
   * The byte under the pointer, or null once the pointer leaves the dump.
   *
   * Hovering used to do nothing at all here: a byte only answered "what is
   * this?" once it had been clicked, so the two-way link was one-way on hover.
   */
  onHoverByte: (offset: number | null) => void
  /**
   * Whether to scroll a highlight outside the mounted window into view.
   *
   * False while the highlight is itself the result of hovering a byte, which
   * would otherwise fight the pointer: the hovered byte is on screen by
   * definition, but the field containing it can begin many rows above, and
   * scrolling to reveal that would slide a different byte under the cursor,
   * highlight that byte's field, and scroll again.
   */
  reveal: boolean
}

/**
 * A classic hex dump: offset, hex columns, ASCII gutter. The bytes of the active
 * field are highlighted in both halves.
 *
 * Every byte is hoverable and clickable, which is the other half of the two-way
 * link with the field tree: the annotations guarantee that each byte belongs to
 * exactly one innermost field, so any byte has a well-defined answer to "what is
 * this?". Hovering names that field and lights its row, clicking pins it.
 *
 * A captured `CopyData` can be hundreds of kilobytes (a raw `COPY` stream, or a
 * chunk of physical replication WAL), so this only ever mounts the rows near
 * the scroll position rather than one button per byte in the whole packet.
 * `.hex-dump` is the scroll container, sized to fit comfortably on screen, and
 * `.hex-dump-sizer` is given the height the full dump would occupy so the
 * scrollbar still represents every byte, not just the rendered ones. Rows
 * outside the window are still reachable: clicking one that is visible works
 * as before, and selecting or hovering a field scrolls its bytes into view
 * before highlighting them, so nothing is ever hidden, just not all mounted at
 * once.
 */
export function HexDump({ hex, highlight, onSelectByte, onHoverByte, reveal }: Props) {
  const byteLength = hex.length / 2
  const rowCount = rowCountFor(byteLength, BYTES_PER_ROW)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  // Measure the actual scroll container. A ResizeObserver keeps it right
  // across window resizes and the responsive breakpoint that changes the
  // panel's own height.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportHeight(el.clientHeight)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A new packet's bytes replace the old ones in place, so without this the
  // dump could open already scrolled to a position that belonged to whatever
  // was previously selected.
  useEffect(() => {
    const el = scrollRef.current
    // Instant, overriding `.hex-dump`'s smooth scroll-behavior. Gliding is right
    // for moving within one packet's bytes. Gliding through the old scroll
    // position of a packet that is no longer on screen is not: this is a reset,
    // not a movement, and there is nothing on the way for the reader to see.
    if (el) el.scrollTo({ top: 0, behavior: 'instant' })
    setScrollTop(0)
  }, [hex])

  // The other half of the two-way link: a hover or a selection may name bytes
  // outside the currently rendered window, so bring them into view instead of
  // silently failing to highlight them.
  useEffect(() => {
    if (!highlight || !reveal) return
    const el = scrollRef.current
    if (!el) return
    const row = rowForOffset(highlight[0], BYTES_PER_ROW)
    const next = scrollTopToReveal(row, ROW_HEIGHT, el.scrollTop, el.clientHeight)
    if (next !== el.scrollTop) {
      // `.hex-dump` sets scroll-behavior: smooth, so this glides. The state
      // below is set to the value asked for rather than read back off the
      // element, so which rows are mounted never depends on where an
      // in-progress animation has got to.
      el.scrollTop = next
      setScrollTop(next)
    }
  }, [highlight, reveal])

  const { start, end } = visibleRowWindow(
    rowCount,
    scrollTop,
    viewportHeight,
    ROW_HEIGHT,
    OVERSCAN_ROWS,
  )

  /**
   * The bytes for the mounted rows only, indexed from `windowStart`.
   *
   * This is the whole reason the component takes hex rather than bytes. Decoding
   * the packet up front made selecting a large one cost half a second and stutter
   * as the garbage collector cleared up after it, all to draw the same fifty rows.
   */
  const windowStart = start * BYTES_PER_ROW
  const windowBytes = useMemo(
    () => decodeHexRange(hex, windowStart, (end - start + 1) * BYTES_PER_ROW),
    [hex, windowStart, end, start],
  )

  /** The byte at an absolute packet offset, or undefined past the end. */
  const byteAt = (offset: number): number | undefined => windowBytes[offset - windowStart]

  /**
   * `highlighted` plus a `run-*` modifier so a contiguous highlighted range
   * paints as one rounded block: square joins where it continues, rounded only
   * at its two real ends (see `highlightEdge`).
   */
  const highlightClass = (base: string, offset: number): string => {
    const edge = highlightEdge(offset, highlight)
    return edge ? `${base} highlighted run-${edge}` : base
  }

  const rows: number[] = []
  for (let row = start; row <= end; row++) rows.push(row * BYTES_PER_ROW)

  return (
    <div
      className="hex-dump"
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onMouseLeave={() => onHoverByte(null)}
    >
      <div className="hex-dump-sizer" style={{ height: rowCount * ROW_HEIGHT }}>
        {rows.map((rowStart) => (
          <div className="hex-row" key={rowStart} style={{ top: (rowStart / BYTES_PER_ROW) * ROW_HEIGHT }}>
            <span className="hex-offset">{rowStart.toString(16).padStart(4, '0')}</span>

            <span className="hex-bytes">
              {Array.from({ length: BYTES_PER_ROW }, (_, i) => {
                const offset = rowStart + i
                const byte = byteAt(offset)
                if (byte === undefined) {
                  return (
                    <span className="hex-byte pad" key={i} aria-hidden="true">
                      {'  '}
                    </span>
                  )
                }
                return (
                  <button
                    key={i}
                    className={highlightClass('hex-byte', offset)}
                    onClick={() => onSelectByte(offset)}
                    onMouseEnter={() => onHoverByte(offset)}
                    title={`byte ${offset} is 0x${byteToHex(byte)} (${byte})`}
                  >
                    {byteToHex(byte)}
                  </button>
                )
              })}
            </span>

            <span className="hex-ascii">
              {Array.from({ length: BYTES_PER_ROW }, (_, i) => {
                const offset = rowStart + i
                const byte = byteAt(offset)
                if (byte === undefined) {
                  return (
                    <span className="ascii-char pad" key={i} aria-hidden="true">
                      {' '}
                    </span>
                  )
                }
                return (
                  <button
                    key={i}
                    className={highlightClass('ascii-char', offset)}
                    onClick={() => onSelectByte(offset)}
                    onMouseEnter={() => onHoverByte(offset)}
                    title={`byte ${offset}`}
                  >
                    {byteToPrintable(byte)}
                  </button>
                )
              })}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
