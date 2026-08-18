/**
 * Row math for the hex dump, virtualized with `@tanstack/react-virtual`.
 *
 * A captured `CopyData` can carry a raw `COPY` stream or a chunk of physical
 * replication WAL, which is easily hundreds of kilobytes in one packet.
 * Rendering a button per byte for that would put six figures of DOM nodes on
 * the page and lock up the browser, which is what the virtualizer avoids.
 */

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
