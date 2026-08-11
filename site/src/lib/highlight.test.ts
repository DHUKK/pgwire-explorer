import { describe, expect, it } from 'vitest'
import { bandPercent, inRanges, rangesForMerged, rangesForSession } from './highlight'
import type { PacketRecord } from '../types'

/** n packets with sequential IDs, which is what a real session has. */
function packets(n: number): PacketRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    direction: 'C2S' as const,
    timestamp_ms: i,
    stream_offset: i,
    length: 1,
    raw_hex: '00',
    type_name: 'Query',
  }))
}

describe('rangesForSession', () => {
  // IDs are what the row gutter shows, so a range is authored 1-based and used
  // 0-based.
  it('converts packet IDs to indices', () => {
    expect(rangesForSession(packets(10), { 1: [[4, 9]] }, 1)).toEqual([[3, 8]])
  })

  it('returns nothing for a session with no ranges', () => {
    expect(rangesForSession(packets(10), { 2: [[1, 2]] }, 1)).toEqual([])
    expect(rangesForSession(packets(10), undefined, 1)).toEqual([])
  })

  it('keeps ranges for different sessions apart', () => {
    const spec = { 1: [[1, 2]] as const, 2: [[1, 1]] as const }
    expect(rangesForSession(packets(10), spec, 1)).toEqual([[0, 1]])
    expect(rangesForSession(packets(1), spec, 2)).toEqual([[0, 0]])
  })

  it('handles a single-packet range', () => {
    expect(rangesForSession(packets(1), { 1: [[1, 1]] }, 1)).toEqual([[0, 0]])
  })

  // A stale range must mark less, never point past the end, or the scrubber would
  // draw a band wider than its track.
  it('clamps a range that runs past the session', () => {
    expect(rangesForSession(packets(5), { 1: [[3, 99]] }, 1)).toEqual([[2, 4]])
    expect(rangesForSession(packets(5), { 1: [[80, 99]] }, 1)).toEqual([[4, 4]])
  })

  it('sorts and merges overlapping ranges', () => {
    expect(
      rangesForSession(packets(20), { 1: [[10, 14], [2, 5], [4, 8]] }, 1),
    ).toEqual([
      [1, 7],
      [9, 13],
    ])
  })

  // Abutting bands would otherwise show a hairline seam on the scrubber.
  it('joins adjacent ranges', () => {
    expect(rangesForSession(packets(20), { 1: [[1, 4], [5, 8]] }, 1)).toEqual([[0, 7]])
  })

  it('returns nothing for an empty session', () => {
    expect(rangesForSession([], { 1: [[1, 4]] }, 1)).toEqual([])
  })
})

describe('inRanges', () => {
  const ranges: Array<[number, number]> = [
    [2, 4],
    [8, 8],
  ]

  it('reports membership at the boundaries and inside', () => {
    expect([0, 1, 2, 3, 4, 5, 7, 8, 9].map((i) => inRanges(ranges, i))).toEqual([
      false, false, true, true, true, false, false, true, false,
    ])
  })

  it('is false when there are no ranges', () => {
    expect(inRanges([], 0)).toBe(false)
  })
})

describe('rangesForMerged', () => {
  /** A merged row referencing session `sessionId` and packet id `packetId`. */
  function row(sessionId: number, packetId: number) {
    return { sessionId, packet: packets(packetId)[packetId - 1]! }
  }

  it('marks rows whose own session declares their own packet id', () => {
    const rows = [row(1, 1), row(2, 1), row(1, 2), row(2, 2), row(1, 3)]
    // Session 1's packets 2 and 3 are the interesting ones; session 2 has none
    // marked. Row index 3 (session 2, packet 2) sits between them and is not
    // marked, so it splits what would otherwise be one run into two.
    expect(rangesForMerged(rows, { 1: [[2, 3]] })).toEqual([
      [2, 2],
      [4, 4],
    ])
  })

  it('returns nothing without a spec or with no rows', () => {
    expect(rangesForMerged([row(1, 1)], undefined)).toEqual([])
    expect(rangesForMerged([], { 1: [[1, 1]] })).toEqual([])
  })

  it('keeps a run broken across sessions as two separate ranges', () => {
    // Row order: session1#1 (marked), session2#1 (not marked, session 2 has
    // no range), session1#2 (marked). The middle row splits the run because it
    // belongs to a session the spec says nothing about.
    const rows = [row(1, 1), row(2, 1), row(1, 2)]
    expect(rangesForMerged(rows, { 1: [[1, 2]] })).toEqual([[0, 0], [2, 2]])
  })

  it('merges a run that continues across sessions when both mark it', () => {
    const rows = [row(1, 1), row(2, 1), row(1, 2)]
    expect(rangesForMerged(rows, { 1: [[1, 2]], 2: [[1, 1]] })).toEqual([[0, 2]])
  })
})

describe('bandPercent', () => {
  // The bug this exists to stop coming back: viewing only the CancelRequest's
  // own session shows one packet, that packet is highlighted, and the scrubber
  // drew nothing at all.
  it('covers the whole track for the only packet in a session', () => {
    expect(bandPercent([0, 0], 1)).toEqual({ left: 0, width: 100 })
  })

  // The band and the thumb must measure the same way, or the thumb sits inside
  // the band rather than at its edge when it is on the first marked packet.
  it('starts where the thumb sits on the range\'s first packet', () => {
    const total = 31
    const thumbPercent = (index: number) => (index / (total - 1)) * 100
    expect(bandPercent([25, 28], total).left).toBe(thumbPercent(25))
    const { left, width } = bandPercent([25, 28], total)
    // Summed rather than compared directly, so the last bit of the division can
    // differ without failing.
    expect(left + width).toBeCloseTo(thumbPercent(28), 10)
  })

  it('spans first to last packet, not per-packet slots', () => {
    expect(bandPercent([0, 3], 4)).toEqual({ left: 0, width: 100 })
    expect(bandPercent([0, 1], 3)).toEqual({ left: 0, width: 50 })
  })

  it('gives a one-packet range no width of its own, for the caller to floor', () => {
    expect(bandPercent([2, 2], 5)).toEqual({ left: 50, width: 0 })
  })

  it('clamps a range that overshoots the session', () => {
    expect(bandPercent([2, 99], 5)).toEqual({ left: 50, width: 50 })
  })

  it('returns a zero-width band for an empty session', () => {
    expect(bandPercent([0, 0], 0)).toEqual({ left: 0, width: 0 })
  })
})
