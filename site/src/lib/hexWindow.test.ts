import { describe, expect, it } from 'vitest'
import {
  highlightEdge,
  rowCountFor,
  rowForOffset,
  scrollTopToReveal,
  visibleRowWindow,
} from './hexWindow'

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

describe('visibleRowWindow', () => {
  it('covers the whole thing when the viewport fits it all', () => {
    // 10 rows of 20px is 200px, a 400px viewport shows all of it.
    expect(visibleRowWindow(10, 0, 400, 20, 0)).toEqual({ start: 0, end: 9 })
  })

  it('windows to the rows near a scroll position, plus overscan', () => {
    // Scrolled to row 50 (1000px) with a 200px (10-row) viewport: rows 50..59
    // visible, +/-4 overscan.
    expect(visibleRowWindow(1000, 1000, 200, 20, 4)).toEqual({ start: 46, end: 64 })
  })

  it('clamps the start so scrollTop 0 never asks for a negative row', () => {
    expect(visibleRowWindow(1000, 0, 200, 20, 4)).toEqual({ start: 0, end: 14 })
  })

  it('clamps the end at the last row when scrolled to the bottom', () => {
    // Row 999 is the last row (rowCount 1000). Scrolled all the way down.
    expect(visibleRowWindow(1000, 1000 * 20 - 200, 200, 20, 4)).toEqual({ start: 986, end: 999 })
  })

  it('clamps a scrollTop past the end of the content', () => {
    expect(visibleRowWindow(10, 100000, 200, 20, 4)).toEqual({ start: 9, end: 9 })
  })

  it('treats a negative scrollTop as zero', () => {
    expect(visibleRowWindow(10, -50, 200, 20, 4)).toEqual({ start: 0, end: 9 })
  })

  it('still returns a valid single-row window before the container is measured', () => {
    // viewportHeight 0 is what an unmeasured ref reports on first render.
    expect(visibleRowWindow(1000, 0, 0, 20, 4)).toEqual({ start: 0, end: 4 })
  })

  it('handles the single-row case', () => {
    expect(visibleRowWindow(1, 0, 400, 20, 4)).toEqual({ start: 0, end: 0 })
  })

  it('returns an empty window for zero rows', () => {
    expect(visibleRowWindow(0, 0, 400, 20, 4)).toEqual({ start: 0, end: -1 })
  })
})

describe('scrollTopToReveal', () => {
  it('leaves scrollTop unchanged when the row is already fully visible', () => {
    expect(scrollTopToReveal(5, 20, 0, 400)).toBe(0)
  })

  it('scrolls up to reveal a row above the viewport', () => {
    expect(scrollTopToReveal(2, 20, 1000, 400)).toBe(40)
  })

  it('scrolls down to reveal a row below the viewport', () => {
    // Row 100 spans 2000..2020. A 400px viewport at scrollTop 1000 shows up to
    // 1400, so it must move down to put the row's bottom at the viewport's
    // bottom.
    expect(scrollTopToReveal(100, 20, 1000, 400)).toBe(1620)
  })

  it('reveals the first row by scrolling to the top', () => {
    expect(scrollTopToReveal(0, 20, 500, 400)).toBe(0)
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
