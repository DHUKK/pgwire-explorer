import type { FieldAnnotation, PacketRecord, Session } from '../types'

/**
 * The connection state a client would have built up after watching the first N
 * packets of a session.
 *
 * This is what makes stepping through a capture worth doing. A packet list shows
 * that a ParameterStatus went past. This shows that the session timezone is now
 * UTC because of it. Everything is derived by replaying packets in order, exactly
 * what a driver does, so it models the protocol as a state machine rather than as
 * a list of frames.
 */
export interface ConnectionState {
  /** Parameters the client asked for in StartupMessage. */
  startupParameters: Array<{ key: string; value: string }>
  /** Server settings, from ParameterStatus. Later values overwrite earlier ones. */
  serverParameters: Map<string, string>

  /**
   * The method the server asked for, known as soon as it asks. A method with
   * authenticated still false means the handshake is mid-flight.
   *
   * There is deliberately no step-by-step record here: the messages themselves
   * are the sequence, and duplicating them as a list said nothing the packet
   * list was not already saying.
   */
  authMethod: string | null
  authenticated: boolean

  /**
   * TLS negotiation as the packets actually show it: whether an SSLRequest or
   * GSSENCRequest went out, and the single byte that came back (S or G to
   * accept, N to refuse), or null while the reply is still outstanding.
   *
   * Derived from the stream rather than read off the capture's ssl_* fields, which
   * are the recorder's own summary. A recorder that always refuses would otherwise
   * make "refused" look like a property of the protocol.
   */
  tls: { requested: boolean; response: 'S' | 'N' | 'G' | null }

  /** From BackendKeyData: what a CancelRequest would need to quote. */
  backendPid: number | null
  backendSecret: string | null

  /** Latest ReadyForQuery status byte, or null before the first one. */
  transactionStatus: 'I' | 'T' | 'E' | null

  /** True after Terminate or a CancelRequest: nothing more is expected. */
  closed: boolean
}

/**
 * The authMethod value used when AuthenticationOk arrives with nothing before it.
 *
 * Exported so status.ts can recognise the case rather than matching the prose. It
 * is a value and not a boolean on ConnectionState because nothing else needs to
 * branch on it, and ConnectionState only carries what something renders.
 */
export const NO_CREDENTIAL_REQUESTED = 'no credential requested'

function emptyState(): ConnectionState {
  return {
    startupParameters: [],
    serverParameters: new Map(),
    tls: { requested: false, response: null },
    authMethod: null,
    authenticated: false,
    backendPid: null,
    backendSecret: null,
    transactionStatus: null,
    closed: false,
  }
}

/**
 * Replays `session` up to and including packet index `upTo` and returns the
 * resulting state.
 *
 * Recomputed from the start on every call rather than kept as a running value:
 * the user can jump anywhere in the timeline, including backwards, and a
 * fold-from-scratch cannot drift out of step with the selected packet. Sessions
 * are at most a few thousand packets, so this is cheap enough to do on every
 * selection change.
 */
export function stateAfter(session: Session, upTo: number): ConnectionState {
  const state = emptyState()
  const end = Math.min(upTo, session.packets.length - 1)

  for (let i = 0; i <= end; i++) {
    const packet = session.packets[i]
    if (packet) apply(state, packet)
  }
  return state
}

