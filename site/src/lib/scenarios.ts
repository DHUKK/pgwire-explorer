/**
 * The scenarios shipped with the site.
 *
 * Each `id` is a capture file in public/scenarios/<id>.json. All of them were
 * recorded against a real Postgres by scripts/generate-scenarios.sh, so what a
 * visitor reads here is what Postgres actually did.
 *
 * scenarios.test.ts checks this list against the files on disk in both
 * directions. A scenario cannot be listed without a capture, or shipped without
 * an explanation.
 */

import type { HighlightSpec } from './highlight'

export interface Scenario {
  /** Matches the capture filename, without .json. */
  id: string
  title: string
  /** One sentence: what this capture shows, not how it works. Shown on the card. */
  blurb: string
  /**
   * The message types this capture exists to show, named on its card.
   *
   * Kept short on purpose. This is what to look for in the list, not an
   * inventory: every capture also contains the startup preamble every other one
   * has. scenarios.test.ts checks each name against the capture on disk, so a
   * regenerated scenario that no longer contains its own subject cannot go on
   * advertising it.
   */
  teaches: string[]
  /**
   * The stretches this scenario exists to show, as inclusive packet-ID ranges
   * keyed by session ID. See HighlightSpec for why these are IDs.
   */
  highlight: HighlightSpec
  /** Grouping on the landing page. */
  group:
    | 'Connection setup'
    | 'Authentication'
    | 'Queries'
    | 'Bulk data'
    | 'Failure and control'
    | 'Replication'
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'protocol-32-downgrade',
    title: 'Protocol 3.2 downgraded',
    blurb:
      'A client asks for protocol 3.2 and an unrecognized `_pq_.` startup option, and `NegotiateProtocolVersion` downgrades the connection to 3.0 while reporting both.',
    teaches: ['StartupMessage', 'NegotiateProtocolVersion'],
    highlight: {
      // The StartupMessage and the server's NegotiateProtocolVersion reply.
      1: [[1, 2]],
    },
    group: 'Connection setup',
  },
  // The four authentication examples are listed weakest to strongest, so the
  // group reads as a progression and ends on the method to actually use. Every
  // other example is recorded under trust, which is why their preambles are as
  // short as trust-auth's.
  {
    id: 'trust-auth',
    title: 'Trust: no authentication',
    blurb:
      'The shortest handshake the protocol allows, with `AuthenticationOk` arriving straight after `StartupMessage` and no credential asked for.',
    teaches: ['StartupMessage', 'AuthenticationOk'],
    highlight: {
      // The handshake, which is the whole of it: a request and an acceptance
      // with nothing in between.
      1: [[3, 4]],
    },
    group: 'Authentication',
  },
  {
    id: 'cleartext-auth',
    title: 'Cleartext password authentication',
    blurb:
      'The `password` method, where `PasswordMessage` carries the password itself and it is readable in the hex dump.',
    teaches: ['AuthenticationCleartextPassword', 'PasswordMessage'],
    highlight: {
      // Request, password, accepted. The password in the recording is the
      // throwaway one from scripts/generate-scenarios.sh.
      1: [[4, 6]],
    },
    group: 'Authentication',
  },
  {
    id: 'md5-auth',
    title: 'MD5 authentication',
    blurb: 'The two-message MD5 exchange: `AuthenticationMD5Password`, `PasswordMessage`, then `AuthenticationOk`.',
    teaches: ['AuthenticationMD5Password', 'PasswordMessage'],
    highlight: {
      // Salt out, digest back, accepted.
      1: [[4, 6]],
    },
    group: 'Authentication',
  },
  {
    id: 'scram-auth',
    title: 'SCRAM-SHA-256 authentication',
    blurb: 'The SASL exchange, from `AuthenticationSASL` to `AuthenticationOk`, without the password appearing on the wire.',
    teaches: ['AuthenticationSASL', 'SASLInitialResponse', 'AuthenticationSASLFinal'],
    highlight: {
      // The SASL exchange, from the server's offer to AuthenticationOk.
      1: [[4, 9]],
    },
    group: 'Authentication',
  },
  {
    id: 'simple-query',
    title: 'The simple query protocol',
    blurb: 'A successful query cycle and a failed one, both run through the simple query protocol.',
    teaches: ['Query', 'RowDescription', 'DataRow', 'ReadyForQuery'],
    highlight: {
      1: [[21, 29]],
    },
    group: 'Queries',
  },
  {
    id: 'extended-query',
    title: 'The extended query protocol',
    blurb: 'The same query run twice through `Parse`, `Bind`, `Execute`, `Sync`, the second time without a `Parse`.',
    teaches: ['Parse', 'Bind', 'Execute', 'Sync'],
    highlight: {
      // Both passes, so the missing Parse in the second is visible.
      1: [[19, 39]],
    },
    group: 'Queries',
  },
  {
    id: 'copy-in',
    title: 'COPY: the bulk-loading sub-protocol',
    blurb: 'A `COPY FROM STDIN` bulk load, from `CopyInResponse` to `CommandComplete`.',
    teaches: ['CopyInResponse', 'CopyData', 'CopyDone'],
    highlight: {
      // The COPY episode only. Excludes the CREATE TABLE before it and the
      // read-back after, both of which also end in CommandComplete.
      1: [[29, 34]],
    },
    group: 'Bulk data',
  },
  {
    id: 'error-response',
    title: 'Errors',
    blurb:
      'A failed `Parse` that the server discards the rest of the batch after, then a failure inside a transaction that leaves `ReadyForQuery` reporting `Failed` until `ROLLBACK`.',
    teaches: ['ErrorResponse', 'Sync', 'ReadyForQuery'],
    highlight: {
      // The extended-protocol failure, where Describe never gets a reply,
      // then the whole transaction from BEGIN to ROLLBACK. The CREATE TEMP
      // TABLE and first INSERT between them are setup, deliberately outside
      // the transaction so the ROLLBACK leaves the row the second INSERT
      // collides with.
      1: [
        [19, 23],
        [30, 41],
      ],
    },
    group: 'Failure and control',
  },
  {
    id: 'cancel-request',
    title: 'Cancelling a running query',
    blurb: 'A running query cancelled from a second connection with `CancelRequest`.',
    teaches: ['CancelRequest', 'BackendKeyData', 'ErrorResponse'],
    highlight: {
      // The cancelled query and its 57014, then the cancel on its own session.
      1: [
        [21, 24],
        [19, 19],
      ],
      2: [[1, 1]],
    },
    group: 'Failure and control',
  },
  {
    id: 'notify',
    title: 'LISTEN / NOTIFY',
    blurb: 'A `LISTEN` registration, a `NOTIFY`, and the resulting `NotificationResponse`.',
    teaches: ['Query', 'NotificationResponse', 'CommandComplete'],
    highlight: {
      // LISTEN, then NOTIFY and the unsolicited NotificationResponse.
      1: [[19, 25]],
    },
    group: 'Failure and control',
  },
  {
    id: 'replication-physical',
    title: 'Physical replication',
    blurb:
      'A physical replication slot set up with `IDENTIFY_SYSTEM` and `CREATE_REPLICATION_SLOT`, then `START_REPLICATION` streaming an `INSERT` from a second connection back as `XLogData`.',
    teaches: ['CopyBothResponse', 'CopyData', 'CopyDone'],
    highlight: {
      // Session 1 is the replication connection: the slot setup and
      // START_REPLICATION, then the XLogData it delivers.
      1: [[24, 31]],
      // Session 2 is the ordinary connection making the single write session
      // 1's stream is showing.
      2: [[19, 21]],
    },
    group: 'Replication',
  },
  {
    id: 'replication-logical',
    title: 'Logical replication',
    blurb:
      'A `pgoutput` logical replication slot set up with `CREATE_REPLICATION_SLOT`, then `START_REPLICATION` streaming an `INSERT` from a second connection back as `XLogData`.',
    teaches: ['CopyBothResponse', 'CopyData', 'CopyDone'],
    highlight: {
      // Session 1 is the replication connection: the slot setup and
      // START_REPLICATION, then the XLogData it delivers.
      1: [
        [19, 25],
        [28, 31],
      ],
      // Session 2 is the ordinary connection making the single write session
      // 1's stream is showing.
      2: [[19, 21]],
    },
    group: 'Replication',
  },
]

export const SCENARIO_GROUPS = [
  'Authentication',
  'Queries',
  'Bulk data',
  'Connection setup',
  'Failure and control',
  'Replication',
] as const

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}

/**
 * URL of a scenario capture. Built from BASE_URL so the site works when served
 * from a subdirectory, which is how GitHub Pages project sites are hosted.
 */
export function scenarioUrl(id: string): string {
  return `${import.meta.env.BASE_URL}scenarios/${id}.json`
}
