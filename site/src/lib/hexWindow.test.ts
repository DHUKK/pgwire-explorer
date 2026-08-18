import { describe, expect, it } from 'vitest'
import { highlightEdge, rowCountFor, rowForOffset } from './hexWindow'

describe('rowCountFor', () => {
  it('divides bytes into full rows', () => {
    expect(rowCountFor(32, 16)).toBe(2)
  })

  it('rounds a partial row up', () => {
    expect(rowCountFor(17, 16)).toBe(2)
  })

  it('is at least 1 for an empty packet', () => {
    expect(rowCountFor(0, 16)).toBe(1)
  })

  it('is 1 for a single byte', () => {
    expect(rowCountFor(1, 16)).toBe(1)
  })
})

describe('rowForOffset', () => {
  it('finds the row containing an offset', () => {
    expect(rowForOffset(0, 16)).toBe(0)
    expect(rowForOffset(15, 16)).toBe(0)
    expect(rowForOffset(16, 16)).toBe(1)
    expect(rowForOffset(31, 16)).toBe(1)
    expect(rowForOffset(32, 16)).toBe(2)
  })
})

describe('highlightEdge', () => {
  it('is null when there is no highlight', () => {
    expect(highlightEdge(5, null)).toBeNull()
  })

  it('is null outside the range', () => {
    expect(highlightEdge(1, [3, 6])).toBeNull()
    expect(highlightEdge(7, [3, 6])).toBeNull()
  })

  it('marks the start and end of a multi-byte run', () => {
    expect(highlightEdge(3, [3, 6])).toBe('start')
    expect(highlightEdge(4, [3, 6])).toBe('mid')
    expect(highlightEdge(5, [3, 6])).toBe('mid')
    expect(highlightEdge(6, [3, 6])).toBe('end')
  })

  it('marks a single byte as solo, not start and end separately', () => {
    expect(highlightEdge(4, [4, 4])).toBe('solo')
  })

  it('treats the cells either side of a row wrap as mid, not an edge', () => {
    // A run spanning 12..19 wraps from row 0 (ends at 15) into row 1 (starts at
    // 16). Byte 15 and byte 16 both continue the run, so both are 'mid'.
    expect(highlightEdge(15, [12, 19])).toBe('mid')
    expect(highlightEdge(16, [12, 19])).toBe('mid')
    expect(highlightEdge(12, [12, 19])).toBe('start')
    expect(highlightEdge(19, [12, 19])).toBe('end')
  })

  it('is null everywhere for a zero-length range', () => {
    // Encoded as end === start - 1.
    expect(highlightEdge(4, [5, 4])).toBeNull()
    expect(highlightEdge(5, [5, 4])).toBeNull()
  })
})
