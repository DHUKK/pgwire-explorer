import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCapture } from './capture'
import { mergeSessions, wallClockMs } from './merge'
import type { PacketRecord, Session } from '../types'

const SCENARIO_DIR = join(import.meta.dirname, '../../public/scenarios')

function loadScenario(id: string): Session[] {
  const raw = JSON.parse(readFileSync(join(SCENARIO_DIR, `${id}.json`), 'utf8'))
  return validateCapture(raw).sessions
}

/** A minimal packet, only the fields mergeSessions and wallClockMs touch. */
function packet(id: number, timestamp_ms: number): PacketRecord {
  return {
    id,
    direction: 'C2S',
    timestamp_ms,
    stream_offset: 0,
    length: 0,
    raw_hex: '',
    type_name: 'Query',
  }
}

function session(id: number, started_at: string, packets: PacketRecord[]): Session {
  return {
    id,
    client_addr: '127.0.0.1:0',
    server_addr: '127.0.0.1:5432',
    started_at,
    ssl_requested: false,
    ssl_accepted: false,
    packets,
  }
}

describe('mergeSessions, over real captures', () => {
  // cancel-request has an ordinary session and a second connection carrying
  // only the CancelRequest, which starts well after session 1's first packets
  // but before session 1 closes. The merge has to interleave it there, not
  // tack it onto the end.
  it('interleaves a CancelRequest between the correct session-1 packets by wall-clock time', () => {
    const [session1, session2] = loadScenario('cancel-request')
    const rows = mergeSessions([session1!, session2!])

    expect(rows).toHaveLength(session1!.packets.length + session2!.packets.length)

    // Every row's wall-clock time is non-decreasing: that is the entire point
    // of the merge.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.wallClockMs).toBeGreaterThanOrEqual(rows[i - 1]!.wallClockMs)
    }

    const cancelIndex = rows.findIndex((r) => r.sessionIndex === 1)
    expect(cancelIndex).toBeGreaterThan(0)
    expect(cancelIndex).toBeLessThan(rows.length - 1)

    // The row immediately before and after the CancelRequest both belong to
    // session 1, and the CancelRequest's wall-clock time falls between theirs.
    const before = rows[cancelIndex - 1]!
    const cancel = rows[cancelIndex]!
    const after = rows[cancelIndex + 1]!
    expect(before.sessionIndex).toBe(0)
    expect(cancel.packet.type_name).toBe('CancelRequest')
    expect(cancel.wallClockMs).toBeGreaterThanOrEqual(before.wallClockMs)
    if (after) expect(cancel.wallClockMs).toBeLessThanOrEqual(after.wallClockMs)
  })

  // replication-physical has a replication connection streaming the WAL
  // (session 1, opened first) and an ordinary write connection (session 2).
  // The write and the XLogData that carries it should land next to each
  // other once merged.
  it('places the write next to the XLogData that carries it', () => {
    const [replication, ordinary] = loadScenario('replication-physical')
    const rows = mergeSessions([replication!, ordinary!])

    const xlogIndex = rows.findIndex(
      (r) => r.sessionIndex === 0 && r.packet.type_name === 'CopyData',
    )
    expect(xlogIndex).toBeGreaterThan(-1)

    // The write happened on the ordinary connection at some point at or before
    // the XLogData that streamed it out, so somewhere earlier in the merged
    // list there is a C2S packet from session 1.
    const earlierWrite = rows
      .slice(0, xlogIndex + 1)
      .some((r) => r.sessionIndex === 1 && r.packet.direction === 'C2S')
    expect(earlierWrite).toBe(true)
  })

  it('keeps a single-session capture in its original order', () => {
    const [session1] = loadScenario('simple-query')
    const rows = mergeSessions([session1!])

    expect(rows.map((r) => r.packet.id)).toEqual(session1!.packets.map((p) => p.id))
    expect(rows.every((r) => r.sessionIndex === 0)).toBe(true)
  })

  it('maps every merged row back to its owning session and index', () => {
    const sessions = loadScenario('cancel-request')
    const rows = mergeSessions(sessions)

    for (const row of rows) {
      const owner = sessions[row.sessionIndex]!
      expect(owner.id).toBe(row.sessionId)
      expect(owner.packets[row.packetIndex]).toBe(row.packet)
    }
  })
})

