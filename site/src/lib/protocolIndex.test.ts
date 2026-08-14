import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MESSAGE_EXAMPLES,
  PHASES,
  PHASE_LABELS,
  PROTOCOL_MESSAGES,
  SUMMARY_FALLBACKS,
  UNDECODED_MESSAGE_NAMES,
  VERSIONS,
  exampleRoute,
  docsUrlFor,
  inEveryVersion,
  isDecoded,
  summaryFor,
  versionSpan,
  versionsFor,
} from './protocolIndex'
import { MESSAGE_DOCS } from './messages'
import { validateCapture } from './capture'
import { SCENARIOS, scenarioById } from './scenarios'

const SCENARIO_DIR = join(import.meta.dirname, '../../public/scenarios')
const COVERAGE_TEST = join(import.meta.dirname, '../../../internal/pgproto/coverage_test.go')

/**
 * The names in the `documentedMessages` slice of internal/pgproto/coverage_test.go.
 *
 * Read as text rather than imported, obviously, and only from that one slice: the
 * same file holds three other lists of message names. A typo in this index is
 * invisible on screen and wrong forever, so the strongest check available is
 * against the one list in the repo that was extracted from the specification
 * rather than typed out.
 */
function goDocumentedMessages(): string[] {
  const source = readFileSync(COVERAGE_TEST, 'utf8')
  const start = source.indexOf('var documentedMessages = []string{')
  if (start === -1) {
    throw new Error(
      'documentedMessages not found in coverage_test.go. If the slice was renamed, ' +
        'update this test rather than deleting it.',
    )
  }
  const end = source.indexOf('\n}', start)
  if (end === -1) throw new Error('documentedMessages is not closed in coverage_test.go')
  const body = source.slice(start, end)
  return [...body.matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]!)
}

/** The keys of the `unhandledMessages` map in the same file. */
function goUnhandledMessages(): string[] {
  const source = readFileSync(COVERAGE_TEST, 'utf8')
  const start = source.indexOf('var unhandledMessages = map[string]string{')
  if (start === -1) {
    throw new Error(
      'unhandledMessages not found in coverage_test.go. If the map was renamed, ' +
        'update this test rather than deleting it.',
    )
  }
  const end = source.indexOf('\n}', start)
  if (end === -1) throw new Error('unhandledMessages is not closed in coverage_test.go')
  // Keys only. The reasons are Go strings with escaped quotes in them, and the
  // wording the site shows is its own.
  return [...source.slice(start, end).matchAll(/^\t"([A-Za-z0-9]+)":/gm)].map((m) => m[1]!)
}

describe('the Go lists this index is checked against', () => {
  // Guards the guard. Both extractors work on text, so a restructured Go file
  // could leave them returning nothing and every comparison below passing
  // vacuously.
  it('finds all 55 documented message names', () => {
    const names = goDocumentedMessages()
    expect(names.length, 'documentedMessages parsed out of coverage_test.go').toBe(55)
    expect(names).toContain('StartupMessage')
    expect(names).toContain('Terminate')
  })

  it('finds the four deliberately undecoded names', () => {
    expect(goUnhandledMessages().sort()).toEqual([
      'AuthenticationCryptPassword',
      'AuthenticationKerberosV4',
      'AuthenticationKerberosV5',
      'AuthenticationSCMCredential',
    ])
  })

  // Only that one slice, not every quoted string in the file. If the extractor
  // widened to the whole file it would pick up SSLResponse, GSSENCResponse and
  // AuthenticationSSPI from the surrounding lists and prose.
  it('reads only the documentedMessages slice', () => {
    expect(goDocumentedMessages()).not.toContain('SSLResponse')
  })
})

