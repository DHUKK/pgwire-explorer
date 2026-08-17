/**
 * Pure layout math for virtualizing the hex dump.
 *
 * A captured `CopyData` can carry a raw `COPY` stream or a chunk of physical
 * replication WAL, which is easily hundreds of kilobytes in one packet.
 * Rendering a button per byte for that would put six figures of DOM nodes on
 * the page and lock up the browser. Instead the dump only ever mounts the rows
 * near the viewport, while the scroll container is given the height the full
 * dump would occupy, so the scrollbar still represents the whole packet and
 * every byte stays reachable by scrolling to it.
 */

/** Inclusive row indices, both within `[0, rowCount-1]`. */
export interface RowWindow {
  start: number
  end: number
}

/**
 * Row count for `byteLength` bytes at `bytesPerRow` per row. At least 1, so an
 * empty packet still draws one (empty) row.
 */
export function rowCountFor(byteLength: number, bytesPerRow: number): number {
  return Math.max(1, Math.ceil(byteLength / bytesPerRow))
}

/** The row that contains byte `offset`. */
export function rowForOffset(offset: number, bytesPerRow: number): number {
  return Math.floor(offset / bytesPerRow)
}

/**
 * The rows to actually render for a scroll container `viewportHeight` tall,
 * scrolled to `scrollTop`, each row `rowHeight` tall. `overscan` extra rows are
 * kept mounted on each side, so a small scroll or a keyboard nudge shows the
 * next row immediately instead of a flash of blank space while React catches
 * up.
 *
 * Clamped to `[0, rowCount-1]`, so a scroll position that no longer fits (for
 * instance right after the underlying packet shrinks) can never ask for a row
 * that does not exist. `viewportHeight` of 0, which is what a not-yet-measured
 * container reports, still yields a valid single-row window rather than an
 * empty one.
 *
 * `topInset` is the scroll container's own top padding, subtracted back out
 * because row positions are measured from the sizer's origin and `scrollTop` is
 * measured from the padding's. Defaults to 0.
 */
export function visibleRowWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 4,
  topInset = 0,
): RowWindow {
  if (rowCount <= 0) return { start: 0, end: -1 }

  const safeScrollTop = Math.max(0, scrollTop - topInset)
  const safeHeight = Math.max(0, viewportHeight)

  const firstVisible = Math.floor(safeScrollTop / rowHeight)
  const lastVisible = Math.floor((safeScrollTop + safeHeight) / rowHeight)

  const start = clamp(firstVisible - overscan, 0, rowCount - 1)
  const end = clamp(Math.max(lastVisible + overscan, start), 0, rowCount - 1)
  return { start, end }
}

/**
 * The scrollTop that brings `row` to the top of a container `viewportHeight`
 * tall currently scrolled to `scrollTop`. Returns `scrollTop` unchanged when
 * `row` is already fully visible, so a field that is already on screen is never
 * jostled.
 *
 * `row` lands at the top whichever direction it was reached from, rather than
 * flush against the nearer edge. A field is revealed by the row its first byte
 * falls in, and a field can span more rows than that one: bottom-aligning it
 * when scrolling down put the field's first row at the last visible line and
 * left the rest of the field below the fold. Putting it at the top means
 * everything that follows it is on screen too, up to a viewport's worth.
 *
 * This is why the packet list keeps its own nearest-edge version in
 * `packetWindow.ts` instead of sharing this. There a row is the whole thing
 * being revealed, and a keyboard step should move the list by one row, not
 * throw it a whole viewport.
 *
 * `topInset` is the scroll container's own top padding, added to put a row's
 * sizer-relative position back into `scrollTop`'s coordinate space. Without it
 * a row came to rest with its lower edge clipped by exactly the padding, which
 * on a 20px row and 8px of padding is nearly half the row.
 */
export function scrollTopToReveal(
  row: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  topInset = 0,
): number {
  const rowTop = row * rowHeight + topInset
  const rowBottom = rowTop + rowHeight
  if (rowTop < scrollTop) return rowTop
  if (rowBottom > scrollTop + viewportHeight) return rowTop
  return scrollTop
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Where an offset sits within a highlighted run, so a contiguous range of
 * highlighted bytes can be drawn as one rounded block instead of a row of
 * separate rounded squares with a notch at every seam.
 *
 * Only the two ends of the whole run round outward: `'start'` for the first
 * byte, `'end'` for the last, `'solo'` when a single byte is both. Everything
 * between stays `'mid'`, including the two cells either side of a wrap to the
 * next hex row, so a run that spans rows reads as continuing rather than
 * stopping and restarting at the row break.
 *
 * A zero-length field is encoded as `end === start-1`, so `highlight` can
 * describe an empty range. No offset satisfies `offset >= start` there, so
 * every byte correctly gets `null` rather than a stray rounded cap.
 */
export type HighlightEdge = 'solo' | 'start' | 'end' | 'mid' | null

export function highlightEdge(
  offset: number,
  highlight: readonly [number, number] | null,
): HighlightEdge {
  if (!highlight) return null
  const [start, end] = highlight
  if (offset < start || offset > end) return null

  const isStart = offset === start
  const isEnd = offset === end
  if (isStart && isEnd) return 'solo'
  if (isStart) return 'start'
  if (isEnd) return 'end'
  return 'mid'
}
