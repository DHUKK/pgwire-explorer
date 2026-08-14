import type { Session } from '../types'
import { NO_CREDENTIAL_REQUESTED, type ConnectionState } from './state'

/**
 * The connection's status as a small fixed set of pills.
 *
 * One definition, used by both the status bar and the drawer, so the two can
 * never disagree. The drawer is these pills with their explanations shown.
 *
 * TLS, AUTH and TX are the whole set, always present, in that order, whatever
 * the capture contains. A status line that changes shape as you step is hard to
 * read, because the eye has to re-find each value instead of watching it change.
 * A COPY pill was tried and removed for that reason: the CopyInResponse and
 * CopyDone in the message list already mark where the mode starts and ends.
 */
export interface StatusPill {
  key: 'tls' | 'auth' | 'tx'
  /** Short uppercase label. */
  label: string
  /** The current value, kept to a few words. */
  value: string
  tone?: 'ok' | 'error' | 'busy' | 'muted'
  /** What this state means. Shown in the drawer, not the bar. */
  explain: string
}

export function statusPills(state: ConnectionState, session: Session): StatusPill[] {
  return [tlsPill(state, session), authPill(state), txPill(state)]
}

/**
 * TLS state, read from the negotiation in the packet stream. An SSLRequest goes
 * out, then a single byte comes back.
 *
 * The capture's own ssl_requested and ssl_accepted fields are a fallback, used
 * only when the negotiation is not in the packets. They are the recorder's
 * summary of what it did. Taking them as the answer would report "refused" as a
 * fact about the protocol rather than a choice the recorder made.
 */
function tlsPill(state: ConnectionState, session: Session): StatusPill {
  const requested = state.tls.requested || session.ssl_requested
  if (!requested) {
    return {
      key: 'tls',
      label: 'TLS',
      value: 'not requested',
      tone: 'muted',
      explain: 'No `SSLRequest` was sent. Plaintext from the first byte.',
    }
  }

  // The packets are the evidence. The recorder's flag is a fallback for when the
  // reply is not in the capture.
  const reply = state.tls.response ?? (session.ssl_accepted ? 'S' : null)

  if (reply === 'S' || reply === 'G') {
    return {
      key: 'tls',
      label: 'TLS',
      value: 'accepted',
      tone: 'ok',
      explain: `The server answered \`${reply}\`. Everything after that byte is encrypted.`,
    }
  }
  if (reply === 'N') {
    return {
      key: 'tls',
      label: 'TLS',
      value: 'refused',
      tone: 'muted',
      explain: 'The server answered `N`. The session continues in plaintext.',
    }
  }
  return {
    key: 'tls',
    label: 'TLS',
    value: 'awaiting reply',
    tone: 'busy',
    explain: 'Request sent. The one-byte reply has not arrived.',
  }
}

function authPill(state: ConnectionState): StatusPill {
  if (state.authenticated) {
    // Nothing was sent, so there is nothing to have accepted. Saying credentials
    // were accepted would contradict the value beside it.
    const nothingAsked = state.authMethod === NO_CREDENTIAL_REQUESTED
    return {
      key: 'auth',
      label: 'AUTH',
      value: state.authMethod ?? 'ok',
      tone: 'ok',
      explain: nothingAsked
        ? '`AuthenticationOk` arrived with no credential ever requested. The server was configured to let this connection in, by `trust`, `peer` or `ident`, which look identical on the wire.'
        : '`AuthenticationOk` received. Credentials accepted.',
    }
  }
  if (state.authMethod !== null) {
    // The method is known from the moment the server asks for it, so a method
    // without AuthenticationOk means the exchange is still going.
    return {
      key: 'auth',
      label: 'AUTH',
      value: `${state.authMethod}, in progress`,
      tone: 'busy',
      explain: 'Credential requested. Not yet accepted.',
    }
  }
  return {
    key: 'auth',
    label: 'AUTH',
    value: 'not started',
    tone: 'muted',
    explain: 'No authentication method requested yet.',
  }
}

function txPill(state: ConnectionState): StatusPill {
  switch (state.transactionStatus) {
    case 'I':
      return {
        key: 'tx',
        label: 'TX',
        value: 'idle',
        tone: 'ok',
        explain: 'No transaction open.',
      }
    case 'T':
      return {
        key: 'tx',
        label: 'TX',
        value: 'in transaction',
        tone: 'busy',
        explain: 'Inside a transaction block. Nothing commits until `COMMIT`.',
      }
    case 'E':
      return {
        key: 'tx',
        label: 'TX',
        value: 'failed',
        tone: 'error',
        explain: 'A statement failed in this transaction block. Every command is rejected until `ROLLBACK`.',
      }
    default:
      return {
        key: 'tx',
        label: 'TX',
        value: 'unknown',
        tone: 'muted',
        explain: 'No `ReadyForQuery` received yet.',
      }
  }
}
