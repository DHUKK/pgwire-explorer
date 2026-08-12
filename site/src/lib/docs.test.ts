import { describe, expect, it } from 'vitest'
import { docsUrlForTypeName } from './docs'
import { documentedTypeNames } from './messages'

describe('docsUrlForTypeName', () => {
  it('builds a message-formats anchor from the message name', () => {
    expect(docsUrlForTypeName('AuthenticationOk')).toBe(
      'https://www.postgresql.org/docs/current/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-AUTHENTICATIONOK',
    )
    expect(docsUrlForTypeName('RowDescription')).toContain(
      '#PROTOCOL-MESSAGE-FORMATS-ROWDESCRIPTION',
    )
    expect(docsUrlForTypeName('SASLInitialResponse')).toContain(
      '#PROTOCOL-MESSAGE-FORMATS-SASLINITIALRESPONSE',
    )
  })

  // These two are a single reply byte with no type tag and no length, so they are
  // absent from a page about message formats. Linking them there would 404 the
  // anchor and land the reader at the top of a long page instead.
  it('sends the untyped replies to the flow section that describes them', () => {
    expect(docsUrlForTypeName('SSLResponse')).toBe(
      'https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-SSL',
    )
    expect(docsUrlForTypeName('GSSENCResponse')).toBe(
      'https://www.postgresql.org/docs/current/protocol-flow.html#PROTOCOL-FLOW-GSSAPI',
    )
  })

  it('has nowhere to send an unrecognized frame', () => {
    expect(docsUrlForTypeName('Unknown')).toBeUndefined()
    expect(docsUrlForTypeName('')).toBeUndefined()
  })

  // The panel only renders the link when there is a URL, so a type that quietly
  // stopped resolving would just lose its link with nothing to notice it.
  it('resolves every message type this site documents, except Unknown', () => {
    const missing = documentedTypeNames()
      .filter((name) => name !== 'Unknown')
      .filter((name) => docsUrlForTypeName(name) === undefined)
    expect(missing, 'documented message types with no docs link').toEqual([])
  })

  it('points only at postgresql.org, over https', () => {
    for (const name of documentedTypeNames()) {
      const url = docsUrlForTypeName(name)
      if (url === undefined) continue
      expect(new URL(url).origin, name).toBe('https://www.postgresql.org')
    }
  })
})
