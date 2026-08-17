import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LoadedCapture, PacketRecord, Session } from '../types'
import { sessionDurationMs } from '../lib/capture'
import { scenarioById } from '../lib/scenarios'
import { stateAfter } from '../lib/state'
import { rangesForMerged, rangesForSession } from '../lib/highlight'
import { mergeSessions } from '../lib/merge'
import { ancestorPaths, fieldAtOffset, formatMs } from '../lib/hex'
import { PacketList } from './PacketList'
import { sessionHue } from './SessionTag'
import { PacketDetail } from './PacketDetail'
import { StateBar } from './StateBar'
import { StateDrawer } from './StateDrawer'
import { Controls } from './Controls'
import { ThemeToggle } from './ThemeToggle'

interface Props {
  loaded: LoadedCapture
  onClose: () => void
}

/** One row of the packet list, whatever the current session selection. */
interface Row {
  packet: PacketRecord
  /** Index into capture.sessions: which session this row's packet belongs to. */
  sessionIndex: number
  sessionId: number
  /** Index into that session's own packets array, for stateAfter and gaps. */
  packetIndexInSession: number
  wallClockMs: number
}

export function Explorer({ loaded, onClose }: Props) {
  const { capture } = loaded

  // Every session selected by default: the point of this feature is seeing how
  // connections interact, and narrowing to one is a click away. A session is
  // dropped from the list, never merged out of existence, so the last one
  // selected can never be unchecked: there is always at least one.
  const [selectedSessionIds, setSelectedSessionIds] = useState<ReadonlySet<number>>(
    () => new Set(capture.sessions.map((s) => s.id)),
  )
  const [rowIndex, setRowIndex] = useState(0)
  const [selectedFieldPath, setSelectedFieldPath] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [stateOpen, setStateOpen] = useState(false)

  // Explorer is not unmounted between two captures reached by URL alone (only
  // going back to the landing page does that), so a second capture can arrive as
  // a new `loaded` prop on the same component instance. Session selection is a
  // property of the capture on screen, not of the Explorer instance, so it has
  // to reset here rather than carry the previous capture's session ids into one
  // that only coincidentally reuses them.
  useEffect(() => {
    setSelectedSessionIds(new Set(capture.sessions.map((s) => s.id)))
    setRowIndex(0)
    setSelectedFieldPath(null)
    setCollapsed(new Set())
    setStateOpen(false)
  }, [capture])

  const scenario = loaded.scenarioId ? scenarioById(loaded.scenarioId) : undefined

  // The selected sessions, in the capture's own order, paired with their index
  // in capture.sessions. That index (not the position in this filtered array)
  // is what every row below carries, since it is what looks a session back up
  // for its own state replay regardless of which other sessions are also on
  // screen.
  const selected = useMemo(() => {
    const sessions: Session[] = []
    const captureIndices: number[] = []
    capture.sessions.forEach((s, i) => {
      if (selectedSessionIds.has(s.id)) {
        sessions.push(s)
        captureIndices.push(i)
      }
    })
    return { sessions, captureIndices }
  }, [capture.sessions, selectedSessionIds])

  const merged = selected.sessions.length > 1

  /**
   * Every packet from the selected sessions, in real wall-clock order.
   *
   * With exactly one session selected this is that session's own packets in
   * their own order, unchanged from before: mergeSessions of a single session
   * is just that session, so there is no special case to keep in sync with the
   * old single-session behaviour.
   *
   * Everything downstream (state, gaps, highlight ranges, the hex dump) reads
   * from this list and never reaches back into a specific session directly,
   * which is what keeps a merge of packets from also merging connection state:
   * every row still names its own owning session by capture index, and
   * stateAfter is always replayed against that session.
   */
  const rows = useMemo<Row[]>(
    () =>
      mergeSessions(selected.sessions).map((r) => ({
        packet: r.packet,
        sessionIndex: selected.captureIndices[r.sessionIndex]!,
        sessionId: r.sessionId,
        packetIndexInSession: r.packetIndex,
        wallClockMs: r.wallClockMs,
      })),
    [selected],
  )

  const packets = useMemo(() => rows.map((r) => r.packet), [rows])
  const wallClock = useMemo(() => rows.map((r) => r.wallClockMs), [rows])
  // Every row's owning session id, always, not only in the merged view.
  // PacketList needs this to key rows uniquely: a PacketRecord's own `id` is
  // only 1-based and dense *within its session*, so two sessions both have a
  // packet 1, a packet 2, and so on. Pairing it with the session id is what
  // makes the pair actually unique across a merged capture.
  const sessionIds = useMemo(() => rows.map((r) => r.sessionId), [rows])
  const clampedRowIndex = Math.min(rowIndex, rows.length - 1)
  const row = rows[clampedRowIndex]
  const packet = row?.packet

  // The session that owns the selected row, never whichever session happens to
  // be first. With two or more sessions on screen, a row from session 2 must
  // drive the status bar and drawer off session 2's own replay, which is the
  // entire point of keeping this separate from the packet list itself.
  const activeSession =
    capture.sessions[row?.sessionIndex ?? selected.captureIndices[0] ?? 0] ?? capture.sessions[0]!

  /**
   * Present only once two or more sessions are selected, one per row: which
   * session it came from, so a reader never has to guess. Hue comes from
   * sessionHue keyed by the session's position in the whole capture, so a
   * session keeps the same colour regardless of which other sessions are also
   * selected, and spaces by the golden angle instead of a fixed-size palette,
   * so it never runs out or starts repeating however many sessions there are.
   */
  const sessionBadges = useMemo(
    () =>
      merged ? rows.map((r) => ({ id: r.sessionId, hue: sessionHue(r.sessionIndex) })) : undefined,
    [merged, rows],
  )

  /**
   * The tag on the status bar and the drawer: which session the connection state
   * being shown actually belongs to.
   *
   * Taken from the selected row rather than from the session selection, because
   * that is what the state is replayed against. It is deliberately the same id
   * and the same hue as that row's own badge in the list, so the mark on the bar
   * and the mark on the row are visibly the same session.
   */
  const activeBadge = useMemo(
    () => (merged && row ? { id: row.sessionId, hue: sessionHue(row.sessionIndex) } : undefined),
    [merged, row],
  )

  // Derived connection state as of the selected packet, replayed against the
  // packet's own session. Recomputed on every change rather than accumulated,
  // so jumping backwards (or landing on a row from a different session) can
  // never leave it showing state from the future or from the wrong connection.
  const state = useMemo(
    () => stateAfter(activeSession, row?.packetIndexInSession ?? 0),
    [activeSession, row],
  )

  /**
   * The stretches this scenario exists to show.
   *
   * Every capture shares the same startup preamble, so marking the part that
   * differs is what makes a scenario legible without hiding any of the real
   * recording. An uploaded capture has no scenario and so gets no marks, because
   * nothing here knows what the reader came to look at. The same per-session,
   * per-packet-ID spec applies whether one session or several are on screen,
   * translated into positions in whichever list is showing.
   */
  const ranges = useMemo(() => {
    if (merged) return rangesForMerged(rows, scenario?.highlight)
    return rangesForSession(packets, scenario?.highlight, activeSession.id)
  }, [merged, rows, packets, scenario, activeSession.id])

  const selectPacket = useCallback((index: number) => {
    setRowIndex(index)
    setSelectedFieldPath(null)
  }, [])

  // A session dropping out of or into the selection changes what the list
  // shows entirely, so position resets to the top rather than trying to carry
  // a selection across two different orderings.
  const toggleSession = useCallback((id: number) => {
    setSelectedSessionIds((current) => {
      if (current.has(id) && current.size === 1) return current // never empty
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setRowIndex(0)
    setSelectedFieldPath(null)
  }, [])

  // Narrowing to one session, which is the common case: a click on a session
  // means "just this one", and the swatch beside it is what adds a second.
  const selectOnlySession = useCallback((id: number) => {
    setSelectedSessionIds(new Set([id]))
    setRowIndex(0)
    setSelectedFieldPath(null)
  }, [])

  const step = useCallback(
    (delta: number) => {
      setRowIndex((current) => {
        const next = current + delta
        if (next < 0) return 0
        if (next > rows.length - 1) return rows.length - 1
        return next
      })
      setSelectedFieldPath(null)
    },
    [rows.length],
  )

  // Keyboard control. Ignored while a form control has focus, so the session
  // checkboxes and the range input keep their own key behaviour.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
      ) {
        return
      }

      switch (event.key) {
        case 'ArrowDown':
        case 'j':
          event.preventDefault()
          step(1)
          break
        case 'ArrowUp':
        case 'k':
          event.preventDefault()
          step(-1)
          break
        case 'Home':
          event.preventDefault()
          selectPacket(0)
          break
        case 'End':
          event.preventDefault()
          selectPacket(rows.length - 1)
          break
        case 's':
          event.preventDefault()
          setStateOpen((open) => !open)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, selectPacket, rows.length])

  /**
   * Clicking a byte selects the innermost field covering it, and expands the tree
   * far enough to reveal it. This is the hex-dump-to-field direction of the
   * two-way link. Hovering a field highlights bytes without changing selection.
   */
  const selectByteOffset = useCallback(
    (offset: number) => {
      const hit = fieldAtOffset(packet?.fields ?? [], offset)
      if (!hit) return
      setSelectedFieldPath(hit.path)
      setCollapsed((current) => {
        const next = new Set(current)
        for (const ancestor of ancestorPaths(hit.path)) next.delete(ancestor)
        return next
      })
    },
    [packet],
  )

  const toggleCollapsed = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  return (
    <div className="explorer">
      <header className="explorer-header">
        <button className="ghost-button" onClick={onClose} title="Back to the session list">
          <span aria-hidden="true">&larr;</span>
          <span className="ghost-button-label">back</span>
        </button>

        <div className="explorer-title">
          <h1>{loaded.name}</h1>
          <span className="explorer-meta">
            {capture.sessions.length} session{capture.sessions.length === 1 ? '' : 's'} ·{' '}
            {rows.length} message{rows.length === 1 ? '' : 's'} ·{' '}
            {merged ? formatMs(mergedSpanMs(rows)) : formatMs(sessionDurationMs(activeSession))}
          </span>
        </div>

        <ThemeToggle />
      </header>

      {/* Selecting exactly one session is today's single-spine view, unchanged.
          Selecting two or more merges their packets into one wall-clock-ordered
          list with a badge on every row, for when the sessions are causally
          related, such as a CancelRequest's own connection or a replication
          stream next to the writes it is carrying. A session that is just noise
          (a client's background connection) stays easy to drop with one click. */}
      {capture.sessions.length > 1 && (
        <div className="session-select" role="group" aria-label="Sessions shown">
          {capture.sessions.map((s, i) => {
            const shown = selectedSessionIds.has(s.id)
            const last = shown && selectedSessionIds.size === 1
            return (
              <span
                key={s.id}
                className={shown ? 'session-chip shown' : 'session-chip'}
                style={{ ['--chip-hue' as string]: sessionHue(i) }}
              >
                {/* Filled when the session is on screen, hollow when it is not.
                    The same hue the row badges use, so the control and the rows
                    it governs read as one thing. */}
                <button
                  type="button"
                  className="session-chip-swatch"
                  aria-pressed={shown}
                  disabled={last}
                  title={
                    last
                      ? 'The last session on screen cannot be removed'
                      : shown
                        ? `Remove session ${s.id} from the list`
                        : `Add session ${s.id} to the list`
                  }
                  onClick={() => toggleSession(s.id)}
                >
                  <span className="sr-only">
                    {shown ? `Remove session ${s.id}` : `Add session ${s.id}`}
                  </span>
                </button>

                <button
                  type="button"
                  className="session-chip-body"
                  aria-pressed={shown && selectedSessionIds.size === 1}
                  title={`Show only session ${s.id}`}
                  onClick={() => selectOnlySession(s.id)}
                >
                  <span className="session-chip-id">session {s.id}</span>
                  <span className="session-chip-meta">
                    {s.client_addr.split(':').pop()} · {s.packets.length} msgs
                  </span>
                </button>
              </span>
            )
          })}
        </div>
      )}

      <Controls
        onStep={step}
        onSeek={selectPacket}
        index={rowIndex}
        total={rows.length}
        ranges={ranges}
      />

      <StateBar
        state={state}
        session={activeSession}
        badge={activeBadge}
        onOpen={() => setStateOpen(true)}
      />

      <div className="explorer-body">
        <PacketList
          packets={packets}
          wallClock={wallClock}
          sessionIds={sessionIds}
          selected={rowIndex}
          onSelect={selectPacket}
          ranges={ranges}
          sessionBadges={sessionBadges}
        />

        {packet ? (
          <PacketDetail
            packet={packet}
            selectedFieldPath={selectedFieldPath}
            onSelectField={setSelectedFieldPath}
            onSelectByte={selectByteOffset}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        ) : (
          <div className="panel empty">
            <strong>Nothing to show</strong>
            <span>
              This session has no packets. It was opened and closed without either side sending
              anything.
            </span>
          </div>
        )}
      </div>

      {stateOpen && (
        <StateDrawer
          state={state}
          session={activeSession}
          packetNumber={packet?.id ?? 0}
          badge={activeBadge}
          onClose={() => setStateOpen(false)}
        />
      )}
    </div>
  )
}

/** Wall-clock span of a row list, first packet to last. */
function mergedSpanMs(rows: readonly Row[]): number {
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (!first || !last) return 0
  return last.wallClockMs - first.wallClockMs
}
