import { describe, expect, it } from 'vitest'
import { decodeHexRange, hexToBytes } from './hex'

describe('hexToBytes', () => {
  it('decodes a whole string', () => {
    expect([...hexToBytes('00ff10a0')]).toEqual([0, 255, 16, 160])
  })

  it('decodes an empty string to no bytes', () => {
    expect(hexToBytes('').length).toBe(0)
  })

  // The captures are lowercased when parsed, but a hand-edited or third-party
  // file need not be, and silently decoding those to zeroes would be worse than
  // either working or failing.
  it('accepts uppercase', () => {
    expect([...hexToBytes('DEADBEEF')]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })
})

describe('decodeHexRange', () => {
  // Fixed width is the property the hex dump depends on: byte n starts at
  // character 2n, so a window can be decoded without scanning what precedes it.
  const hex = '00112233445566778899'

  it('decodes a window from the middle without touching the rest', () => {
    expect([...decodeHexRange(hex, 3, 4)]).toEqual([0x33, 0x44, 0x55, 0x66])
  })

  it('decodes from the start and to the end', () => {
    expect([...decodeHexRange(hex, 0, 2)]).toEqual([0x00, 0x11])
    expect([...decodeHexRange(hex, 8, 2)]).toEqual([0x88, 0x99])
  })

  // The dump asks for whole rows, so its last request routinely runs past the
  // end of the packet. Returning the bytes that exist is what lets it pad those
  // cells rather than drawing zeroes that are not in the capture.
  it('clamps a window that runs past the end', () => {
    expect([...decodeHexRange(hex, 8, 16)]).toEqual([0x88, 0x99])
  })

  it('returns nothing for a window that starts past the end', () => {
    expect(decodeHexRange(hex, 10, 16).length).toBe(0)
    expect(decodeHexRange(hex, 99, 4).length).toBe(0)
  })

  it('returns nothing for a negative or zero count', () => {
    expect(decodeHexRange(hex, 2, 0).length).toBe(0)
    expect(decodeHexRange(hex, 2, -5).length).toBe(0)
  })

  it('treats a negative start as the beginning', () => {
    expect([...decodeHexRange(hex, -3, 2)]).toEqual([0x00, 0x11])
  })

  it('agrees with decoding the whole string', () => {
    const whole = [...hexToBytes(hex)]
    for (let start = 0; start < whole.length; start++) {
      expect([...decodeHexRange(hex, start, 3)]).toEqual(whole.slice(start, start + 3))
    }
  })
})
