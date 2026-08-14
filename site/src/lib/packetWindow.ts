/**
 * Pure layout math for virtualizing the packet list, the same idea as
 * `hexWindow.ts` but generalized to variable row height.
 *
 * A hex row is always exactly `ROW_HEIGHT` tall, so `hexWindow.ts` can find a
 * row from a scroll position with plain arithmetic. A packet row cannot: a row
 * that follows a time-gap marker (see `PacketList`) is taller than a plain
 * row, by a fixed amount known ahead of time from the gap marker's own CSS, not
 * from the packet's content. `rowOffsets` turns that per-row "is there a gap
 * marker above this row" flag into a cumulative-offset table once, and the
 * rest of this module finds rows in that table by binary search instead of by
 * division. A capture with no gaps at all degenerates to the same arithmetic
 * hexWindow.ts uses, just paid for with a table lookup instead of a divide.
 */

/** Inclusive row indices, both within `[0, rowCount-1]`. */
export interface RowWindow {
  start: number
  end: number
}

/**
 * Cumulative top offset of every row, one entry per row plus a final sentinel
 * equal to the total height the list would occupy if every row were mounted.
 * `offsets[i]` is where row `i` starts; `offsets[i + 1] - offsets[i]` is how
 * tall it is, `rowHeight` plus `gapHeight` when `gapBefore[i]` is true.
 *
 * `gapBefore.length` rows in, `gapBefore.length + 1` offsets out, so the
 * result is always non-empty even for a zero-row list (a single `0`).
 */
export function rowOffsets(
  gapBefore: readonly boolean[],
  rowHeight: number,
  gapHeight: number,
): number[] {
  const offsets = new Array<number>(gapBefore.length + 1)
  offsets[0] = 0
  for (let i = 0; i < gapBefore.length; i++) {
    offsets[i + 1] = offsets[i]! + rowHeight + (gapBefore[i] ? gapHeight : 0)
  }
  return offsets
}

/**
 * The row whose span `[offsets[i], offsets[i+1])` contains `y`, clamped to the
 * last row for a `y` at or past the bottom of the content. `offsets` must have
 * at least one row (length >= 2).
 */
function rowAt(offsets: readonly number[], y: number): number {
  const rowCount = offsets.length - 1
  let lo = 0
  let hi = rowCount - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid]! <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The rows to actually render for a scroll container `viewportHeight` tall,
 * scrolled to `scrollTop`, laid out per `offsets`. `overscan` extra rows are
 * kept mounted on each side, so a small scroll or a keyboard nudge shows the
 * next row immediately instead of a flash of blank space while React catches
 * up.
 *
 * `topInset` is the scroll container's own top padding, subtracted back out
 * before searching `offsets`, which is measured from the sizer's origin, not
 * `scrollTop`'s. Defaults to 0.
 *
 * Clamped to `[0, rowCount-1]`, so a scroll position that no longer fits (for
 * instance right after the selected session shrinks the list) can never ask
 * for a row that does not exist. `viewportHeight` of 0, which is what a
 * not-yet-measured container reports, still yields a valid single-row window.
 */
export function visibleRowWindow(
  offsets: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 4,
  topInset = 0,
): RowWindow {
  const rowCount = offsets.length - 1
  if (rowCount <= 0) return { start: 0, end: -1 }

  const safeScrollTop = Math.max(0, scrollTop - topInset)
  const safeHeight = Math.max(0, viewportHeight)

  const firstVisible = rowAt(offsets, safeScrollTop)
  const lastVisible = rowAt(offsets, safeScrollTop + safeHeight)

  const start = clamp(firstVisible - overscan, 0, rowCount - 1)
  const end = clamp(Math.max(lastVisible + overscan, start), 0, rowCount - 1)
  return { start, end }
}

/**
 * The scrollTop that brings `row` into view within a container
 * `viewportHeight` tall currently scrolled to `scrollTop`. Returns `scrollTop`
 * unchanged when `row` is already fully visible, so a row that is already on
 * screen is never jostled. `row` is clamped to a real row, so asking to reveal
 * a stale or out-of-range index degrades to revealing the nearest valid one
 * rather than producing a nonsensical scroll position.
 *
 * When a scroll is needed, `row` lands centered in the viewport rather than
 * flush against whichever edge it was closest to, since a row that needs
 * revealing at all is usually a jump (a route, Home, End) rather than a step.
 *
 * `topInset` is the scroll container's own top padding, added to `offsets`'s
 * sizer-relative positions to put them back in `scrollTop`'s coordinate
 * space. Without it, a row near the bottom of a long list landed with its
 * lower edge clipped by exactly the padding amount.
 */
export function scrollTopToReveal(
  offsets: readonly number[],
  row: number,
  scrollTop: number,
  viewportHeight: number,
  topInset = 0,
): number {
  const rowCount = offsets.length - 1
  if (rowCount <= 0) return scrollTop

  const clampedRow = clamp(row, 0, rowCount - 1)
  const rowTop = offsets[clampedRow]! + topInset
  const rowBottom = offsets[clampedRow + 1]! + topInset

  if (rowTop >= scrollTop && rowBottom <= scrollTop + viewportHeight) return scrollTop

  const rowMid = (rowTop + rowBottom) / 2
  const maxScrollTop = Math.max(0, offsets[rowCount]! + topInset - viewportHeight)
  return clamp(rowMid - viewportHeight / 2, 0, maxScrollTop)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
