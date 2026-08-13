import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SCENARIOS, SCENARIO_GROUPS, scenarioById } from './scenarios'
import { validateCapture } from './capture'
import { docForTypeName, documentedTypeNames } from './messages'

const SCENARIO_DIR = join(import.meta.dirname, '../../public/scenarios')

function captureFiles(): string[] {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
}

describe('scenario manifest', () => {
  // The manifest is prose and the captures are generated separately, so they can
  // drift in either direction: a listed scenario whose file was never generated
  // becomes a card that 404s, and a generated capture nobody listed is simply
  // invisible. Both are checked.
  it('lists every capture file that exists', () => {
    const listed = new Set(SCENARIOS.map((s) => s.id))
    const missing = captureFiles().filter((id) => !listed.has(id))
    expect(missing, 'captures with no entry in SCENARIOS').toEqual([])
  })

  it('has a capture file for every listed scenario', () => {
    const onDisk = new Set(captureFiles())
    const missing = SCENARIOS.filter((s) => !onDisk.has(s.id)).map((s) => s.id)
    expect(missing, 'scenarios with no capture (run scripts/generate-scenarios.sh)').toEqual([])
  })

  it('uses unique ids', () => {
    const ids = SCENARIOS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only uses declared groups', () => {
    for (const scenario of SCENARIOS) {
      expect(SCENARIO_GROUPS).toContain(scenario.group)
    }
  })

  // The highlight ranges are packet IDs in one specific recording, so
  // regenerating the scenarios can move them. These are the message types each
  // boundary was chosen for. If a range drifts, this fails instead of the UI
  // quietly marking the wrong messages.
  const expectedBoundaries: Record<string, Record<number, Array<[string, string]>>> = {
    'scram-auth': { 1: [['AuthenticationSASL', 'AuthenticationOk']] },
    'md5-auth': { 1: [['AuthenticationMD5Password', 'AuthenticationOk']] },
    'cleartext-auth': { 1: [['AuthenticationCleartextPassword', 'AuthenticationOk']] },
    // Nothing between the two, which is the whole point of the example.
    'trust-auth': { 1: [['StartupMessage', 'AuthenticationOk']] },
    'simple-query': { 1: [['Query', 'ReadyForQuery']] },
    'extended-query': { 1: [['Parse', 'ReadyForQuery']] },
    'copy': { 1: [['Query', 'ReadyForQuery']] },
    'error-response': {
      // The failed Parse and the ReadyForQuery its Sync produced, then BEGIN
      // through the ReadyForQuery that reports Idle again after ROLLBACK.
      1: [
        ['Parse', 'ReadyForQuery'],
        ['Query', 'ReadyForQuery'],
      ],
    },
    'cancel-request': {
      // Two ranges, in the order scenarios.ts declares them: the query that gets
      // cancelled, then the BackendKeyData carrying the PID and secret key that
      // the CancelRequest on session 2 has to quote back.
      1: [
        ['Query', 'ReadyForQuery'],
        ['BackendKeyData', 'BackendKeyData'],
      ],
      2: [['CancelRequest', 'CancelRequest']],
    },
    'notify': {
      // The listeners end on the notification itself, which is the message that
      // arrives with nothing of theirs in flight. The notifier's own range ends
      // on the ReadyForQuery for its NOTIFY.
      1: [['Query', 'NotificationResponse']],
      2: [['Query', 'NotificationResponse']],
      3: [['Query', 'ReadyForQuery']],
    },
    'replication-physical': {
      1: [['Query', 'CopyData']],
      2: [['Query', 'ReadyForQuery']],
    },
    'replication-logical': {
      1: [
        ['Query', 'CopyBothResponse'],
        ['CopyData', 'CopyData'],
      ],
      2: [['Query', 'ReadyForQuery']],
    },
    'protocol-32-downgrade': { 1: [['StartupMessage', 'NegotiateProtocolVersion']] },
  }

  it('highlights ranges whose boundaries still land on the intended messages', () => {
    for (const scenario of SCENARIOS) {
      const capture = validateCapture(
        JSON.parse(readFileSync(join(SCENARIO_DIR, `${scenario.id}.json`), 'utf8')),
      )
      const want = expectedBoundaries[scenario.id]
      expect(want, `${scenario.id} has no expected boundaries`).toBeDefined()

      for (const [sessionId, declared] of Object.entries(scenario.highlight)) {
        const session = capture.sessions.find((s) => s.id === Number(sessionId))
        expect(session, `${scenario.id} highlights session ${sessionId}, which does not exist`)
          .toBeDefined()

        const wantSession = want![Number(sessionId)]
        expect(wantSession?.length, `${scenario.id} session ${sessionId}`).toBe(declared.length)

        declared.forEach(([from, to], i) => {
          expect(from, `${scenario.id} range ${i} starts below 1`).toBeGreaterThanOrEqual(1)
          expect(to, `${scenario.id} range ${i} is inverted`).toBeGreaterThanOrEqual(from)
          expect(to, `${scenario.id} range ${i} runs past the session`)
            .toBeLessThanOrEqual(session!.packets.length)

          const [wantFrom, wantTo] = wantSession![i]!
          expect(session!.packets[from - 1]!.type_name, `${scenario.id} range ${i} start`).toBe(wantFrom)
          expect(session!.packets[to - 1]!.type_name, `${scenario.id} range ${i} end`).toBe(wantTo)
        })
      }
    }
  })

  // The blurb is the only prose for a scenario, so a stub would leave it unlabeled.
  it('gives every scenario a blurb', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.blurb.length, `${scenario.id} has no blurb`).toBeGreaterThan(20)
    }
  })

  // The card advertises these message types by name, so a capture that stopped
  // containing one would have the landing page promising something the message
  // list does not deliver. Regenerating the scenarios is what could cause that,
  // which is the same reason the highlight boundaries are checked above.
  it('names only message types its capture actually contains', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.teaches.length, `${scenario.id} names no message types`).toBeGreaterThan(0)

      const capture = validateCapture(
        JSON.parse(readFileSync(join(SCENARIO_DIR, `${scenario.id}.json`), 'utf8')),
      )
      const present = new Set(
        capture.sessions.flatMap((s) => s.packets.map((p) => p.type_name)),
      )
      const absent = scenario.teaches.filter((name) => !present.has(name))
      expect(absent, `${scenario.id} names message types its capture does not contain`).toEqual([])
    }
  })

  // Four chips is where the card stops being scannable, which is the only
  // reason this list is short rather than exhaustive.
  it('names at most four message types per scenario', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.teaches.length, `${scenario.id} names too many message types`)
        .toBeLessThanOrEqual(4)
    }
  })

  it('resolves by id', () => {
    expect(scenarioById('scram-auth')?.title).toContain('SCRAM')
    expect(scenarioById('nope')).toBeUndefined()
  })
})

