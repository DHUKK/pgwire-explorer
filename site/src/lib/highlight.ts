import type { PacketRecord } from '../types'

/**
 * Inclusive ranges of packet IDs, keyed by session ID.
 *
 * Every capture opens with the same preamble: a startup message, an
 * `AuthenticationOk`, a burst of `ParameterStatus` and a first `ReadyForQuery`,
 * plus an encryption request in the psql-driven ones. That is most of the packets
 * and, since everything outside the authentication scenarios is recorded under
 * trust, it is now nearly identical across all thirteen. A scenario only reads
 * clearly if the part that differs is marked.
 *
 * Written as literal packet IDs rather than message type names, because a type
 * name cannot tell the `CommandComplete` that ends a `COPY` from the one that
 * ends the `CREATE TABLE` before it. IDs are what the row gutter shows, so a
 * range can be read off the screen and checked by eye.
 *
 * The cost is that they are positions in a specific recording. Regenerating the
 * scenarios can move them, so `scenarios.test.ts` asserts that every boundary
 * still lands on the message type it was chosen for.
 *
 * Only scenarios have these. An uploaded capture is not highlighted, because
 * nothing here knows what the reader came to look at.
 */
export type HighlightSpec = Record<number, ReadonlyArray<readonly [number, number]>>

/** An inclusive [start, end] pair of packet indices, not IDs. */
export type Range = [number, number]

/**
 * Converts the packet-ID ranges for one session into index ranges, clamped to
 * what the session actually contains.
 *
 * IDs are 1-based and dense within a session, so an index is the ID minus one.
 * Clamping means a stale range cannot make the UI point past the end, it just
 * marks less.
 */
export function rangesForSession(
  packets: PacketRecord[],
  spec: HighlightSpec | undefined,
  sessionId: number,
): Range[] {
  const declared = spec?.[sessionId]
  if (!declared || packets.length === 0) return []

  const last = packets.length - 1
  const ranges: Range[] = []
  for (const [from, to] of declared) {
    const start = Math.max(0, Math.min(from - 1, last))
    const end = Math.max(start, Math.min(to - 1, last))
    ranges.push([start, end])
  }
  return merge(ranges)
}

/**
 * The same highlight spec, applied to a merged, cross-session row list.
 *
 * `spec` is still keyed by session id and written in that session's own packet
 * IDs, since that is what the row gutter shows in either view. Each row in
 * `rows` carries the session id it came from, so a row is marked exactly when
 * its own session declares its own packet ID as part of a range. No merging
 * step is needed afterwards: `rows` is already in final display order, so a
 * run of marked rows is detected by scanning it once.
 */
export function rangesForMerged(
  rows: ReadonlyArray<{ sessionId: number; packet: PacketRecord }>,
  spec: HighlightSpec | undefined,
): Range[] {
  if (!spec || rows.length === 0) return []

  const ranges: Range[] = []
  let start: number | null = null

  rows.forEach((row, index) => {
    const declared = spec[row.sessionId]
    const hit = declared?.some(([from, to]) => row.packet.id >= from && row.packet.id <= to) ?? false
    if (hit && start === null) start = index
    if (!hit && start !== null) {
      ranges.push([start, index - 1])
      start = null
    }
  })
  if (start !== null) ranges.push([start, rows.length - 1])
  return ranges
}

/**
 * Where a range sits on the scrubber track, as percentages of the track's width.
 *
 * Measured the same way the thumb is, from the first packet at 0 percent to the
 * last at 100, so a band's left edge lands exactly under the thumb when the
 * thumb is on the range's first packet. Equal per-packet slots would be a
 * defensible model on their own, but mixing the two puts the thumb inside the
 * band instead of at its edge.
 *
 * A range of one packet therefore has no width of its own, and the caller gives
 * it a visible floor.
 *
 * The single-packet session is the case worth spelling out. There is no distance
 * between first and last packet to measure against, so the band is the whole
 * track: that one packet IS the whole session.
 */
export function bandPercent(
  [start, end]: Range,
  total: number,
): { left: number; width: number } {
  if (total <= 0) return { left: 0, width: 0 }
  if (total === 1) return { left: 0, width: 100 }

  const span = total - 1
  const first = Math.max(0, Math.min(start, span))
  const last = Math.max(first, Math.min(end, span))
  return {
    left: (first / span) * 100,
    width: ((last - first) / span) * 100,
  }
}

/** True when `index` falls inside any range. Ranges must be sorted and disjoint. */
export function inRanges(ranges: readonly Range[], index: number): boolean {
  for (const [start, end] of ranges) {
    if (index < start) return false
    if (index <= end) return true
  }
  return false
}

/**
 * Sorts and merges, so overlapping or adjacent ranges become one.
 *
 * The scrubber draws each range as a translucent band. Two stacked bands would
 * read as a third colour, and two abutting bands would show a hairline seam.
 */
function merge(ranges: Range[]): Range[] {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Range[] = [[...sorted[0]!] as Range]

  for (const [start, end] of sorted.slice(1)) {
    const last = out[out.length - 1]!
    if (start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}