describe('protocol message index', () => {
  it('covers exactly the messages the Go decoder documents', () => {
    const ours = PROTOCOL_MESSAGES.map((m) => m.name).sort()
    expect(ours).toEqual(goDocumentedMessages().sort())
  })

  // Ten of the 53 arrived or departed inside the range. That is the most
  // interesting thing the index says, so it is pinned by name: a span quietly
  // widening to the whole range would otherwise claim SCRAM existed in 9.0.
  it('has 55 messages, fifteen of which do not span the whole range', () => {
    expect(PROTOCOL_MESSAGES.length).toBe(55)
    const partial = PROTOCOL_MESSAGES.filter((m) => !inEveryVersion(m)).map((m) => m.name)
    expect(partial.sort()).toEqual([
      'AuthenticationCryptPassword',
      'AuthenticationGSS',
      'AuthenticationGSSContinue',
      'AuthenticationKerberosV4',
      'AuthenticationSASL',
      'AuthenticationSASLContinue',
      'AuthenticationSASLFinal',
      'AuthenticationSCMCredential',
      'AuthenticationSSPI',
      'CopyBothResponse',
      'GSSENCRequest',
      'GSSResponse',
      'NegotiateProtocolVersion',
      'SASLInitialResponse',
      'SASLResponse',
    ])
  })

  it('spans the versions the docs give', () => {
    const byName = new Map(PROTOCOL_MESSAGES.map((m) => [m.name, m]))
    // Arrivals: GSSAPI in 8.3, CopyBothResponse in 9.1, NegotiateProtocolVersion
    // in 9.3, SCRAM in 10, GSSAPI encryption in 12. Departures: Kerberos V4 after
    // 8.0, crypt after 8.3, SCM credential after 15.
    expect(versionSpan(byName.get('AuthenticationKerberosV4')!)).toBe('7.4 to 8.0')
    expect(versionSpan(byName.get('AuthenticationCryptPassword')!)).toBe('7.4 to 8.3')
    expect(versionSpan(byName.get('AuthenticationGSS')!)).toBe('8.3 to 18')
    expect(versionSpan(byName.get('AuthenticationSASL')!)).toBe('10 to 18')
    expect(versionSpan(byName.get('AuthenticationSCMCredential')!)).toBe('7.4 to 15')
    expect(versionSpan(byName.get('CopyBothResponse')!)).toBe('9.1 to 18')
    expect(versionSpan(byName.get('GSSENCRequest')!)).toBe('12 to 18')
    expect(versionSpan(byName.get('NegotiateProtocolVersion')!)).toBe('9.3 to 18')
    expect(versionSpan(byName.get('Query')!)).toBe('7.4 to 18')
  })

  // Compared by position in VERSIONS rather than by arithmetic, because the
  // releases are not numbers: 9.6 is followed by 10.
  it('lists versions as a contiguous run inside the range this index covers', () => {
    for (const message of PROTOCOL_MESSAGES) {
      const versions = versionsFor(message)
      expect(versions.length, `${message.name} has no versions`).toBeGreaterThan(0)
      versions.forEach((version, i) => {
        const at = VERSIONS.indexOf(version as (typeof VERSIONS)[number])
        expect(at, `${message.name} claims version ${version}`).toBeGreaterThanOrEqual(0)
        if (i > 0) {
          const previous = VERSIONS.indexOf(versions[i - 1] as (typeof VERSIONS)[number])
          expect(at, `${message.name} skips a release after ${versions[i - 1]}`).toBe(previous + 1)
        }
      })
    }
  })

  it('uses unique names', () => {
    const names = PROTOCOL_MESSAGES.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every message a phase this page can render', () => {
    for (const message of PROTOCOL_MESSAGES) {
      expect(PHASES, `${message.name} has an unknown phase`).toContain(message.phase)
    }
  })

  it('leaves no phase empty', () => {
    for (const phase of PHASES) {
      expect(
        PROTOCOL_MESSAGES.filter((m) => m.phase === phase).length,
        `${phase} has no messages, so its heading would render alone`,
      ).toBeGreaterThan(0)
      expect(PHASE_LABELS[phase]).toBeTruthy()
    }
  })

  it('gives every message a one-line summary', () => {
    for (const message of PROTOCOL_MESSAGES) {
      const summary = summaryFor(message.name)
      expect(summary.length, `${message.name} has no summary`).toBeGreaterThan(10)
      expect(summary, `${message.name} falls back to its own name`).not.toBe(message.name)
    }
  })

  // The fallbacks exist only because MESSAGE_DOCS covers what a capture can
  // contain. If a message gains a real entry there, the fallback becomes a second
  // description of the same thing and has to go.
  it('falls back only where MESSAGE_DOCS has no entry', () => {
    for (const name of Object.keys(SUMMARY_FALLBACKS)) {
      expect(MESSAGE_DOCS[name], `${name} is in MESSAGE_DOCS, so drop its fallback`).toBeUndefined()
    }
  })

  it('uses only type bytes that are a single character', () => {
    for (const message of PROTOCOL_MESSAGES) {
      if (message.typeByte === undefined) continue
      expect(message.typeByte.length, `${message.name} has a multi-byte tag`).toBe(1)
    }
  })

  // The untagged messages are exactly the four that open a connection, and each
  // is identified by its request code instead.
  it('gives the untagged messages a code and nothing else one', () => {
    const untagged = PROTOCOL_MESSAGES.filter((m) => m.typeByte === undefined)
    expect(untagged.map((m) => m.name)).toEqual([
      'StartupMessage',
      'SSLRequest',
      'GSSENCRequest',
      'CancelRequest',
    ])
    for (const message of untagged) {
      expect(message.code, `${message.name} has no code`).toBeDefined()
    }
    for (const message of PROTOCOL_MESSAGES) {
      if (message.code === undefined) continue
      expect(
        message.typeByte === undefined || message.typeByte === 'R',
        `${message.name} has a code but is neither untagged nor tag R`,
      ).toBe(true)
    }
  })

  it('transcribes the startup request codes', () => {
    const codes = Object.fromEntries(PROTOCOL_MESSAGES.map((m) => [m.name, m.code]))
    expect(codes.StartupMessage).toBe(196608)
    expect(codes.SSLRequest).toBe(80877103)
    expect(codes.GSSENCRequest).toBe(80877104)
    expect(codes.CancelRequest).toBe(80877102)
  })

  // Every authentication code the specification gives, in one assertion, because
  // a wrong digit here is invisible on the page.
  it('transcribes the authentication codes', () => {
    const auth = PROTOCOL_MESSAGES.filter((m) => m.typeByte === 'R')
    expect(Object.fromEntries(auth.map((m) => [m.name, m.code]))).toEqual({
      AuthenticationOk: 0,
      AuthenticationKerberosV4: 1,
      AuthenticationKerberosV5: 2,
      AuthenticationCleartextPassword: 3,
      AuthenticationCryptPassword: 4,
      AuthenticationMD5Password: 5,
      AuthenticationSCMCredential: 6,
      AuthenticationGSS: 7,
      AuthenticationGSSContinue: 8,
      AuthenticationSSPI: 9,
      AuthenticationSASL: 10,
      AuthenticationSASLContinue: 11,
      AuthenticationSASLFinal: 12,
    })
  })
})