function apply(state: ConnectionState, packet: PacketRecord): void {
  const fields = packet.fields ?? []

  switch (packet.type_name) {
    case 'StartupMessage': {
      const params = findField(fields, 'Parameters')
      for (const pair of params?.children ?? []) {
        const key = valueOf(findField(pair.children ?? [], 'Key'))
        const value = valueOf(findField(pair.children ?? [], 'Value'))
        if (key !== '') state.startupParameters.push({ key, value })
      }
      break
    }

    case 'ParameterStatus': {
      const name = valueOf(findField(fields, 'Parameter Name'))
      const value = valueOf(findField(fields, 'Parameter Value'))
      if (name !== '') state.serverParameters.set(name, value)
      break
    }

    // --- TLS negotiation ----------------------------------------------------
    case 'SSLRequest':
    case 'GSSENCRequest':
      state.tls.requested = true
      break

    case 'SSLResponse':
    case 'GSSENCResponse': {
      // A single raw byte, not a message: no tag, no length, so it is read
      // straight off the front of the packet.
      const reply = byteAt(packet, 0)
      if (reply === 'S' || reply === 'N' || reply === 'G') state.tls.response = reply
      break
    }

    case 'BackendKeyData': {
      const pid = numberOf(findField(fields, 'Backend PID'))
      state.backendPid = pid
      state.backendSecret = valueOf(findField(fields, 'Secret Key'))
      break
    }

    case 'ReadyForQuery': {
      // The annotation shows a friendly label ("Idle", "InTransaction"), not the
      // wire byte, so the byte is read back out of raw_hex using the field's own
      // offset. That keeps this independent of how the decoder words the label.
      const status = byteAtField(packet, findField(fields, 'Transaction Status'))
      if (status === 'I' || status === 'T' || status === 'E') {
        state.transactionStatus = status
      }
      break
    }

    // --- authentication -----------------------------------------------------
    // Only the method is recorded. Which messages were exchanged is the packet
    // list's job.
    //
    // Every method below except SASL is named by its own message type: an
    // AuthenticationMD5Password can only mean md5. SASL is the exception, because
    // the mechanism is negotiated over two messages, so it is the one method that
    // has to be read off the wire. This used to report SCRAM-SHA-256 for any SASL
    // exchange, which was a confident lie about anything else, and PostgreSQL 18
    // added OAUTHBEARER.
    //
    // The server's offer is deliberately not read. It lists what the server will
    // accept, which is not the same as what is being used, and reporting a list
    // the client has not answered yet would be claiming to know something the
    // wire has not said.
    case 'AuthenticationSASL':
      state.authMethod = 'SASL'
      break

    // The client's pick, which is the mechanism actually in use, and the first
    // point at which it is known.
    case 'SASLInitialResponse': {
      const chosen = valueOf(findField(fields, 'Auth Mechanism'))
      if (chosen !== '') state.authMethod = `SASL (${chosen})`
      break
    }
    case 'AuthenticationMD5Password':
      state.authMethod = 'md5'
      break
    case 'AuthenticationCleartextPassword':
      state.authMethod = 'password (cleartext)'
      break
    case 'AuthenticationGSS':
      state.authMethod = 'GSSAPI'
      break
    case 'AuthenticationOk':
      // Accepted without ever asking for anything. Deliberately not called
      // "trust", because trust, peer and ident are byte for byte identical here:
      // peer takes the client's identity from the kernel and ident asks a service
      // on the client's host, so neither puts a single byte on this connection.
      // The wire supports only the weaker claim, that nothing was requested.
      //
      // A scenario may still say trust on its card, because whoever recorded it
      // configured the server and knows. This engine only ever sees the bytes.
      if (state.authMethod === null) state.authMethod = NO_CREDENTIAL_REQUESTED
      state.authenticated = true
      break

    // Prepared statements, portals and COPY mode are deliberately absent, along
    // with ErrorResponse, NoticeResponse and NotificationResponse. Some are
    // events rather than state, and the rest were tracked and shown and turned
    // out not to be worth a reader's attention. The message list shows all of it
    // with every field decoded. An error's lasting effect on the connection is
    // the transaction status going to E, which ReadyForQuery reports.

    case 'Terminate':
    case 'CancelRequest':
      state.closed = true
      break

    default:
      break
  }
}

/** The byte at `offset` in the packet, as a character. */
function byteAt(packet: PacketRecord, offset: number): string {
  const hex = packet.raw_hex.slice(offset * 2, offset * 2 + 2)
  if (hex.length !== 2) return ''
  return String.fromCharCode(Number.parseInt(hex, 16))
}

/**
 * The single byte a field covers, as a character, taken from the packet's raw
 * hex at the field's own start offset.
 *
 * Used where the annotation deliberately shows a human label instead of the wire
 * value. The byte-range invariant is what makes this safe: a field's range always
 * points at the bytes it describes.
 */
function byteAtField(packet: PacketRecord, field: FieldAnnotation | undefined): string {
  if (!field) return ''
  const offset = field.bytes[0]
  if (field.bytes[1] < offset) return ''
  return byteAt(packet, offset)
}

/** First field with this exact name, searching only one level. */
function findField(fields: FieldAnnotation[], name: string): FieldAnnotation | undefined {
  return fields.find((f) => f.name === name)
}

function valueOf(field: FieldAnnotation | undefined): string {
  if (!field || field.value === undefined || field.value === null) return ''
  return String(field.value)
}

function numberOf(field: FieldAnnotation | undefined): number | null {
  if (!field || typeof field.value !== 'number') return null
  return field.value
}
