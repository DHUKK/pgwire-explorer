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
 * `/docs/current/` by default. It tracks whatever Postgres is newest, which is
 * right for a tool that decodes protocol 3.0 and 3.2 alike, at the cost of an
 * anchor that could one day be renamed upstream.
 *
 * A caller can ask for an older release instead, which the message index needs:
 * three of the messages it lists were removed from the docs years ago, so linking
 * them to `current` lands the reader on a page that no longer mentions them.
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
 * The oldest release whose message-formats page gives each message its own
 * anchor. Checked against the pages themselves: 15, 16, 17 and 18 have them, and
 * 14 and everything before it has none at all. So a link to an older release has
 * to be to the page rather than into it, or the reader lands on an anchor that
 * does not exist and sees the top of the page with no idea why.
 */
const FIRST_ANCHORED_RELEASE = 15

/**
 * Where to read about a message type, or undefined when there is nowhere to send
 * the reader.
 *
 * `release` names a documentation version such as "8.3", and defaults to the
 * current one. Pass it for a message the current docs no longer describe.
 *
 * `Unknown` is the only type with no destination, and it is ours rather than the
 * protocol's: it means the decoder could not identify the frame, so there is no
 * spec entry to link to.
 */
export function docsUrlForTypeName(typeName: string, release?: string): string | undefined {
  if (typeName === '' || typeName === 'Unknown') return undefined

  const base = release === undefined ? DOCS : `https://www.postgresql.org/docs/${release}`
  const flow = FLOW_SECTIONS[typeName]
  if (flow) return release === undefined ? flow : flow.replace(DOCS, base)

  const page = `${base}/protocol-message-formats.html`
  // parseFloat orders these correctly across the whole range, because 10 is
  // greater than 9.6 as a number even though it sorts before it as a string.
  const anchored = release === undefined || parseFloat(release) >= FIRST_ANCHORED_RELEASE
  return anchored ? `${page}#PROTOCOL-MESSAGE-FORMATS-${typeName.toUpperCase()}` : page
}
