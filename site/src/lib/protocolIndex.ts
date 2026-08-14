/**
 * Every message in the frontend/backend protocol, as reference data for the
 * index page.
 *
 * Transcribed by hand from message-identifiers.md at the root of this repo, which
 * was itself extracted from the protocol-message-formats page of the PostgreSQL
 * documentation for every release from 7.4 to 18. Transcribed on 2026-08-14.
 *
 * All of it is protocol version 3.0 and 3.2. The range starts at 7.4 because that
 * is where major version 3 arrived, so this is the whole life of the protocol.
 * 3.2, added in 18, changed the layout of BackendKeyData and CancelRequest but
 * added and removed nothing, so it does not appear here.
 *
 * There is no generator, on purpose. Fifteen of the 55 arrived or departed across
 * twenty-two releases, and none has since 12, so a fetch-and-extract pipeline
 * would cost more than it saves. To refresh this by hand: re-read message-identifiers.md, edit the table
 * below, and run `npx vitest run src/lib/protocolIndex.test.ts`. That test
 * compares the names here against documentedMessages in
 * internal/pgproto/coverage_test.go, so a dropped or misspelled message fails
 * rather than going unnoticed.
 *
 * Display data only. This file says what a message is called and which byte
 * identifies it. Nothing here decodes anything, and nothing here may: decoding
 * lives in Go.
 */

import { MESSAGE_DOCS } from './messages'
import { docsUrlForTypeName } from './docs'

/**
 * The releases this index covers, oldest first. Strings rather than numbers,
 * because the 9.x releases each documented the protocol separately and three
 * messages arrived partway through them.
 */
export const VERSIONS = [
  '7.4', '8.0', '8.1', '8.2', '8.3', '8.4',
  '9.0', '9.1', '9.2', '9.3', '9.4', '9.5', '9.6',
  '10', '11', '12', '13', '14', '15', '16', '17', '18',
] as const

/**
 * The phases, in the order the index shows them, which is the order a session
 * moves through them.
 */
/** One of the releases this index covers. */
export type Release = (typeof VERSIONS)[number]

export type MessagePhase =
  | 'negotiation'
  | 'authentication'
  | 'session-setup'
  | 'simple-query'
  | 'extended-query'
  | 'copy'
  | 'function-call'
  | 'any-time'
  | 'termination'

export const PHASES: readonly MessagePhase[] = [
  'negotiation',
  'authentication',
  'session-setup',
  'simple-query',
  'extended-query',
  'copy',
  'function-call',
  'any-time',
  'termination',
]

export const PHASE_LABELS: Record<MessagePhase, string> = {
  negotiation: 'Connection negotiation',
  authentication: 'Authentication',
  'session-setup': 'Session setup',
  'simple-query': 'Simple query',
  'extended-query': 'Extended query',
  copy: 'COPY',
  'function-call': 'Function call',
  'any-time': 'Any time',
  termination: 'Termination',
}

/** `F` is client to server, `B` is server to client, `FB` is both. */
export type MessageDirection = 'F' | 'B' | 'FB'

export const DIRECTION_LABELS: Record<MessageDirection, string> = {
  F: 'Frontend',
  B: 'Backend',
  FB: 'Both directions',
}

export interface ProtocolMessage {
  /** The pgproto3 type name, which is also the name the Go decoder emits. */
  name: string
  /** The type byte. Absent for the untagged startup-format messages. */
  typeByte?: string
  direction: MessageDirection
  phase: MessagePhase
  /**
   * The Int32 that tells this message from others sharing its byte. An
   * authentication code for tag `R`, a request code for an untagged message.
   */
  code?: number
  /**
   * Which of VERSIONS document it, omitted where all of them do. Fifteen of the
   * 55 arrived or departed partway through the range.
   */
  versions?: readonly string[]
}

/**
 * The 55 messages, grouped by phase in the order PHASES lists them, and within a
 * phase in the order message-identifiers.md lists them.
 */