describe('deliberately undecoded messages', () => {
  // Kept in step with the Go map by name. The Go side owns which messages are
  // decoded, and duplicating its reasons as prose is what this test prevents from
  // rotting.
  it('names the same messages the Go decoder skips', () => {
    expect([...UNDECODED_MESSAGE_NAMES].sort()).toEqual(goUnhandledMessages().sort())
  })

  // Names and nothing else. The reasons live in the Go map, so there is no second
  // copy here to drift from it.
  it('marks every one of them and nothing else', () => {
    for (const message of PROTOCOL_MESSAGES) {
      expect(isDecoded(message.name), `${message.name}`).toBe(
        !UNDECODED_MESSAGE_NAMES.includes(message.name),
      )
    }
  })
})


describe('example messages', () => {
  const captures = new Map(
    SCENARIOS.map((scenario) => [
      scenario.id,
      validateCapture(
        JSON.parse(readFileSync(join(SCENARIO_DIR, `${scenario.id}.json`), 'utf8')),
      ),
    ]),
  )

  // The whole reason the examples are written out rather than computed. A
  // re-recorded scenario moves its packet ids, and without this the index would
  // go on linking to whatever now sits at that position.
  it('points at a packet that exists and really is that message', () => {
    for (const [name, example] of Object.entries(MESSAGE_EXAMPLES)) {
      expect(scenarioById(example.scenario), `${name} names an unknown scenario`).toBeDefined()
      const capture = captures.get(example.scenario)!
      const session = capture.sessions.find((s) => s.id === example.session)
      expect(session, `${name} names session ${example.session}, which does not exist`).toBeDefined()
      const packet = session!.packets.find((p) => p.id === example.packet)
      expect(packet, `${name} names packet ${example.packet}, which does not exist`).toBeDefined()
      expect(packet!.type_name, `${name} example is not a ${name}`).toBe(name)
    }
  })

  it('only names messages this index lists', () => {
    const known = new Set(PROTOCOL_MESSAGES.map((m) => m.name))
    const unknown = Object.keys(MESSAGE_EXAMPLES).filter((name) => !known.has(name))
    expect(unknown, 'examples for messages not in the index').toEqual([])
  })

  // The reverse direction. A message the captures do contain but the map omits is
  // a link the page could have offered and did not.
  it('has an example for every message the shipped captures contain', () => {
    const present = new Set<string>()
    for (const capture of captures.values()) {
      for (const session of capture.sessions) {
        for (const packet of session.packets) present.add(packet.type_name)
      }
    }
    const known = new Set(PROTOCOL_MESSAGES.map((m) => m.name))
    const missing = [...present].filter((name) => known.has(name) && !(name in MESSAGE_EXAMPLES))
    expect(missing.sort(), 'messages in a capture with no example').toEqual([])
  })

  it('builds a route the hash router understands', () => {
    expect(exampleRoute({ scenario: 'simple-query', session: 1, packet: 21 })).toBe(
      'simple-query/1/21',
    )
  })
})

