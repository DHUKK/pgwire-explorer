import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCapture } from './capture'
import { stateAfter } from './state'
import { statusPills } from './status'
import type { Session } from '../types'

const SCENARIO_DIR = join(import.meta.dirname, '../../public/scenarios')

function loadScenario(id: string): Session[] {
  return validateCapture(JSON.parse(readFileSync(join(SCENARIO_DIR, `${id}.json`), 'utf8'))).sessions
}

function pillsAt(session: Session, index: number) {
  const pills = statusPills(stateAfter(session, index), session)
  return new Map(pills.map((p) => [p.key, p]))
}

describe('statusPills', () => {
  // The point of the fixed spine is that the status line does not change shape as
  // you step: the eye watches a value change rather than re-finding it.
  it('always reports TLS, AUTH and TX, in that order, at every point in a session', () => {
    const [session] = loadScenario('scram-auth')

    for (let i = 0; i < session!.packets.length; i++) {
      const keys = statusPills(stateAfter(session!, i), session!).map((p) => p.key)
      expect(keys, `packet ${i + 1}`).toEqual(['tls', 'auth', 'tx'])
    }
  })

  it('gives every pill a value and an explanation', () => {
    const [session] = loadScenario('error-response')
    for (const pill of statusPills(stateAfter(session!, session!.packets.length - 1), session!)) {
      expect(pill.value, `${pill.key} value`).not.toBe('')
      expect(pill.explain.length, `${pill.key} explanation`).toBeGreaterThan(15)
    }
  })

  it('tracks AUTH from not started, through in progress, to the method used', () => {
    const [session] = loadScenario('scram-auth')
    const packets = session!.packets

    expect(pillsAt(session!, 0).get('auth')!.value).toBe('not started')

    const firstAuth = packets.findIndex((p) => p.type_name === 'AuthenticationSASL')
    const inProgress = pillsAt(session!, firstAuth).get('auth')!
    expect(inProgress.value).toContain('in progress')
    expect(inProgress.tone).toBe('busy')
    // Only that it is SASL. The server has offered a list and the client has not
    // answered yet, so naming a mechanism here would be a guess.
    expect(inProgress.value).toBe('SASL, in progress')

    const pick = packets.findIndex((p) => p.type_name === 'SASLInitialResponse')
    expect(pillsAt(session!, pick).get('auth')!.value).toBe('SASL (SCRAM-SHA-256), in progress')

    const ok = packets.findIndex((p) => p.type_name === 'AuthenticationOk')
    const after = pillsAt(session!, ok).get('auth')!
    expect(after.value).toContain('SCRAM-SHA-256')
    expect(after.tone).toBe('ok')
  })

  // TLS comes from the negotiation in the packets, not from the capture's ssl_*
  // fields, so it moves through the states the wire actually shows rather than
  // jumping straight to the recorder's summary.
  it('follows the TLS negotiation: requested, then answered', () => {
    const [session] = loadScenario('scram-auth')
    const packets = session!.packets

    const request = packets.findIndex((p) => p.type_name === 'SSLRequest')
    expect(request).toBe(0)
    const pending = pillsAt(session!, request).get('tls')!
    expect(pending.value).toBe('awaiting reply')
    expect(pending.tone).toBe('busy')

    const reply = packets.findIndex((p) => p.type_name === 'SSLResponse')
    expect(reply).toBeGreaterThan(request)
    const answered = pillsAt(session!, reply).get('tls')!
    expect(answered.value).toBe('refused')
    expect(answered.explain).toContain('plaintext')
  })

  it('reports TLS as accepted when the reply byte is S', () => {
    // No scenario can contain this: an accepted upgrade encrypts everything
    // after the reply byte, so there would be nothing left to decode. The state
    // still has to render it, for a capture made some other way.
    const [session] = loadScenario('scram-auth')
    const state = stateAfter(session!, 1)
    expect(state.tls.requested).toBe(true)
    state.tls.response = 'S'

    const tls = new Map(statusPills(state, session!).map((p) => [p.key, p])).get('tls')!
    expect(tls.value).toBe('accepted')
    expect(tls.tone).toBe('ok')
  })

  it('reports TLS as not requested when the client never asked', () => {
    // The pgx-driven scenarios connect with sslmode=disable.
    const [session] = loadScenario('extended-query')
    expect(pillsAt(session!, 0).get('tls')!.value).toBe('not requested')
  })

  it('reports TX as unknown until the first ReadyForQuery', () => {
    const [session] = loadScenario('simple-query')
    const packets = session!.packets

    expect(pillsAt(session!, 0).get('tx')!.value).toBe('unknown')

    const ready = packets.findIndex((p) => p.type_name === 'ReadyForQuery')
    expect(pillsAt(session!, ready).get('tx')!.value).toBe('idle')
  })

  // Nothing that happens to a connection adds a pill. An error is an event, and a
  // COPY is a mode the CopyInResponse and CopyDone in the message list already
  // mark. An error's lasting effect shows up as TX going to E.
  it('never adds a fourth pill, whatever the session does', () => {
    for (const id of ['error-response', 'copy']) {
      for (const session of loadScenario(id)) {
        for (let i = 0; i < session.packets.length; i++) {
          const keys = statusPills(stateAfter(session, i), session).map((p) => p.key)
          expect(keys, `${id} packet ${i + 1}`).toEqual(['tls', 'auth', 'tx'])
        }
      }
    }
  })

  // The error-response scenario opens an explicit transaction and breaks it, so
  // all three transaction states are reachable from a real recording. It is the
  // only scenario that reaches TX=E.
  it('tracks TX through a real transaction, from idle to failed and back', () => {
    const [session] = loadScenario('error-response')
    const packets = session!.packets

    // Asserted as the whole arc rather than at hand-counted positions, so
    // regenerating the capture cannot quietly move what this checks.
    const values = packets.map((_, i) => pillsAt(session!, i).get('tx')!.value)
    const arc = values.filter((v, i) => i === 0 || v !== values[i - 1])
    expect(arc).toEqual(['unknown', 'idle', 'in transaction', 'failed', 'idle'])

    const broken = pillsAt(session!, values.indexOf('failed')).get('tx')!
    expect(broken.tone).toBe('error')
    expect(broken.explain).toContain('ROLLBACK')
  })
})
