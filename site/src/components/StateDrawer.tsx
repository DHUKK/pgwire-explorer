import { useEffect, useRef } from 'react'
import type { Session } from '../types'
import type { ConnectionState } from '../lib/state'
import { statusPills } from '../lib/status'
import { Inline } from '../lib/inline'

interface Props {
  state: ConnectionState
  session: Session
  packetNumber: number
  onClose: () => void
}

/** Shown first in the session block. Every other startup parameter follows. */
const HEADLINE_PARAMS = ['user', 'database']

/**
 * The connection state, as an overlay rather than a permanent pane.
 *
 * Structured as the status bar expanded. The same pills, in the same order, each
 * with the sentence explaining what that state means, then the detail that does
 * not fit on one line.
 *
 * Nothing here is a record of what happened: no command tags, no notices, no
 * step-by-step handshake. The packet list already tells that story, and a second
 * telling of it was the bulk of what made the old pane not worth its space.
 * Prepared statements and portals were listed here for the same reason and went
 * the same way. `Parse` and `Bind` are in the list with every field decoded, so a
 * running inventory of them was a second telling too.
 */
export function StateDrawer({ state, session, packetNumber, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const pills = statusPills(state, session)

  useEffect(() => {
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const params = new Map(state.startupParameters.map((p) => [p.key, p.value]))
  const otherParams = state.startupParameters.filter((p) => !HEADLINE_PARAMS.includes(p.key))

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        className="drawer"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Connection state"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <div>
            <h2>Connection state</h2>
            <span className="drawer-sub">after packet {packetNumber}</span>
          </div>
          <button className="ghost-button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="drawer-scroll">
          {/* The status bar, expanded. Same pills, same order, plus the sentence
              that explains what each value means. */}
          <section className="status-list">
            {pills.map((pill) => (
              <div className="status-item" key={pill.key}>
                <span className={`pill tone-${pill.tone ?? 'plain'}`}>
                  <span className="pill-label">{pill.label}</span>
                  <span className="pill-value">{pill.value}</span>
                </span>
                <p className="status-explain">
                  <Inline text={pill.explain} />
                </p>
              </div>
            ))}
          </section>

          {/* Every startup parameter lives here, headline ones first: they are all
              just things the client asked for, and splitting them across two
              blocks made the second look like a different kind of fact. */}
          <Group title="Session">
            <Row label="user" value={params.get('user') ?? 'not sent'} mono />
            <Row label="database" value={params.get('database') ?? params.get('user') ?? 'not sent'} mono />
            {otherParams.map((p) => (
              <Row key={p.key} label={p.key} value={p.value} mono />
            ))}
            <Row label="client" value={session.client_addr} mono />
            <Row label="server" value={session.server_addr} mono />
            <Row label="connection" value={state.closed ? 'closed' : 'open'} />
          </Group>

          {state.backendPid !== null && (
            <Group title="Cancellation key">
              <Row label="backend PID" value={String(state.backendPid)} mono />
              <Row label="secret" value={state.backendSecret ?? ''} mono />
            </Group>
          )}

          {state.serverParameters.size > 0 && (
            <Group
              title={`Server settings · ${state.serverParameters.size}`}
              note="Reported by `ParameterStatus`. The server sends another whenever one of these changes, so a client never has to ask."
            >
              {[...state.serverParameters].map(([name, value]) => (
                <Row key={name} label={name} value={value} mono />
              ))}
            </Group>
          )}
        </div>
      </div>
    </div>
  )
}

function Group({
  title,
  children,
  note,
}: {
  title: string
  children: React.ReactNode
  note?: string
}) {
  return (
    <section className="group">
      <span className="group-title">{title}</span>
      <div className="rows">{children}</div>
      {note && (
        <p className="drawer-note">
          <Inline text={note} />
        </p>
      )}
    </section>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  // display: contents (see .row in styles.css) so label and value become cells of
  // the parent grid, and labels line up across every row without a fixed width.
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className={mono ? 'row-value mono' : 'row-value'}>
        {value === '' ? <em>(empty)</em> : value}
      </span>
    </div>
  )
}
