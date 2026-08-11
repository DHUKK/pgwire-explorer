import type { Session } from '../types'
import type { ConnectionState } from '../lib/state'
import { statusPills } from '../lib/status'

interface Props {
  state: ConnectionState
  session: Session
  onOpen: () => void
}

/**
 * A one-line summary of the connection, under the transport controls.
 *
 * This replaced a full third pane, which spent a third of the window on the same
 * handful of facts. The pills come from statusPills, so TLS, AUTH and TX are
 * always present in the same order and the values change in place as you step --
 * the drawer shows exactly these pills with their explanations.
 */
export function StateBar({ state, session, onOpen }: Props) {
  const pills = statusPills(state, session)

  return (
    <div className="state-bar">
      <ul className="pills">
        {pills.map((pill) => (
          <li key={pill.key} className={`pill tone-${pill.tone ?? 'plain'}`}>
            <span className="pill-label">{pill.label}</span>
            <span className="pill-value">{pill.value}</span>
          </li>
        ))}
      </ul>

      <button className="ghost-button state-bar-more" onClick={onOpen} title="Full connection state (s)">
        details <kbd>s</kbd>
      </button>
    </div>
  )
}