describe('wallClockMs', () => {
  it('adds the packet offset to the session start', () => {
    const s = session(1, '2024-01-01T00:00:00.000Z', [])
    expect(wallClockMs(s, packet(1, 250))).toBe(Date.parse('2024-01-01T00:00:00.000Z') + 250)
  })
})

describe('mergeSessions, ties and ordering', () => {
  it('breaks a tie by session order, then packet order, deterministically', () => {
    // Both sessions start at the same instant, and each packet lands on the
    // same relative offset, so every row ties on wall-clock time. The only way
    // for the result to be deterministic is for stable sort to preserve
    // build order: session 0 before session 1, and within a session, packet
    // order.
    const started = '2024-01-01T00:00:00.000Z'
    const a = session(10, started, [packet(1, 0), packet(2, 5)])
    const b = session(20, started, [packet(1, 0), packet(2, 5)])

    const rows = mergeSessions([a, b])

    expect(rows.map((r) => [r.sessionId, r.packetIndex])).toEqual([
      [10, 0],
      [20, 0],
      [10, 1],
      [20, 1],
    ])
  })

  it('is stable across repeated calls on the same tied input', () => {
    const started = '2024-01-01T00:00:00.000Z'
    const a = session(1, started, [packet(1, 0)])
    const b = session(2, started, [packet(1, 0)])

    const first = mergeSessions([a, b]).map((r) => r.sessionId)
    const second = mergeSessions([a, b]).map((r) => r.sessionId)
    expect(first).toEqual(second)
    expect(first).toEqual([1, 2])
  })

  it('orders sessions that start at different times correctly even when relative offsets tie', () => {
    const a = session(1, '2024-01-01T00:00:00.500Z', [packet(1, 0)])
    const b = session(2, '2024-01-01T00:00:00.000Z', [packet(1, 0)])

    const rows = mergeSessions([a, b])
    // b started earlier, so its packet-0 (at its own offset 0) comes first
    // even though a was passed first.
    expect(rows.map((r) => r.sessionId)).toEqual([2, 1])
  })
})

describe('mergeSessions, row identity across colliding packet ids', () => {
  // A PacketRecord's own `id` is only 1-based and dense within its own
  // session, so a capture of several sessions routinely has a "packet 1" and
  // a "packet 2" in every one of them. PacketList used to key its rows by
  // `packet.id` alone, which collided across sessions in exactly this shape
  // of capture and made React silently duplicate or drop rows in the merged
  // view. A fixture where ids happen not to collide would let that bug pass
  // this test, so this one is built to collide on purpose, the same shape as
  // the real capture that surfaced it: several sessions, each numbering its
  // own packets from 1.
  it('never lets two rows share a (sessionId, packet.id) pair, even with heavy id overlap', () => {
    const started = '2024-01-01T00:00:00.000Z'
    const sessions = [10, 20, 30].map((id) =>
      session(
        id,
        started,
        Array.from({ length: 50 }, (_, i) => packet(i + 1, i)),
      ),
    )

    const rows = mergeSessions(sessions)
    expect(rows).toHaveLength(150)

    const pairs = rows.map((r) => `${r.sessionId}:${r.packet.id}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  // Packet ids collide across sessions on real captures too: cancel-request's
  // own CancelRequest connection restarts numbering from 1, same as the main
  // session.
  it('keeps (sessionId, packet.id) unique on a real multi-session capture', () => {
    const sessions = loadScenario('cancel-request')
    const rows = mergeSessions(sessions)

    const pairs = rows.map((r) => `${r.sessionId}:${r.packet.id}`)
    expect(new Set(pairs).size).toBe(pairs.length)
  })
})