describe('shipped captures', () => {
  // Every capture the site serves must survive its own validator. If one does not,
  // a visitor's first click shows an error, and only this test would catch it. The
  // Go tests check the format but not this parser.
  it.each(captureFiles())('%s parses and validates', (id) => {
    const raw = JSON.parse(readFileSync(join(SCENARIO_DIR, `${id}.json`), 'utf8'))
    const capture = validateCapture(raw)
    expect(capture.sessions.length).toBeGreaterThan(0)

    const total = capture.sessions.reduce((n, s) => n + s.packets.length, 0)
    expect(total, 'capture has no packets').toBeGreaterThan(0)
  })

  // The docs are the product: a message type with no entry renders as a bare
  // name with no explanation, which is exactly what this site exists to avoid.
  it('has documentation for every message type in every scenario', () => {
    const undocumented = new Set<string>()

    for (const id of captureFiles()) {
      const raw = JSON.parse(readFileSync(join(SCENARIO_DIR, `${id}.json`), 'utf8'))
      const capture = validateCapture(raw)
      for (const session of capture.sessions) {
        for (const packet of session.packets) {
          const doc = docForTypeName(packet.type_name)
          // The fallback returns the type name as its summary and no detail --
          // that is the shape of "nothing written for this".
          if (doc.category === 'unknown' && packet.type_name !== 'Unknown') {
            undocumented.add(packet.type_name)
          }
        }
      }
    }

    expect([...undocumented], 'message types needing an entry in MESSAGE_DOCS').toEqual([])
  })

  it('documents the single-byte SSL reply, which is not a wire message', () => {
    const doc = docForTypeName('SSLResponse')
    expect(doc.category).toBe('negotiation')
    expect(doc.detail).toBeTruthy()
  })

  it('has no accidentally empty docs', () => {
    for (const name of documentedTypeNames()) {
      const doc = docForTypeName(name)
      expect(doc.summary.length, `${name} has an empty summary`).toBeGreaterThan(10)
    }
  })
})
