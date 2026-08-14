import { describe, expect, it } from 'vitest'
import { CaptureError, packetCount, parseCapture, sessionDurationMs, validateCapture } from './capture'

/** A minimal valid capture, used as the base for "one thing wrong" cases. */
function validCapture() {
  return {
    version: '2.0',
    recorded_at: '2026-01-01T00:00:00Z',
    sessions: [
      {
        id: 1,
        client_addr: '127.0.0.1:5000',
        server_addr: '127.0.0.1:5432',
        started_at: '2026-01-01T00:00:00Z',
        ssl_requested: false,
        ssl_accepted: false,
        packets: [
          {
            id: 1,
            direction: 'C2S',
            timestamp_ms: 0.5,
            stream_offset: 0,
            length: 4,
            raw_hex: '51000000',
            type_char: 'Q',
            type_name: 'Query',
            fields: [
              { name: 'Type Identifier', value: 'Q', bytes: [0, 0] },
              { name: 'Message Length', value: 3, bytes: [1, 3] },
            ],
          },
        ],
      },
    ],
  }
}

describe('parseCapture', () => {
  it('accepts a valid capture', () => {
    const capture = parseCapture(JSON.stringify(validCapture()))
    expect(capture.version).toBe('2.0')
    expect(packetCount(capture)).toBe(1)
    expect(sessionDurationMs(capture.sessions[0]!)).toBe(0.5)
  })

  it('rejects an empty file', () => {
    expect(() => parseCapture('   ')).toThrow(CaptureError)
  })

  it('rejects invalid JSON', () => {
    expect(() => parseCapture('{ not json')).toThrow(CaptureError)
  })

  // The likeliest user error is dropping in some other JSON file, so that case
  // gets a message that says what a capture is rather than a parser complaint.
  it('rejects unrelated JSON with an explanation', () => {
    expect(() => parseCapture('{"hello": "world"}')).toThrow(/does not look like a pgwire capture/)
  })

  it('rejects a capture with no sessions', () => {
    const capture = { ...validCapture(), sessions: [] }
    expect(() => validateCapture(capture)).toThrow(/no sessions/)
  })
})

describe('schema version', () => {
  it('accepts a different minor version', () => {
    // Minor versions only add fields, so refusing them would make the site
    // needlessly brittle against a recorder that gained one.
    const capture = { ...validCapture(), version: '2.7' }
    expect(validateCapture(capture).version).toBe('2.7')
  })

  it('rejects a newer major version', () => {
    const capture = { ...validCapture(), version: '3.0' }
    expect(() => validateCapture(capture)).toThrow(/3\.0/)
  })

  it('rejects an older major version', () => {
    const capture = { ...validCapture(), version: '1.0' }
    expect(() => validateCapture(capture)).toThrow(/1\.0/)
  })
})

describe('packet validation', () => {
  function withPacket(overrides: Record<string, unknown>) {
    const capture = validCapture()
    capture.sessions[0]!.packets[0] = {
      ...capture.sessions[0]!.packets[0]!,
      ...overrides,
    } as never
    return capture
  }

  it('rejects non-hex raw_hex', () => {
    expect(() => validateCapture(withPacket({ raw_hex: 'zzzz' }))).toThrow(/not hexadecimal/)
  })

  it('rejects odd-length raw_hex', () => {
    expect(() => validateCapture(withPacket({ raw_hex: 'abc' }))).toThrow(/odd number/)
  })

  // length and raw_hex disagreeing would make the hex dump highlight the wrong
  // bytes rather than fail visibly, so it is rejected outright.
  it('rejects a length that disagrees with raw_hex', () => {
    expect(() => validateCapture(withPacket({ length: 99 }))).toThrow(/carries 4 bytes/)
  })

  it('rejects an unknown direction', () => {
    expect(() => validateCapture(withPacket({ direction: 'sideways' }))).toThrow(/Expected "C2S"/)
  })

  it('defaults a missing type_name rather than rendering a blank row', () => {
    const capture = validateCapture(withPacket({ type_name: undefined }))
    expect(capture.sessions[0]!.packets[0]!.type_name).toBe('Unknown')
  })

  it('normalizes raw_hex to lowercase', () => {
    const capture = validateCapture(withPacket({ raw_hex: '51ABCDEF' }))
    expect(capture.sessions[0]!.packets[0]!.raw_hex).toBe('51abcdef')
  })
})

describe('field validation', () => {
  function withFields(fields: unknown) {
    const capture = validCapture()
    capture.sessions[0]!.packets[0]!.fields = fields as never
    return capture
  }

  it('rejects a byte range outside the packet', () => {
    expect(() => validateCapture(withFields([{ name: 'x', bytes: [0, 99] }]))).toThrow(/outside the 4-byte/)
  })

  it('rejects a malformed byte range', () => {
    expect(() => validateCapture(withFields([{ name: 'x', bytes: [1] }]))).toThrow(/\[start, end\] pair/)
  })

  // A zero-length value is encoded as `end === start-1`, so this is legal and must
  // not be mistaken for an inverted range.
  it('accepts a zero-length range', () => {
    const capture = validateCapture(withFields([{ name: 'empty', bytes: [4, 3] }]))
    expect(capture.sessions[0]!.packets[0]!.fields![0]!.bytes).toEqual([4, 3])
  })

  it('validates nested children against the packet too', () => {
    expect(() =>
      validateCapture(
        withFields([{ name: 'group', bytes: [0, 3], children: [{ name: 'bad', bytes: [0, 50] }] }]),
      ),
    ).toThrow(/children\[0\]/)
  })

  it('keeps nesting intact', () => {
    const capture = validateCapture(
      withFields([{ name: 'group', bytes: [0, 3], children: [{ name: 'inner', value: 7, bytes: [1, 2] }] }]),
    )
    const field = capture.sessions[0]!.packets[0]!.fields![0]!
    expect(field.children![0]!.value).toBe(7)
  })
})
