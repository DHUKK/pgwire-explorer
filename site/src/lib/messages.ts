/**
 * Human-readable description of what each protocol message does.
 *
 * The decoder already knows a packet is `ReadyForQuery` and which bytes are
 * which. This file supplies the plain-English label: the server is ready to
 * accept a new query. This is a protocol explorer, not a tutorial, so entries
 * stay to one sentence unless something genuinely needs a second, and skip the
 * wire format and the mechanism wherever the summary alone answers "what is
 * this message doing".
 *
 * Text is marked up with backticks for anything that is literally code: message
 * names, byte values, wire numbers. See renderInline.
 *
 * Keyed by the pgproto3 type name the Go decoder emits (`type_name`). A message
 * with no entry still renders, just without commentary, and the coverage test in
 * scenarios.test.ts keeps that from happening by accident.
 */

export type MessageCategory =
  | 'negotiation'
  | 'auth'
  | 'startup'
  | 'query'
  | 'result'
  | 'copy'
  | 'control'
  | 'error'
  | 'async'
  | 'unknown'

export interface MessageDoc {
  /** Who sends it. */
  sender: 'frontend' | 'backend' | 'either'
  category: MessageCategory
  /** What this message does. One sentence, shown as the headline. */
  summary: string
  /** Extra context, only when the summary alone is not enough. Omit rather than pad. */
  detail?: string
}

export const CATEGORY_LABELS: Record<MessageCategory, string> = {
  negotiation: 'Connection negotiation',
  auth: 'Authentication',
  startup: 'Startup',
  query: 'Query',
  result: 'Result',
  copy: 'COPY',
  control: 'Flow control',
  error: 'Error / notice',
  async: 'Asynchronous',
  unknown: 'Unrecognized',
}

