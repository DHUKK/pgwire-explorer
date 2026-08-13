import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateCapture } from './capture'
import { stateAfter } from './state'
import type { Session } from '../types'

const SCENARIO_DIR = join(import.meta.dirname, '../../public/scenarios')

function loadScenario(id: string): Session[] {
  const raw = JSON.parse(readFileSync(join(SCENARIO_DIR, `${id}.json`), 'utf8'))
  return validateCapture(raw).sessions
}

/** State at the end of a session, which is the easiest thing to assert about. */
function finalState(session: Session) {
  return stateAfter(session, session.packets.length - 1)
}

/**
 * These run against the real shipped captures rather than hand-built packets on
 * purpose: the state engine reads annotation field names produced by the Go
 * decoder ("Parameter Name", "Transaction Status", ...), and a fixture written from
 * memory would happily pass while the real thing silently returned nothing. A
 * rename in annotate.go should break these.
 */
describe('stateAfter, over real captures', () => {
  it('accumulates startup and server parameters', () => {
    const [session] = loadScenario('simple-query')
    const state = finalState(session!)

    expect(state.startupParameters.map((p) => p.key)).toContain('user')
    expect(state.startupParameters.find((p) => p.key === 'database')?.value).toBe('postgres')

    // The startup burst is a dozen or so ParameterStatus messages.
    expect(state.serverParameters.size).toBeGreaterThan(5)
    expect(state.serverParameters.get('server_version')).toMatch(/^\d+/)
  })

  it('derives TLS negotiation from the packets, not the capture flags', () => {
    const [scram] = loadScenario('scram-auth')
    const negotiated = finalState(scram!)
    expect(negotiated.tls.requested).toBe(true)
    expect(negotiated.tls.response).toBe('N')

    // The pgx scenarios connect with sslmode=disable, so no negotiation happens.
    const [plain] = loadScenario('extended-query')
    const never = finalState(plain!)
    expect(never.tls.requested).toBe(false)
    expect(never.tls.response).toBeNull()
  })

  it('shows the TLS reply as outstanding between request and response', () => {
    const [session] = loadScenario('scram-auth')
    const atRequest = stateAfter(session!, 0)
    expect(atRequest.tls.requested).toBe(true)
    expect(atRequest.tls.response).toBeNull()
  })

  it('tracks the cancellation key', () => {
    const [session] = loadScenario('simple-query')
    const state = finalState(session!)
    expect(state.backendPid).toBeGreaterThan(0)
    expect(state.backendSecret).not.toBe('')
  })

  // The method is known from the server's first Authentication message, well before
  // the exchange finishes. That is what lets the status distinguish "SCRAM, in
  // progress" from "not started".
  it('knows the method before authentication completes', () => {
    const [session] = loadScenario('scram-auth')
    const packets = session!.packets

    const offer = packets.findIndex((p) => p.type_name === 'AuthenticationSASL')
    const atOffer = stateAfter(session!, offer)
    expect(atOffer.authMethod).toContain('SCRAM')
    expect(atOffer.authenticated).toBe(false)

    expect(finalState(session!).authenticated).toBe(true)
  })

  it('identifies md5 as the method', () => {
    const [session] = loadScenario('md5-auth')
    const state = finalState(session!)
    expect(state.authMethod).toContain('md5')
    expect(state.authenticated).toBe(true)
  })

  it('identifies cleartext as the method', () => {
    const [session] = loadScenario('cleartext-auth')
    const state = finalState(session!)
    expect(state.authMethod).toContain('cleartext')
    expect(state.authenticated).toBe(true)
  })

  // Trust names itself from AuthenticationOk alone, since there is no earlier
  // message to name it. Without that the pill would read a bare "ok" and leave a
  // reader unable to tell "no password was asked for" from "the method is not
  // worth reporting".
  it('names trust as the method when no credential was ever requested', () => {
    const [session] = loadScenario('trust-auth')
    const state = finalState(session!)
    expect(state.authMethod).toBe('trust (no password)')
    expect(state.authenticated).toBe(true)

    // Nothing between the request and the acceptance.
    const types = session!.packets.map((p) => p.type_name)
    const start = types.indexOf('StartupMessage')
    expect(types[start + 1]).toBe('AuthenticationOk')
  })

  it('reports authentication as incomplete before AuthenticationOk', () => {
    const [session] = loadScenario('scram-auth')
    const packets = session!.packets
    const okIndex = packets.findIndex((p) => p.type_name === 'AuthenticationOk')
    expect(okIndex).toBeGreaterThan(0)

    expect(stateAfter(session!, okIndex - 1).authenticated).toBe(false)
    expect(stateAfter(session!, okIndex).authenticated).toBe(true)
  })

  it('tracks transaction status from ReadyForQuery', () => {
    const [session] = loadScenario('simple-query')
    expect(finalState(session!).transactionStatus).toBe('I')
  })

  // A capture records each direction as it arrives, and pgx does not wait for
  // CopyInResponse before streaming: it sends the COPY statement and the data
  // back to back. So the client's CopyData genuinely precedes the server's
  // CopyInResponse on the wire. Pinned here because it looks like a bug in the
  // capture until you check the timestamps, and because it means nothing may
  // assume CopyData only follows CopyInResponse.
  it('tolerates CopyData arriving before CopyInResponse (client pipelining)', () => {
    const [session] = loadScenario('copy-in')
    const packets = session!.packets

    const copyData = packets.findIndex((p) => p.type_name === 'CopyData')
    const copyIn = packets.findIndex((p) => p.type_name === 'CopyInResponse')
    expect(copyData).toBeLessThan(copyIn)
    expect(packets[copyData]!.timestamp_ms).toBeLessThanOrEqual(packets[copyIn]!.timestamp_ms)
  })

  it('marks the connection closed after Terminate', () => {
    const [session] = loadScenario('simple-query')
    expect(finalState(session!).closed).toBe(true)
  })

  it('marks a CancelRequest session as closed', () => {
    const sessions = loadScenario('cancel-request')
    // The cancel arrives on its own connection: one packet, no reply.
    const cancelSession = sessions.find((s) =>
      s.packets.some((p) => p.type_name === 'CancelRequest'),
    )
    expect(cancelSession).toBeDefined()
    expect(cancelSession!.packets.length).toBe(1)
    expect(finalState(cancelSession!).closed).toBe(true)
  })

  it('is empty at the very start', () => {
    const [session] = loadScenario('simple-query')
    const state = stateAfter(session!, 0)
    expect(state.authenticated).toBe(false)
    expect(state.serverParameters.size).toBe(0)
    expect(state.transactionStatus).toBeNull()
  })

  // Stepping backwards must not leave state from the future behind, which is the
  // whole reason stateAfter refolds from the start instead of accumulating.
  it('does not leak future state when stepping backwards', () => {
    const [session] = loadScenario('simple-query')
    const last = session!.packets.length - 1

    const atEnd = stateAfter(session!, last)
    expect(atEnd.closed).toBe(true)

    const early = stateAfter(session!, 2)
    expect(early.closed).toBe(false)
    expect(early.authenticated).toBe(false)
    expect(early.transactionStatus).toBeNull()
    expect(early.backendPid).toBeNull()
  })

  it('clamps an index past the end', () => {
    const [session] = loadScenario('simple-query')
    const clamped = stateAfter(session!, 99999)
    expect(clamped.closed).toBe(finalState(session!).closed)
  })
})
