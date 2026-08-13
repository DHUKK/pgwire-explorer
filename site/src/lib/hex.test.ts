import { describe, expect, it } from 'vitest'
import type { FieldAnnotation } from '../types'
import { decodeHexRange, fieldAtOffset, fieldAtPath, hexToBytes } from './hex'

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

describe('fieldAtPath', () => {
  // A RowDescription in miniature: a message with a nested column, which is the
  // shape that makes paths worth having in the first place.
  const fields: FieldAnnotation[] = [
    { name: 'Type', value: 'T', bytes: [0, 0] },
    { name: 'Length', value: 5, bytes: [1, 4] },
    {
      name: 'Column[0]: id',
      bytes: [5, 12],
      children: [
        { name: 'Name', value: 'id', bytes: [5, 7] },
        { name: 'Type OID', value: 23, bytes: [8, 12] },
      ],
    },
  ]

  it('resolves a top-level path', () => {
    expect(fieldAtPath(fields, '0')?.name).toBe('Type')
    expect(fieldAtPath(fields, '2')?.name).toBe('Column[0]: id')
  })

  it('resolves a nested path', () => {
    expect(fieldAtPath(fields, '2.1')?.name).toBe('Type OID')
  })

  // The whole reason this exists rather than looking a path up in the flattened
  // rows: the path outlives the row. Collapsing the column takes its children
  // off screen, and the bytes of the selected child must stay highlighted.
  it('resolves a path whose row would be collapsed away', () => {
    const flattenedWithColumnCollapsed = ['0', '1', '2']
    expect(flattenedWithColumnCollapsed).not.toContain('2.0')
    expect(fieldAtPath(fields, '2.0')?.name).toBe('Name')
  })

  it('agrees with fieldAtOffset on the path it returns', () => {
    for (let offset = 0; offset <= 12; offset++) {
      const hit = fieldAtOffset(fields, offset)
      expect(hit, `no field covers byte ${offset}`).not.toBeNull()
      expect(fieldAtPath(fields, hit!.path)).toBe(hit!.field)
    }
  })

  it('returns null for a path that does not resolve', () => {
    expect(fieldAtPath(fields, '')).toBeNull()
    expect(fieldAtPath(fields, '9')).toBeNull()
    expect(fieldAtPath(fields, '0.0')).toBeNull() // Type has no children
    expect(fieldAtPath(fields, '2.9')).toBeNull()
    expect(fieldAtPath(fields, 'x')).toBeNull()
    expect(fieldAtPath(fields, '-1')).toBeNull()
  })
})
