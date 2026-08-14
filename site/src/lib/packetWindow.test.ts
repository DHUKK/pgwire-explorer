import { describe, expect, it } from 'vitest'
import { rowOffsets, scrollTopToReveal, visibleRowWindow } from './packetWindow'

describe('rowOffsets', () => {
  it('is uniform when no row has a gap marker', () => {
    expect(rowOffsets([false, false, false], 20, 8)).toEqual([0, 20, 40, 60])
  })

  it('adds gapHeight on top of rowHeight for a gap row', () => {
    expect(rowOffsets([false, true, false], 20, 8)).toEqual([0, 20, 48, 68])
  })

  it('is a single zero for a zero-row list', () => {
    expect(rowOffsets([], 20, 8)).toEqual([0])
  })

  it('handles a gap marker on the very first row', () => {
    expect(rowOffsets([true, false], 20, 8)).toEqual([0, 28, 48])
  })
})

describe('visibleRowWindow', () => {
  it('covers the whole thing when the viewport fits it all', () => {
    const offsets = rowOffsets(new Array(10).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, 0, 400, 0)).toEqual({ start: 0, end: 9 })
  })

  it('windows to the rows near a scroll position, plus overscan', () => {
    // 1000 uniform rows of 20px: scrolled to row 50 (1000px) with a 200px
    // (10-row) viewport shows rows 50..59, +/-4 overscan.
    const offsets = rowOffsets(new Array(1000).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, 1000, 200, 4)).toEqual({ start: 46, end: 64 })
  })

  it('clamps the start so scrollTop 0 never asks for a negative row', () => {
    const offsets = rowOffsets(new Array(1000).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, 0, 200, 4)).toEqual({ start: 0, end: 14 })
  })

  it('clamps the end at the last row when scrolled to the bottom', () => {
    const offsets = rowOffsets(new Array(1000).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, 1000 * 20 - 200, 200, 4)).toEqual({ start: 986, end: 999 })
  })

  it('clamps a scrollTop past the end of the content', () => {
    // Both endpoints land past the last row (index 9), which the binary
    // search already clamps to 9 before overscan is subtracted, so overscan
    // still pulls start back to show a few rows above the bottom rather than
    // collapsing to a single row.
    const offsets = rowOffsets(new Array(10).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, 100000, 200, 4)).toEqual({ start: 5, end: 9 })
  })

  it('treats a negative scrollTop as zero', () => {
    const offsets = rowOffsets(new Array(10).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, -50, 200, 4)).toEqual({ start: 0, end: 9 })
  })

  it('still returns a valid single-row window before the container is measured', () => {
    const offsets = rowOffsets(new Array(1000).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, 0, 0, 4)).toEqual({ start: 0, end: 4 })
  })

  it('handles the single-row case', () => {
    const offsets = rowOffsets([false], 20, 8)
    expect(visibleRowWindow(offsets, 0, 400, 4)).toEqual({ start: 0, end: 0 })
  })

  it('returns an empty window for zero rows', () => {
    expect(visibleRowWindow([0], 0, 400, 4)).toEqual({ start: 0, end: -1 })
  })

  it('shifts the window earlier by the scroll container\'s own top padding', () => {
    // 10px of inset at scrollTop 1000 matches 0px of inset at scrollTop 990.
    const offsets = rowOffsets(new Array(1000).fill(false), 20, 8)
    expect(visibleRowWindow(offsets, 1000, 200, 4, 10)).toEqual(
      visibleRowWindow(offsets, 990, 200, 4, 0),
    )
  })

  it('still finds a partially visible last row when an earlier gap marker pushed it down', () => {
    // Row 0 carries a gap marker (28px tall instead of 20px), so every row
    // after it starts 8px later than pure rowHeight arithmetic would predict.
    // Row 9 starts at 28 + 9*20 = 188, which is still inside a 200px
    // viewport (even though it runs on to 208), so it counts as visible.
    const gaps = [true, false, false, false, false, false, false, false, false, false]
    const offsets = rowOffsets(gaps, 20, 8)
    expect(visibleRowWindow(offsets, 0, 200, 0)).toEqual({ start: 0, end: 9 })
  })
})

describe('scrollTopToReveal', () => {
  it('leaves scrollTop unchanged when the row is already fully visible', () => {
    const offsets = rowOffsets(new Array(10).fill(false), 20, 8)
    expect(scrollTopToReveal(offsets, 5, 0, 400)).toBe(0)
  })

  it('scrolls up to reveal a row above the viewport, centering it', () => {
    // Content (200px) is shorter than the viewport (400px), so the only
    // sane centered position clamps to 0.
    const offsets = rowOffsets(new Array(10).fill(false), 20, 8)
    expect(scrollTopToReveal(offsets, 2, 1000, 400)).toBe(0)
  })

  it('scrolls down to reveal a row below the viewport, centering it', () => {
    // Row 100 spans 2000..2020, midpoint 2010, centered at 2010 - 200 = 1810.
    const offsets = rowOffsets(new Array(200).fill(false), 20, 8)
    expect(scrollTopToReveal(offsets, 100, 1000, 400)).toBe(1810)
  })

  it('reveals the first row by scrolling to the top', () => {
    const offsets = rowOffsets(new Array(10).fill(false), 20, 8)
    expect(scrollTopToReveal(offsets, 0, 500, 400)).toBe(0)
  })

  it('accounts for a gap marker as part of the target row itself', () => {
    // Row 5's gap marker makes its own slot 28px tall: top 100, bottom 128,
    // midpoint 114, centered at 114 - 25 = 89.
    const gaps = [false, false, false, false, false, true, false, false]
    const offsets = rowOffsets(gaps, 20, 8)
    expect(scrollTopToReveal(offsets, 5, 0, 50)).toBe(89)
  })

  it('clamps a row index past the end to the last real row', () => {
    const offsets = rowOffsets(new Array(5).fill(false), 20, 8)
    expect(scrollTopToReveal(offsets, 99, 0, 40)).toBe(scrollTopToReveal(offsets, 4, 0, 40))
  })

  it('accounts for the scroll container\'s own top padding', () => {
    // With a 10px inset, row 100 sits at 2010..2030, midpoint 2020, centered
    // at 1820, not the 1810 a zero inset would give.
    const offsets = rowOffsets(new Array(200).fill(false), 20, 8)
    expect(scrollTopToReveal(offsets, 100, 1000, 400, 10)).toBe(1820)
  })

  it('with no inset given, matches the inset-of-zero case', () => {
    const offsets = rowOffsets(new Array(200).fill(false), 20, 8)
    expect(scrollTopToReveal(offsets, 100, 1000, 400)).toBe(scrollTopToReveal(offsets, 100, 1000, 400, 0))
  })
})
