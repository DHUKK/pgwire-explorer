/**
 * The capture file format, mirroring internal/capture's Go structs. Field names
 * are the JSON names, so these types are the contract between the Go recorder
 * and this UI.
 *
 * Schema "2.0": packets are grouped into sessions, one per TCP connection the
 * proxy accepted. A CancelRequest always arrives on its own connection, so it
 * gets its own session with its own start time and stream offsets.
 */

/** The schema version this build understands. */
export const SUPPORTED_SCHEMA = '2.0'

/**
 * A decoded value together with the exact bytes that produced it.
 *
 * `bytes` is an INCLUSIVE [start, end] range relative to the start of the
 * packet, where the type tag (if the message has one) is byte 0. Two invariants
 * hold, enforced by the Go test suite, and the whole hex-dump/field-tree
 * linking depends on them:
 *
 *   1. Top-level ranges tile the packet exactly: every byte covered once.
 *   2. Every child's range lies within its parent's.
 *
 * An empty value is encoded as `end === start-1`, a zero-length range, which is
 * why anything walking these ranges has to handle end < start.
 */
export interface FieldAnnotation {
  name: string
  value?: string | number | boolean | null
  bytes: [number, number]
  children?: FieldAnnotation[]
}

export type Direction = 'C2S' | 'S2C'

export interface PacketRecord {
  /** 1-based, dense, within its session. */
  id: number
  direction: Direction
  /** Milliseconds since *this session's* start, not the capture's. */
  timestamp_ms: number
  /** Byte offset within this direction's stream. */
  stream_offset: number
  length: number
  raw_hex: string
  /** The 1-byte type tag. Absent for startup-format messages, which have none. */
  type_char?: string
  /** Never empty: undecodable frames are named "Unknown". */
  type_name: string
  fields?: FieldAnnotation[]
}

export interface Session {
  id: number
  client_addr: string
  server_addr: string
  started_at: string
  ended_at?: string
  ssl_requested: boolean
  ssl_accepted: boolean
  packets: PacketRecord[]
}

export interface SessionCapture {
  version: string
  recorded_at: string
  sessions: Session[]
}

/**
 * One message in a capture, named the way a route names it: by session id and
 * packet id rather than by position, so it survives a session being deselected.
 */
export interface PacketFocus {
  sessionId: number
  packetId: number
}

/** A capture plus where it came from, which is all the UI needs to label it. */
export interface LoadedCapture {
  capture: SessionCapture
  /** Display name: a filename, or a scenario title. */
  name: string
  source: 'file' | 'scenario'
  /** Set for scenarios: the teaching notes that go with it. */
  scenarioId?: string
  /**
   * Which message to open on, when the route named one. Set by a link from the
   * message index. The explorer starts on the first message otherwise.
   */
  focus?: PacketFocus
}