describe('documentation links follow the release', () => {
  const byName = new Map(PROTOCOL_MESSAGES.map((m) => [m.name, m]))

  // A message the current docs still describe links to current, so the link stays
  // right as Postgres moves on.
  it('links a current message to current, with its anchor', () => {
    const url = docsUrlFor(byName.get('Query')!)
    expect(url).toBe(
      'https://www.postgresql.org/docs/current/protocol-message-formats.html' +
        '#PROTOCOL-MESSAGE-FORMATS-QUERY',
    )
  })

  // The three removed messages are the reason this exists. Linking them to
  // current would land the reader on a page that no longer mentions them.
  it('links a removed message to the last release that described it', () => {
    expect(docsUrlFor(byName.get('AuthenticationSCMCredential')!)).toBe(
      'https://www.postgresql.org/docs/15/protocol-message-formats.html' +
        '#PROTOCOL-MESSAGE-FORMATS-AUTHENTICATIONSCMCREDENTIAL',
    )
  })

  // Before 15 the pages have no per-message anchors at all, so an anchor would
  // drop the reader at the top of the page with no explanation.
  it('omits the anchor for releases that never had one', () => {
    expect(docsUrlFor(byName.get('AuthenticationKerberosV4')!)).toBe(
      'https://www.postgresql.org/docs/8.0/protocol-message-formats.html',
    )
    expect(docsUrlFor(byName.get('AuthenticationCryptPassword')!)).toBe(
      'https://www.postgresql.org/docs/8.3/protocol-message-formats.html',
    )
  })

  it('gives every message somewhere to go', () => {
    for (const message of PROTOCOL_MESSAGES) {
      expect(docsUrlFor(message), `${message.name} has no docs link`).toBeTruthy()
    }
  })
})

describe('the release filter', () => {
  const documenting = (release: string) =>
    PROTOCOL_MESSAGES.filter((m) => versionsFor(m).includes(release as never)).map((m) => m.name)

  // The counts come from the same pages the index was transcribed from, so this
  // fails if a span is widened or narrowed by mistake.
  it('matches what each release documented', () => {
    expect(documenting('7.4')).toHaveLength(43)
    expect(documenting('18')).toHaveLength(52)
  })

  it('keeps a release-specific message out of every other release', () => {
    expect(documenting('8.0')).toContain('AuthenticationKerberosV4')
    expect(documenting('8.1')).not.toContain('AuthenticationKerberosV4')
    expect(documenting('9.6')).not.toContain('AuthenticationSASL')
    expect(documenting('10')).toContain('AuthenticationSASL')
  })
})
