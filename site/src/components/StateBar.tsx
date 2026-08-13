import type { Session } from '../types'
import type { ConnectionState } from '../lib/state'
import { statusPills } from '../lib/status'
import { SessionTag, type SessionBadge } from './SessionTag'

interface Props {
  state: ConnectionState
  session: Session
  /**
   * Which session these pills describe. Present only when more than one session
   * is on screen, since with one there is nothing to tell apart.
   */
  badge?: SessionBadge
  onOpen: () => void
}

/**
 * A one-line summary of the connection, under the transport controls.
 *
 * This replaced a full third pane, which spent a third of the window on the same
 * handful of facts. The pills come from statusPills, so TLS, AUTH and TX are
 * always present in the same order and the values change in place as you step --
 * the drawer shows exactly these pills with their explanations.
 *
 * Connection state is per-connection, so with two sessions merged into one list
 * these pills are about the selected message's session and nobody else's. The
 * tag in front of them says which, in the same mark and colour the packet list
 * puts on the row. Stepping from a session 1 row to a session 2 row changes
 * every value here, and without the tag that reads as the connection changing
 * rather than the subject changing.
 */
export function StateBar({ state, session, badge, onOpen }: Props) {
  const pills = statusPills(state, session)

  return (
    <div className="state-bar">
      {badge && <SessionTag badge={badge} label={`connection state for session ${badge.id}`} />}
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
