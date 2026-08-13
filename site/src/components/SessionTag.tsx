import type { CSSProperties } from 'react'

/**
 * Which session something belongs to, so it is never ambiguous which connection
 * is being shown.
 *
 * `hue` is decoration on top of the id, not the identifier itself: the tag text
 * (S1, S2, ...) is what actually disambiguates sessions, since colour alone
 * would not work for a colour-blind reader.
 */
export interface SessionBadge {
  id: number
  hue: number
}

/**
 * A colour for the Nth session that stays distinct as N grows, instead of a
 * fixed-size palette that would start repeating after a handful of sessions.
 *
 * The golden angle (~137.5°) is the standard trick for spacing hues around the
 * wheel so that no small run of consecutive indices lands on similar colours,
 * however many sessions there turn out to be.
 *
 * The offset matters as much as the spacing. Starting at 0 puts the first two
 * sessions on red and green, the one pair the ~8% of men with red/green colour
 * blindness cannot separate, and two sessions is the common case. Starting in
 * the blues gives blue then magenta instead. The tag text (S1, S2, ...) is what
 * actually identifies a session, so hue is only ever a second signal.
 */
const HUE_START = 205

export function sessionHue(sessionIndex: number): number {
  return (HUE_START + sessionIndex * 137.508) % 360
}

/**
 * The one definition of the S1 mark, used on a packet-list row, on the status
 * bar and in the drawer's heading.
 *
 * Shared because those three have to agree. The bar and the drawer describe one
 * specific connection, and with two sessions on screen the row that is selected
 * is the only thing saying which, so the same mark in the same colour has to
 * mean the same session in all three places.
 *
 * `label` overrides the accessible name, for the places where the tag is the
 * only thing scoping what is around it and "session 2" alone would not say what
 * belongs to session 2.
 */
export function SessionTag({ badge, label }: { badge: SessionBadge; label?: string }) {
  return (
    <span
      className="session-badge"
      style={{ '--badge-hue': badge.hue } as CSSProperties}
      title={label ?? `session ${badge.id}`}
    >
      S{badge.id}
    </span>
  )
}
