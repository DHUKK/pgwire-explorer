import type { PacketRecord, Session } from '../types'

/**
 * One packet, placed on the real wall-clock timeline instead of its own
 * session's relative one.
 *
 * `timestamp_ms` on a `PacketRecord` is relative to its own session's
 * `started_at`, because a `CancelRequest` (and a replication connection) opens
 * a fresh TCP connection with its own clock. To show every session's packets
 * as one timeline, each packet's absolute moment is `started_at + timestamp_ms`,
 * which is what `wallClockMs` computes.
 */
export interface MergedRow {
  /** Index into `capture.sessions`, so the owning session can be looked up. */
  sessionIndex: number
  /** The session's own id, for display. */
  sessionId: number
  /** Index into that session's `packets` array. */
  packetIndex: number
  packet: PacketRecord
  /** Absolute time, `Date.parse(session.started_at) + packet.timestamp_ms`. */
  wallClockMs: number
}

/** A packet's absolute time: its session's start plus its own relative offset. */
export function wallClockMs(session: Session, packet: PacketRecord): number {
  return Date.parse(session.started_at) + packet.timestamp_ms
}

/**
 * Every packet from every session, in one list ordered by real time.
 *
 * Ties are resolved deterministically without a secondary key to compare:
 * rows are built session by session, packet by packet, in that order, and then
 * sorted by `wallClockMs` with `Array.prototype.sort`, which the language spec
 * guarantees is stable. So two packets that land on the exact same millisecond
 * keep the relative order they were pushed in, which is session order first and
 * packet order within a session second. A `CancelRequest`'s session always
 * starts after the session it cancels, so this only matters for packets that
 * are genuinely simultaneous, and stable order is the only sane tie-break for
 * those.
 */
export function mergeSessions(sessions: readonly Session[]): MergedRow[] {
  const rows: MergedRow[] = []
  sessions.forEach((session, sessionIndex) => {
    session.packets.forEach((packet, packetIndex) => {
      rows.push({
        sessionIndex,
        sessionId: session.id,
        packetIndex,
        packet,
        wallClockMs: wallClockMs(session, packet),
      })
    })
  })
  rows.sort((a, b) => a.wallClockMs - b.wallClockMs)
  return rows
}
