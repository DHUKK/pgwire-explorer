import { describe, expect, it } from 'vitest'
import { deriveMeta, formatFileSize, formatSavedAt, sortByNewest } from './savedCaptures'
import type { SessionCapture } from '../types'

function makeCapture(packetsPerSession: number[]): SessionCapture {
  return {
    version: '2.0',
    recorded_at: '',
    sessions: packetsPerSession.map((count, i) => ({
      id: i + 1,
      client_addr: 'unknown',
      server_addr: 'unknown',
      started_at: '',
      ssl_requested: false,
      ssl_accepted: false,
      packets: Array.from({ length: count }, (_, j) => ({
        id: j + 1,
        direction: 'C2S' as const,
        timestamp_ms: 0,
        stream_offset: 0,
        length: 0,
        raw_hex: '',
        type_name: 'Unknown',
      })),
    })),
  }
}

describe('deriveMeta', () => {
  it('counts sessions and packets from the parsed capture', () => {
    const capture = makeCapture([3, 5])
    const meta = deriveMeta('cap.json', capture, 1234, '2026-08-12T00:00:00.000Z')
    expect(meta).toEqual({
      name: 'cap.json',
      savedAt: '2026-08-12T00:00:00.000Z',
      size: 1234,
      sessionCount: 2,
      packetCount: 8,
    })
  })

  it('handles a single session with no packets', () => {
    const capture = makeCapture([0])
    const meta = deriveMeta('empty.json', capture, 0, '2026-01-01T00:00:00.000Z')
    expect(meta.sessionCount).toBe(1)
    expect(meta.packetCount).toBe(0)
  })
})

describe('sortByNewest', () => {
  it('orders newest first', () => {
    const entries = [
      { name: 'a', savedAt: '2026-01-01T00:00:00.000Z', size: 1, sessionCount: 1, packetCount: 1 },
      { name: 'b', savedAt: '2026-06-01T00:00:00.000Z', size: 1, sessionCount: 1, packetCount: 1 },
      { name: 'c', savedAt: '2026-03-01T00:00:00.000Z', size: 1, sessionCount: 1, packetCount: 1 },
    ]
    expect(sortByNewest(entries).map((e) => e.name)).toEqual(['b', 'c', 'a'])
  })

  it('breaks ties on filename so the order is stable', () => {
    const entries = [
      { name: 'z', savedAt: '2026-01-01T00:00:00.000Z', size: 1, sessionCount: 1, packetCount: 1 },
      { name: 'a', savedAt: '2026-01-01T00:00:00.000Z', size: 1, sessionCount: 1, packetCount: 1 },
    ]
    expect(sortByNewest(entries).map((e) => e.name)).toEqual(['a', 'z'])
  })

  it('does not mutate its input', () => {
    const entries = [
      { name: 'a', savedAt: '2026-01-01T00:00:00.000Z', size: 1, sessionCount: 1, packetCount: 1 },
      { name: 'b', savedAt: '2026-06-01T00:00:00.000Z', size: 1, sessionCount: 1, packetCount: 1 },
    ]
    const copy = [...entries]
    sortByNewest(entries)
    expect(entries).toEqual(copy)
  })

  it('is empty for an empty list', () => {
    expect(sortByNewest([])).toEqual([])
  })
})

describe('formatFileSize', () => {
  it('renders small sizes in bytes', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(58)).toBe('58 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('renders kilobytes with one decimal', () => {
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(348_160)).toBe('340 KB')
  })

  it('renders megabytes, matching the 32MB capture this feature exists for', () => {
    expect(formatFileSize(32 * 1024 * 1024)).toBe('32 MB')
    expect(formatFileSize(1.2 * 1024 * 1024)).toBe('1.2 MB')
  })

  it('renders gigabytes', () => {
    expect(formatFileSize(2 * 1024 * 1024 * 1024)).toBe('2 GB')
  })

  it('treats invalid input as zero', () => {
    expect(formatFileSize(-5)).toBe('0 B')
    expect(formatFileSize(NaN)).toBe('0 B')
  })
})

describe('formatSavedAt', () => {
  // A fixed zone, because the point is the reader's local time and CI's clock
  // is not the reader's.
  it('renders the date and time in the given zone', () => {
    const formatted = formatSavedAt('2026-08-12T14:03:07.000Z', 'UTC')
    expect(formatted).toContain('2026')
    expect(formatted).toContain('12')
    expect(formatted).toMatch(/\b02:03\b|\b14:03\b/)
  })

  // The same instant in two zones must not read the same, otherwise the local
  // conversion is not happening at all.
  it('follows the time zone it is given', () => {
    const utc = formatSavedAt('2026-08-12T23:30:00.000Z', 'UTC')
    const tokyo = formatSavedAt('2026-08-12T23:30:00.000Z', 'Asia/Tokyo')
    expect(tokyo).not.toBe(utc)
    expect(tokyo).toContain('13')
  })

  it('falls back to the raw string for an unparseable timestamp', () => {
    expect(formatSavedAt('not-a-date')).toBe('not-a-date')
  })
})
