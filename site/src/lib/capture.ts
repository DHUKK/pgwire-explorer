import {
  SUPPORTED_SCHEMA,
  type FieldAnnotation,
  type PacketRecord,
  type Session,
  type SessionCapture,
} from '../types'

/**
 * Parsing a capture is the one place untrusted input enters the app: a user
 * drops in a file that may be the wrong JSON entirely, a hand-edited capture, or
 * a capture from a newer recorder. Validation is strict, so everything
 * downstream may assume the structure is sound and stay free of defensive
 * checks.
 *
 * These messages quote the exact JSON path that failed, which is useful for
 * debugging but not something an uploader can act on: a capture is written by
 * a tool, not typed by hand. App.tsx's file-upload path logs the real
 * CaptureError to the console and shows the reader one generic message
 * instead. loadScenario shows this message directly, because a shipped
 * scenario failing validation is a build bug worth surfacing precisely.
 */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureError'
  }
}

/** Parses and validates a capture from a JSON string. */
export function parseCapture(text: string): SessionCapture {
  if (text.trim() === '') {
    throw new CaptureError('That file is empty.')
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new CaptureError(`That file is not valid JSON: ${(err as Error).message}`)
  }
  return validateCapture(raw)
}

/** Validates an already-parsed value. Exported for tests and scenario loading. */
export function validateCapture(raw: unknown): SessionCapture {
  if (!isObject(raw)) {
    throw new CaptureError('This JSON is not a capture: the top level should be an object.')
  }

  if (!('sessions' in raw) || !('version' in raw)) {
    // Being specific here matters: the most likely mistake is dropping in some
    // other JSON file entirely.
    throw new CaptureError(
      'This JSON does not look like a pgwire capture: it has no "version" and "sessions" fields.',
    )
  }

  const version = raw.version
  if (typeof version !== 'string') {
    throw new CaptureError('The capture "version" field is not a string.')
  }
  const major = version.split('.')[0]
  const supportedMajor = SUPPORTED_SCHEMA.split('.')[0]
  if (major !== supportedMajor) {
    throw new CaptureError(
      `This capture is schema version ${version}. This build reads ${SUPPORTED_SCHEMA}.`,
    )
  }

  if (!Array.isArray(raw.sessions)) {
    throw new CaptureError('The capture "sessions" field is not an array.')
  }
  if (raw.sessions.length === 0) {
    throw new CaptureError(
      'This capture contains no sessions: nothing connected through the proxy.',
    )
  }

  const sessions = raw.sessions.map((session, i) => validateSession(session, i))

  return {
    version,
    recorded_at: typeof raw.recorded_at === 'string' ? raw.recorded_at : '',
    sessions,
  }
}

function validateSession(raw: unknown, index: number): Session {
  const where = `sessions[${index}]`
  if (!isObject(raw)) {
    throw new CaptureError(`${where} is not an object.`)
  }
  if (!Array.isArray(raw.packets)) {
    throw new CaptureError(`${where} has no "packets" array.`)
  }

  return {
    id: num(raw.id, index + 1),
    client_addr: str(raw.client_addr, 'unknown'),
    server_addr: str(raw.server_addr, 'unknown'),
    started_at: str(raw.started_at, ''),
    ended_at: typeof raw.ended_at === 'string' ? raw.ended_at : undefined,
    ssl_requested: raw.ssl_requested === true,
    ssl_accepted: raw.ssl_accepted === true,
    packets: raw.packets.map((packet, j) => validatePacket(packet, `${where}.packets[${j}]`, j)),
  }
}

function validatePacket(raw: unknown, where: string, index: number): PacketRecord {
  if (!isObject(raw)) {
    throw new CaptureError(`${where} is not an object.`)
  }

  const rawHex = str(raw.raw_hex, '')
  if (!/^[0-9a-fA-F]*$/.test(rawHex)) {
    throw new CaptureError(`${where}.raw_hex is not hexadecimal.`)
  }
  if (rawHex.length % 2 !== 0) {
    throw new CaptureError(`${where}.raw_hex has an odd number of digits.`)
  }

  // length and raw_hex must agree, because the hex dump indexes bytes by the
  // offsets in the field annotations and would silently mis-highlight otherwise.
  const byteLength = rawHex.length / 2
  const declared = num(raw.length, byteLength)
  if (declared !== byteLength) {
    throw new CaptureError(
      `${where} says it is ${declared} bytes but carries ${byteLength} bytes of raw_hex.`,
    )
  }

  const direction = raw.direction === 'C2S' || raw.direction === 'S2C' ? raw.direction : null
  if (direction === null) {
    throw new CaptureError(
      `${where}.direction is ${JSON.stringify(raw.direction)}. Expected "C2S" or "S2C".`,
    )
  }

  const fields = raw.fields
  return {
    id: num(raw.id, index + 1),
    direction,
    timestamp_ms: num(raw.timestamp_ms, 0),
    stream_offset: num(raw.stream_offset, 0),
    length: byteLength,
    raw_hex: rawHex.toLowerCase(),
    type_char: typeof raw.type_char === 'string' ? raw.type_char : undefined,
    // Every frame is supposed to be named. Fall back rather than render blanks.
    type_name: str(raw.type_name, 'Unknown'),
    fields: Array.isArray(fields)
      ? fields.map((f, k) => validateField(f, `${where}.fields[${k}]`, byteLength))
      : undefined,
  }
}

function validateField(raw: unknown, where: string, packetLength: number): FieldAnnotation {
  if (!isObject(raw)) {
    throw new CaptureError(`${where} is not an object.`)
  }

  const bytes = raw.bytes
  if (!Array.isArray(bytes) || bytes.length !== 2) {
    throw new CaptureError(`${where}.bytes is not a [start, end] pair.`)
  }
  const start = num(bytes[0], 0)
  const end = num(bytes[1], -1)

  // `end === start-1` is the encoding for a zero-length value, so it is legal.
  const empty = end === start - 1
  if (!empty && (start < 0 || end < start || end >= packetLength)) {
    throw new CaptureError(
      `${where}.bytes is [${start}, ${end}], which is outside the ${packetLength}-byte packet.`,
    )
  }

  const value = raw.value
  const children = raw.children

  return {
    name: str(raw.name, '(unnamed)'),
    value:
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? value
        : undefined,
    bytes: [start, end],
    children: Array.isArray(children)
      ? children.map((c, i) => validateField(c, `${where}.children[${i}]`, packetLength))
      : undefined,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Total packets across every session. */
export function packetCount(capture: SessionCapture): number {
  return capture.sessions.reduce((total, session) => total + session.packets.length, 0)
}

/**
 * Wall-clock duration of a session in milliseconds, taken from its packet
 * timestamps rather than started_at/ended_at: the timestamps are what the
 * timeline is drawn from, so this keeps the two consistent.
 */
export function sessionDurationMs(session: Session): number {
  const last = session.packets[session.packets.length - 1]
  return last ? last.timestamp_ms : 0
}