export const MESSAGE_DOCS: Record<string, MessageDoc> = {
  // ---------------------------------------------------------------- negotiation
  SSLRequest: {
    sender: 'frontend',
    category: 'negotiation',
    summary: 'Asks the server to upgrade the connection to `TLS`.',
  },
  SSLResponse: {
    sender: 'backend',
    category: 'negotiation',
    summary: "The server's answer to `SSLRequest`: `S` to accept, `N` to refuse.",
    detail: 'Not a typed message: no type byte or length, just the reply byte.',
  },
  GSSENCRequest: {
    sender: 'frontend',
    category: 'negotiation',
    summary: 'Asks the server to upgrade the connection to `GSSAPI` encryption.',
  },
  GSSENCResponse: {
    sender: 'backend',
    category: 'negotiation',
    summary: "The server's answer to `GSSENCRequest`: `G` to accept, `N` to refuse.",
  },
  StartupMessage: {
    sender: 'frontend',
    category: 'startup',
    summary: 'Opens a session, carrying the protocol version and connection parameters.',
  },
  CancelRequest: {
    sender: 'frontend',
    category: 'control',
    summary: 'Sent on a separate connection to cancel a query already in progress.',
  },
  NegotiateProtocolVersion: {
    sender: 'backend',
    category: 'negotiation',
    summary: "Tells the client the server doesn't support part of what it asked for at startup.",
  },

  // ----------------------------------------------------------------------- auth
  AuthenticationOk: {
    sender: 'backend',
    category: 'auth',
    summary: 'Authentication succeeded.',
  },
  AuthenticationCleartextPassword: {
    sender: 'backend',
    category: 'auth',
    summary: 'Asks the client to send its password in plain text.',
  },
  AuthenticationMD5Password: {
    sender: 'backend',
    category: 'auth',
    summary: 'Asks the client for an MD5-hashed, salted password.',
    detail: 'Deprecated in favor of SCRAM.',
  },
  AuthenticationSASL: {
    sender: 'backend',
    category: 'auth',
    summary: 'Starts `SASL` authentication and lists the mechanisms the server supports.',
  },
  SASLInitialResponse: {
    sender: 'frontend',
    category: 'auth',
    summary: "The client's first `SASL` message, picking a mechanism.",
    detail: 'Shares type byte `p` with `PasswordMessage`, `SASLResponse` and `GSSResponse`.',
  },
  AuthenticationSASLContinue: {
    sender: 'backend',
    category: 'auth',
    summary: 'A `SASL` challenge from the server.',
  },
  SASLResponse: {
    sender: 'frontend',
    category: 'auth',
    summary: "The client's reply to a `SASL` challenge.",
    detail: 'Shares type byte `p` with `PasswordMessage`, `SASLInitialResponse` and `GSSResponse`.',
  },
  AuthenticationSASLFinal: {
    sender: 'backend',
    category: 'auth',
    summary: "The server's final `SASL` message, confirming the exchange.",
  },
  PasswordMessage: {
    sender: 'frontend',
    category: 'auth',
    summary: "The client's password, in whatever form the server asked for.",
    detail: 'Shares type byte `p` with `SASLInitialResponse`, `SASLResponse` and `GSSResponse`.',
  },
  AuthenticationGSS: {
    sender: 'backend',
    category: 'auth',
    summary: 'Asks for `GSSAPI` authentication.',
  },
  AuthenticationGSSContinue: {
    sender: 'backend',
    category: 'auth',
    summary: 'A round of `GSSAPI` token exchange.',
  },
  AuthenticationSSPI: {
    sender: 'backend',
    category: 'auth',
    summary: 'Asks for `SSPI` authentication, which is Windows negotiating Kerberos or NTLM.',
    detail: 'The client answers with `GSSResponse`, the same message `GSSAPI` uses.',
  },
  GSSResponse: {
    sender: 'frontend',
    category: 'auth',
    summary: 'A `GSSAPI` token from the client.',
    detail: 'Shares type byte `p` with `PasswordMessage`, `SASLInitialResponse` and `SASLResponse`.',
  },

  // -------------------------------------------------------------------- startup
  ParameterStatus: {
    sender: 'backend',
    category: 'startup',
    summary: 'Reports a server setting, as a name and a value.',
  },
  BackendKeyData: {
    sender: 'backend',
    category: 'startup',
    summary: 'The process `ID` and secret key used to cancel queries on this connection.',
  },
  ReadyForQuery: {
    sender: 'backend',
    category: 'control',
    summary: 'The server is ready for a new command, and carries the transaction status.',
  },

  // ---------------------------------------------------------------------- query
  Query: {
    sender: 'frontend',
    category: 'query',
    summary: 'Runs a `SQL` string immediately, without prepared parameters.',
  },
  Parse: {
    sender: 'frontend',
    category: 'query',
    summary: 'Parses a `SQL` statement, creating a prepared statement.',
  },
  Bind: {
    sender: 'frontend',
    category: 'query',
    summary: 'Supplies parameter values for a prepared statement, creating a portal.',
    detail: 'Planning happens here, not at `Parse`.',
  },
  Describe: {
    sender: 'frontend',
    category: 'query',
    summary: 'Asks for the parameter or row types of a prepared statement or portal.',
  },
  Execute: {
    sender: 'frontend',
    category: 'query',
    summary: 'Runs a portal and returns its rows.',
  },
  Close: {
    sender: 'frontend',
    category: 'query',
    summary: 'Closes a prepared statement or portal.',
  },
  Sync: {
    sender: 'frontend',
    category: 'control',
    summary: 'Ends a batch of extended-query messages and asks for a `ReadyForQuery`.',
  },
  Flush: {
    sender: 'frontend',
    category: 'control',
    summary: 'Asks the server to send buffered results without ending the batch.',
  },
  Terminate: {
    sender: 'frontend',
    category: 'control',
    summary: 'Closes the connection.',
  },
  FunctionCall: {
    sender: 'frontend',
    category: 'query',
    summary: 'Calls a server-side function directly by `OID`, bypassing `SQL`.',
    detail: 'A legacy path. `Bind` and `Execute` against a `SELECT` do the same thing.',
  },

  // --------------------------------------------------------------------- result
  ParseComplete: {
    sender: 'backend',
    category: 'result',
    summary: 'Confirms the `Parse` succeeded.',
  },
  BindComplete: {
    sender: 'backend',
    category: 'result',
    summary: 'Confirms the `Bind` succeeded.',
  },
  CloseComplete: {
    sender: 'backend',
    category: 'result',
    summary: 'Confirms the `Close` succeeded.',
  },
  ParameterDescription: {
    sender: 'backend',
    category: 'result',
    summary: 'Lists the parameter types a prepared statement expects.',
  },
  RowDescription: {
    sender: 'backend',
    category: 'result',
    summary: 'Describes the columns of the rows about to be returned.',
  },
  DataRow: {
    sender: 'backend',
    category: 'result',
    summary: 'One row of query results.',
  },
  CommandComplete: {
    sender: 'backend',
    category: 'result',
    summary: 'Reports that a command finished, with a tag describing what it did.',
  },
  EmptyQueryResponse: {
    sender: 'backend',
    category: 'result',
    summary: 'Sent instead of `CommandComplete` when the query string was empty.',
  },
  NoData: {
    sender: 'backend',
    category: 'result',
    summary: 'Sent instead of `RowDescription` when the statement or portal returns no rows.',
  },
  PortalSuspended: {
    sender: 'backend',
    category: 'result',
    summary: 'Reports that a portal paused after reaching its row limit.',
    detail: 'The next `Execute` on the same portal resumes it.',
  },
  FunctionCallResponse: {
    sender: 'backend',
    category: 'result',
    summary: 'The result of a `FunctionCall`.',
  },

  // ----------------------------------------------------------------------- copy
  CopyInResponse: {
    sender: 'backend',
    category: 'copy',
    summary: 'The server is ready to receive `COPY` data.',
    detail: 'The connection switches to copy-in mode.',
  },
  CopyOutResponse: {
    sender: 'backend',
    category: 'copy',
    summary: 'The server is about to stream `COPY` data out.',
    detail: 'The connection switches to copy-out mode.',
  },
  CopyBothResponse: {
    sender: 'backend',
    category: 'copy',
    summary: 'The connection streams `COPY` data in both directions.',
    detail: 'Sent only when the backend starts streaming replication.',
  },
  CopyData: {
    sender: 'either',
    category: 'copy',
    summary: 'A chunk of `COPY` data.',
    detail: 'When used for replication this wraps `XLogData`, a `Primary keepalive message`, a `Standby status update`, or a `Hot standby feedback message` instead of a plain `COPY`.',
  },
  CopyDone: {
    sender: 'either',
    category: 'copy',
    summary: 'The `COPY` stream ended normally.',
  },
  CopyFail: {
    sender: 'frontend',
    category: 'copy',
    summary: 'The client is abandoning a `COPY`, with a reason.',
  },

  // ---------------------------------------------------------------------- error
  ErrorResponse: {
    sender: 'backend',
    category: 'error',
    summary: 'Reports that a command failed, with an error code and message.',
  },
  NoticeResponse: {
    sender: 'backend',
    category: 'error',
    summary: 'An informational message from the server, not a failure.',
  },

  // ---------------------------------------------------------------------- async
  NotificationResponse: {
    sender: 'backend',
    category: 'async',
    summary: 'A `LISTEN`/`NOTIFY` event pushed from the server, unprompted by a client message.',
  },

  // -------------------------------------------------------------------- unknown
  Unknown: {
    sender: 'either',
    category: 'unknown',
    summary: 'The decoder could not identify this message type.',
  },
}

/**
 * Docs for a packet's type name. Anything with no entry falls back to showing
 * just the name, which the coverage test in scenarios.test.ts forbids for message
 * types that appear in the shipped captures.
 */
export function docForTypeName(typeName: string): MessageDoc {
  return (
    MESSAGE_DOCS[typeName] ?? {
      sender: 'either',
      category: 'unknown',
      summary: typeName,
    }
  )
}

/** Every type name that has real prose, for the coverage test. */
export function documentedTypeNames(): string[] {
  return Object.keys(MESSAGE_DOCS)
}
