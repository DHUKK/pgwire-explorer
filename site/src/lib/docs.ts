/**
 * Links from a decoded message to its entry in the official Postgres docs.
 *
 * This site deliberately explains each message in one sentence and stops there.
 * The full field list, the exact widths and the flow rules belong to the spec,
 * which is well written and maintained by the people who own the protocol.
 * Restating it here would only add something to go stale, so every message
 * offers a way out to the real thing instead.
 *
 * The docs give every message in the message-formats page an anchor built from
 * its own name, uppercased, so almost all of this is mechanical rather than a
 * hand-maintained table that could rot. Checked against the live page: of the 52
 * message types this site documents, 49 match that pattern exactly, and the
 * three that do not are handled below.
 *
 * `/docs/current/` on purpose. It tracks whatever Postgres is newest, which is
 * right for a tool that decodes protocol 3.0 and 3.2 alike, at the cost of an
 * anchor that could one day be renamed upstream.
 */

const DOCS = 'https://www.postgresql.org/docs/current'

/**
 * The protocol chapter itself, for a reader who wants the whole thing rather than
 * one message. Linked from the landing page, because "read the spec" is a
 * reasonable first move and this site should say where it is.
 */
export const PROTOCOL_DOCS_URL = `${DOCS}/protocol.html`

/**
 * The two replies that are not messages, and so have no message-formats entry.
 *
 * `SSLResponse` and `GSSENCResponse` are a single byte each, with no type tag and
 * no length, which is exactly why they are absent from a page about message
 * formats. The flow page is where their behaviour is actually described, so they
 * point there rather than nowhere.
 */
const FLOW_SECTIONS: Record<string, string> = {
  SSLResponse: `${DOCS}/protocol-flow.html#PROTOCOL-FLOW-SSL`,
  GSSENCResponse: `${DOCS}/protocol-flow.html#PROTOCOL-FLOW-GSSAPI`,
}

/**
 * Where to read about a message type, or undefined when there is nowhere to send
 * the reader.
 *
 * `Unknown` is the only type with no destination, and it is ours rather than the
 * protocol's: it means the decoder could not identify the frame, so there is no
 * spec entry to link to.
 */
export function docsUrlForTypeName(typeName: string): string | undefined {
  if (typeName === '' || typeName === 'Unknown') return undefined
  const flow = FLOW_SECTIONS[typeName]
  if (flow) return flow
  return `${DOCS}/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-${typeName.toUpperCase()}`
}