export const PROTOCOL_MESSAGES: readonly ProtocolMessage[] = [
  // ---------------------------------------------------------- negotiation
  { name: 'StartupMessage', direction: 'F', phase: 'negotiation', code: 196608 },
  { name: 'SSLRequest', direction: 'F', phase: 'negotiation', code: 80877103 },
  {
    name: 'GSSENCRequest',
    direction: 'F',
    phase: 'negotiation',
    code: 80877104,
    versions: ['12', '13', '14', '15', '16', '17', '18'],
  },
  { name: 'CancelRequest', direction: 'F', phase: 'negotiation', code: 80877102 },
  {
    name: 'NegotiateProtocolVersion',
    typeByte: 'v',
    direction: 'B',
    phase: 'negotiation',
    versions: ['9.3', '9.4', '9.5', '9.6', '10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },

  // --------------------------------------------------------- authentication
  { name: 'AuthenticationOk', typeByte: 'R', direction: 'B', phase: 'authentication', code: 0 },
  {
    name: 'AuthenticationKerberosV5',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 2,
  },
  {
    name: 'AuthenticationKerberosV4',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 1,
    versions: ['7.4', '8.0'],
  },
  {
    name: 'AuthenticationCleartextPassword',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 3,
  },
  {
    name: 'AuthenticationCryptPassword',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 4,
    versions: ['7.4', '8.0', '8.1', '8.2', '8.3'],
  },
  {
    name: 'AuthenticationMD5Password',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 5,
  },
  {
    name: 'AuthenticationSCMCredential',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 6,
    versions: ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '9.0', '9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '10', '11', '12', '13', '14', '15'],
  },
  {
    name: 'AuthenticationGSS',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 7,
    versions: ['8.3', '8.4', '9.0', '9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  {
    name: 'AuthenticationGSSContinue',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 8,
    versions: ['8.3', '8.4', '9.0', '9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  {
    name: 'AuthenticationSSPI',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 9,
    versions: ['8.3', '8.4', '9.0', '9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  {
    name: 'AuthenticationSASL',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 10,
    versions: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  {
    name: 'AuthenticationSASLContinue',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 11,
    versions: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  {
    name: 'AuthenticationSASLFinal',
    typeByte: 'R',
    direction: 'B',
    phase: 'authentication',
    code: 12,
    versions: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  { name: 'PasswordMessage', typeByte: 'p', direction: 'F', phase: 'authentication' },
  {
    name: 'GSSResponse',
    typeByte: 'p',
    direction: 'F',
    phase: 'authentication',
    versions: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  {
    name: 'SASLInitialResponse',
    typeByte: 'p',
    direction: 'F',
    phase: 'authentication',
    versions: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  {
    name: 'SASLResponse',
    typeByte: 'p',
    direction: 'F',
    phase: 'authentication',
    versions: ['10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },

  // --------------------------------------------------------- session setup
  { name: 'ParameterStatus', typeByte: 'S', direction: 'B', phase: 'session-setup' },
  { name: 'BackendKeyData', typeByte: 'K', direction: 'B', phase: 'session-setup' },

  // ---------------------------------------------------------- simple query
  { name: 'Query', typeByte: 'Q', direction: 'F', phase: 'simple-query' },
  { name: 'RowDescription', typeByte: 'T', direction: 'B', phase: 'simple-query' },
  { name: 'DataRow', typeByte: 'D', direction: 'B', phase: 'simple-query' },
  { name: 'CommandComplete', typeByte: 'C', direction: 'B', phase: 'simple-query' },
  { name: 'EmptyQueryResponse', typeByte: 'I', direction: 'B', phase: 'simple-query' },
  { name: 'ReadyForQuery', typeByte: 'Z', direction: 'B', phase: 'simple-query' },

  // -------------------------------------------------------- extended query
  { name: 'Parse', typeByte: 'P', direction: 'F', phase: 'extended-query' },
  { name: 'ParseComplete', typeByte: '1', direction: 'B', phase: 'extended-query' },
  { name: 'Bind', typeByte: 'B', direction: 'F', phase: 'extended-query' },
  { name: 'BindComplete', typeByte: '2', direction: 'B', phase: 'extended-query' },
  { name: 'Describe', typeByte: 'D', direction: 'F', phase: 'extended-query' },
  { name: 'ParameterDescription', typeByte: 't', direction: 'B', phase: 'extended-query' },
  { name: 'NoData', typeByte: 'n', direction: 'B', phase: 'extended-query' },
  { name: 'Execute', typeByte: 'E', direction: 'F', phase: 'extended-query' },
  { name: 'PortalSuspended', typeByte: 's', direction: 'B', phase: 'extended-query' },
  { name: 'Close', typeByte: 'C', direction: 'F', phase: 'extended-query' },
  { name: 'CloseComplete', typeByte: '3', direction: 'B', phase: 'extended-query' },
  { name: 'Sync', typeByte: 'S', direction: 'F', phase: 'extended-query' },
  { name: 'Flush', typeByte: 'H', direction: 'F', phase: 'extended-query' },

  // ------------------------------------------------------------------- COPY
  { name: 'CopyInResponse', typeByte: 'G', direction: 'B', phase: 'copy' },
  { name: 'CopyOutResponse', typeByte: 'H', direction: 'B', phase: 'copy' },
  {
    name: 'CopyBothResponse',
    typeByte: 'W',
    direction: 'B',
    phase: 'copy',
    versions: ['9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '10', '11', '12', '13', '14', '15', '16', '17', '18'],
  },
  { name: 'CopyData', typeByte: 'd', direction: 'FB', phase: 'copy' },
  { name: 'CopyDone', typeByte: 'c', direction: 'FB', phase: 'copy' },
  { name: 'CopyFail', typeByte: 'f', direction: 'F', phase: 'copy' },

  // ---------------------------------------------------------- function call
  { name: 'FunctionCall', typeByte: 'F', direction: 'F', phase: 'function-call' },
  { name: 'FunctionCallResponse', typeByte: 'V', direction: 'B', phase: 'function-call' },

  // --------------------------------------------------------------- any time
  { name: 'ErrorResponse', typeByte: 'E', direction: 'B', phase: 'any-time' },
  { name: 'NoticeResponse', typeByte: 'N', direction: 'B', phase: 'any-time' },
  { name: 'NotificationResponse', typeByte: 'A', direction: 'B', phase: 'any-time' },

  // ------------------------------------------------------------- termination
  { name: 'Terminate', typeByte: 'X', direction: 'F', phase: 'termination' },
]

/**
 * The messages this tool does not annotate, which the index marks with a star.
 *
 * Names only. Why each one is skipped is written once, in unhandledMessages in
 * internal/pgproto/coverage_test.go, where the decision actually lives. A test
 * keeps this list in step with that one, so a message gaining or losing support
 * fails here rather than leaving the page quietly wrong.
 */
export const UNDECODED_MESSAGE_NAMES: readonly string[] = [
  'AuthenticationKerberosV4',
  'AuthenticationCryptPassword',
  'AuthenticationKerberosV5',
  'AuthenticationSCMCredential',
]

/**
 * A one-line summary for the two messages MESSAGE_DOCS has no entry for.
 *
 * MESSAGE_DOCS covers what a capture can contain, and these cannot appear in one.
 * The index shows all 55 regardless, so it needs a line for them. The test
 * fails if MESSAGE_DOCS later gains an entry for either, so this cannot become a
 * second, competing description.
 */
export const SUMMARY_FALLBACKS: Record<string, string> = {
  AuthenticationKerberosV4: 'Asked the client to authenticate with Kerberos V4.',
  AuthenticationCryptPassword: 'Asked for a password hashed with `crypt(3)`.',
  AuthenticationKerberosV5: 'Asked the client to authenticate with Kerberos V5.',
  AuthenticationSCMCredential:
    'Asked the client to send its credentials over a Unix-domain socket, where the kernel vouches for them.',
}

/** Where a shipped capture contains a real instance of a message. */
export interface MessageExample {
  /** A scenario id, matching a capture in public/scenarios. */
  scenario: string
  /** Session id within that capture. */
  session: number
  /** Packet id within that session, 1-based. */
  packet: number
}

/**
 * One real instance of each message the shipped captures contain, so the index
 * can link a name to the bytes.
 *
 * Written out rather than computed, because computing it would mean fetching all
 * fourteen captures before the page could render. Every entry is checked against
 * the capture on disk by protocolIndex.test.ts, which is what stops it drifting
 * when a scenario is re-recorded and its packet ids move.
 *
 * Where more than one capture contains a message, the one chosen is the capture
 * that exists to show it.
 */
export const MESSAGE_EXAMPLES: Record<string, MessageExample> = {
  StartupMessage: { scenario: 'trust-auth', session: 1, packet: 3 },
  SSLRequest: { scenario: 'trust-auth', session: 1, packet: 1 },
  CancelRequest: { scenario: 'cancel-request', session: 2, packet: 1 },
  NegotiateProtocolVersion: { scenario: 'protocol-32-downgrade', session: 1, packet: 2 },

  AuthenticationOk: { scenario: 'trust-auth', session: 1, packet: 4 },
  AuthenticationCleartextPassword: { scenario: 'cleartext-auth', session: 1, packet: 4 },
  AuthenticationMD5Password: { scenario: 'md5-auth', session: 1, packet: 4 },
  AuthenticationSASL: { scenario: 'scram-auth', session: 1, packet: 4 },
  AuthenticationSASLContinue: { scenario: 'scram-auth', session: 1, packet: 6 },
  AuthenticationSASLFinal: { scenario: 'scram-auth', session: 1, packet: 8 },
  PasswordMessage: { scenario: 'cleartext-auth', session: 1, packet: 5 },
  SASLInitialResponse: { scenario: 'scram-auth', session: 1, packet: 5 },
  SASLResponse: { scenario: 'scram-auth', session: 1, packet: 7 },

  ParameterStatus: { scenario: 'trust-auth', session: 1, packet: 5 },
  BackendKeyData: { scenario: 'cancel-request', session: 1, packet: 19 },

  Query: { scenario: 'simple-query', session: 1, packet: 21 },
  RowDescription: { scenario: 'simple-query', session: 1, packet: 22 },
  DataRow: { scenario: 'simple-query', session: 1, packet: 23 },
  CommandComplete: { scenario: 'simple-query', session: 1, packet: 25 },
  ReadyForQuery: { scenario: 'simple-query', session: 1, packet: 20 },

  Parse: { scenario: 'extended-query', session: 1, packet: 19 },
  ParseComplete: { scenario: 'extended-query', session: 1, packet: 22 },
  Bind: { scenario: 'extended-query', session: 1, packet: 26 },
  BindComplete: { scenario: 'extended-query', session: 1, packet: 29 },
  Describe: { scenario: 'extended-query', session: 1, packet: 20 },
  ParameterDescription: { scenario: 'extended-query', session: 1, packet: 23 },
  Execute: { scenario: 'extended-query', session: 1, packet: 27 },
  Sync: { scenario: 'extended-query', session: 1, packet: 21 },

  CopyInResponse: { scenario: 'copy', session: 1, packet: 32 },
  CopyOutResponse: { scenario: 'copy', session: 1, packet: 36 },
  CopyBothResponse: { scenario: 'replication-physical', session: 1, packet: 30 },
  CopyData: { scenario: 'copy', session: 1, packet: 30 },
  CopyDone: { scenario: 'copy', session: 1, packet: 31 },

  ErrorResponse: { scenario: 'error-response', session: 1, packet: 22 },
  NotificationResponse: { scenario: 'notify', session: 1, packet: 22 },

  Terminate: { scenario: 'simple-query', session: 1, packet: 30 },
}

/** The route that opens a capture at one message. See App's hash handling. */
export function exampleRoute(example: MessageExample): string {
  return `${example.scenario}/${example.session}/${example.packet}`
}

/** Which releases document a message. */
export function versionsFor(message: ProtocolMessage): readonly string[] {
  return message.versions ?? VERSIONS
}

/** The version span as a label, such as "9.0 to 18" or "9.0 to 15". */
export function versionSpan(message: ProtocolMessage): string {
  const versions = versionsFor(message)
  const first = versions[0]
  const last = versions[versions.length - 1]
  return first === last ? `${first}` : `${first} to ${last}`
}

/** True where every one of VERSIONS documents the message. */
export function inEveryVersion(message: ProtocolMessage): boolean {
  return versionsFor(message).length === VERSIONS.length
}

/** The one-line summary shown for a message. Never empty. */
export function summaryFor(name: string): string {
  return MESSAGE_DOCS[name]?.summary ?? SUMMARY_FALLBACKS[name] ?? name
}

/** Where to read the specification's own entry, when there is one. */
export function docsUrlFor(message: ProtocolMessage): string | undefined {
  const versions = versionsFor(message)
  const newest = versions[versions.length - 1]
  // Still current, so link to current and stay fresh. Otherwise link the newest
  // release that still describes it, because current does not.
  if (newest === VERSIONS[VERSIONS.length - 1]) return docsUrlForTypeName(message.name)
  return docsUrlForTypeName(message.name, newest)
}

/** Whether this tool annotates the message rather than rendering it as Unknown. */
export function isDecoded(name: string): boolean {
  return !UNDECODED_MESSAGE_NAMES.includes(name)
}

/** A shipped capture containing a real instance, if one does. */
export function exampleFor(name: string): MessageExample | undefined {
  return MESSAGE_EXAMPLES[name]
}

