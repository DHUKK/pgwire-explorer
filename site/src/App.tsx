import { useCallback, useEffect, useRef, useState } from 'react'
import { Landing } from './components/Landing'
import { Explorer } from './components/Explorer'
import { CaptureError, parseCapture, validateCapture } from './lib/capture'
import { scenarioById, scenarioUrl } from './lib/scenarios'
import {
  deleteSavedCapture,
  listSavedCaptures,
  loadSavedCapture,
  saveCapture,
  type SavedCaptureMeta,
} from './lib/savedCaptures'
import { MessageIndex } from './components/MessageIndex'
import type { LoadedCapture, PacketFocus } from './types'

/**
 * Three screens: pick a session, explore it, or read the message index.
 *
 * The hash is the single source of truth, so a capture can be linked to and the
 * browser's back and forward buttons work. Navigation is done by assigning to
 * `location.hash`, which pushes a history entry, rather than by `replaceState`,
 * which does not and left back leaving the site entirely.
 *
 * The routes:
 *
 *   (empty)                the landing page
 *   messages               the protocol message index
 *   <scenario>             a shipped example
 *   <scenario>/<s>/<p>     that example, opened on session <s>, packet <p>
 *   local/<name>           a capture saved in this browser
 *
 * A bare scenario id and a `local/` name cannot collide, which is why the prefix
 * is there: a saved file called `notify.json` never shadows the `notify` example.
 * A `local/` link only resolves in the browser holding that capture, since the
 * file itself is never uploaded anywhere. It is still worth a URL, because
 * reloading the page is what a reader does after re-recording.
 *
 * The two trailing segments are the smallest change that lets the index link to
 * one message. They are ids rather than a position in the list, because position
 * depends on which sessions are selected and ids do not, and they are optional so
 * every link that already exists keeps working. The cost is that they do not
 * track the selection: stepping through the list does not rewrite the URL, so a
 * focused link is an entry point and not a permanent address for wherever the
 * reader has since arrived.
 */
const LOCAL_PREFIX = 'local/'

/** The message index, which is reference data rather than a capture. */
const MESSAGES_ROUTE = 'messages'

/**
 * The `<session>/<packet>` part of a route, or undefined when it is absent or
 * malformed. A bad focus opens the capture at the top rather than failing: the
 * scenario id is the part that has to be right.
 */
function parseFocus(session?: string, packet?: string): PacketFocus | undefined {
  if (session === undefined || packet === undefined) return undefined
  if (!/^\d+$/.test(session) || !/^\d+$/.test(packet)) return undefined
  const sessionId = Number(session)
  const packetId = Number(packet)
  if (sessionId < 1 || packetId < 1) return undefined
  return { sessionId, packetId }
}

export default function App() {
  const [loaded, setLoaded] = useState<LoadedCapture | null>(null)
  const [error, setError] = useState<CaptureError | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  // The message index is a screen rather than a capture, so it needs its own flag
  // instead of being another shape of `loaded`.
  const [showIndex, setShowIndex] = useState(false)
  const [savedCaptures, setSavedCaptures] = useState<SavedCaptureMeta[]>([])
  // A brief note when saving or loading a saved capture did not go as expected.
  // Rendered outside both Landing and Explorer so it can appear regardless of
  // which of the two is on screen at the time.
  const [saveNotice, setSaveNotice] = useState<string | null>(null)

  // Which saved capture is already open, so the hash listener can tell an
  // already-satisfied route from one that needs loading. A ref rather than
  // state: the listener must not resubscribe every time a capture loads, and
  // re-reading a 32MB record from IndexedDB just to arrive where we already are
  // is a visible pause.
  const openLocalName = useRef<string | null>(null)

  // The saved-captures list is metadata only, so refreshing it never touches a
  // capture's own bytes. Failing to list is treated the same as there being
  // none: the feature degrades to "nothing saved" rather than surfacing an
  // error for a list nobody asked to see yet.
  const refreshSavedCaptures = useCallback(async () => {
    try {
      setSavedCaptures(await listSavedCaptures())
    } catch {
      setSavedCaptures([])
    }
  }, [])

  useEffect(() => {
    void refreshSavedCaptures()
  }, [refreshSavedCaptures])

  const loadScenario = useCallback(async (id: string, focus?: PacketFocus) => {
    const scenario = scenarioById(id)
    if (!scenario) {
      setError(new CaptureError(`There is no example called "${id}".`))
      return
    }

    setLoadingId(id)
    setError(null)
    try {
      const response = await fetch(scenarioUrl(id))
      if (!response.ok) {
        throw new CaptureError(
          `Could not load the "${scenario.title}" example (HTTP ${response.status}).`,
        )
      }
      const capture = validateCapture(await response.json())
      setLoaded({ capture, name: scenario.title, source: 'scenario', scenarioId: id, focus })
    } catch (err) {
      setError(
        err instanceof CaptureError
          ? err
          : new CaptureError(`Could not load that example: ${(err as Error).message}`),
      )
    } finally {
      setLoadingId(null)
    }
  }, [])

  /**
   * Open a capture saved in this browser, by name.
   *
   * A `local/` route can outlive the capture it names: the reader deletes it, or
   * opens the same link in a different browser. That is not an error worth a red
   * alert, so it says so plainly and drops back to the landing page rather than
   * leaving the URL pointing at nothing.
   */
  const loadSaved = useCallback(
    async (name: string) => {
      setError(null)
      try {
        const capture = await loadSavedCapture(name)
        if (!capture) {
          openLocalName.current = null
          setSaveNotice(`"${name}" is not saved in this browser.`)
          await refreshSavedCaptures()
          if (window.location.hash !== '') window.location.hash = ''
          return
        }
        openLocalName.current = name
        setLoaded({ capture, name, source: 'file' })
      } catch {
        openLocalName.current = null
        setSaveNotice(`Could not open the saved capture "${name}".`)
      }
    },
    [refreshSavedCaptures],
  )

  // The hash drives everything. Runs on mount for deep links and reloads, and
  // on every back, forward or in-app navigation.
  useEffect(() => {
    const sync = () => {
      const route = window.location.hash.replace(/^#/, '')
      if (route === MESSAGES_ROUTE) {
        openLocalName.current = null
        setLoaded(null)
        setError(null)
        setShowIndex(true)
        return
      }
      setShowIndex(false)
      if (route === '') {
        openLocalName.current = null
        setLoaded(null)
        setError(null)
        return
      }
      if (route.startsWith(LOCAL_PREFIX)) {
        const name = decodeURIComponent(route.slice(LOCAL_PREFIX.length))
        // Already on screen, which is the case right after uploading a file.
        if (openLocalName.current === name) return
        void loadSaved(name)
        return
      }
      // A scenario, optionally with the message to open on. Anything else is
      // left alone, which leaves whatever is already on screen where it is.
      const [id, session, packet] = route.split('/')
      if (id !== undefined && scenarioById(id)) {
        openLocalName.current = null
        void loadScenario(id, parseFocus(session, packet))
      }
    }
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [loadScenario, loadSaved])

  /**
   * Navigate to any route. The hashchange listener does the loading, so every
   * screen change goes through the same path whether it came from a click, a
   * pasted link or the back button.
   */
  const openRoute = useCallback((route: string) => {
    window.location.hash = route
  }, [])

  /** The route for a capture saved in this browser. */
  const localRoute = (name: string) => `${LOCAL_PREFIX}${encodeURIComponent(name)}`

  const loadFile = useCallback(async (file: File) => {
    setError(null)
    let capture
    try {
      capture = parseCapture(await file.text())
    } catch (err) {
      // Whatever went wrong, a reader who dropped in a real capture cannot fix
      // it: the file was written by a tool, not typed by hand. The specific
      // reason (an exact JSON path, most of the time) is logged for whoever
      // can actually act on it rather than shown here.
      console.error('Could not load capture from file:', err)
      setError(new CaptureError('Invalid capture file.'))
      return
    }

    // Open it first: saving is a convenience on top of a capture that already
    // works, and must never be what stands between a reader and the file they
    // just picked.
    setLoaded({ capture, name: file.name, source: 'file' })

    try {
      await saveCapture(file.name, capture, file.size)
      await refreshSavedCaptures()
      // Only routable once it is genuinely stored, because the route is
      // resolved by reading it back. Claiming the URL first would leave a
      // reload staring at a capture that was never saved. openLocalName is set
      // ahead of the hash so the listener knows this one is already on screen.
      openLocalName.current = file.name
      window.location.hash = localRoute(file.name)
    } catch {
      setSaveNotice(
        `Could not save "${file.name}" for later in this browser. It is still open now.`,
      )
    }
  }, [refreshSavedCaptures])

  /** Navigate to a saved capture. The hashchange listener does the loading. */
  const openSaved = useCallback((name: string) => {
    window.location.hash = localRoute(name)
  }, [])

  /** Remove a saved capture. Deleting is only reachable while none is open. */
  const deleteSaved = useCallback(
    async (name: string) => {
      try {
        await deleteSavedCapture(name)
        if (openLocalName.current === name) openLocalName.current = null
        await refreshSavedCaptures()
      } catch {
        setSaveNotice(`Could not delete the saved capture "${name}".`)
      }
    },
    [refreshSavedCaptures],
  )

  const close = useCallback(() => {
    if (window.location.hash !== '') {
      // Clearing the hash fires hashchange, which unloads the capture.
      window.location.hash = ''
      return
    }
    setLoaded(null)
    setError(null)
  }, [])

  return (
    <>
      {loaded ? (
        <Explorer loaded={loaded} onClose={close} />
      ) : showIndex ? (
        <MessageIndex onClose={close} onOpenExample={openRoute} />
      ) : (
        <Landing
          error={error}
          loadingId={loadingId}
          onPickScenario={openRoute}
          onPickFile={loadFile}
          savedCaptures={savedCaptures}
          onOpenSaved={openSaved}
          onDeleteSaved={deleteSaved}
          onOpenMessageIndex={() => openRoute(MESSAGES_ROUTE)}
        />
      )}

      {saveNotice && (
        <div className="save-notice" role="status">
          <span>{saveNotice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setSaveNotice(null)}
          >
            ×
          </button>
        </div>
      )}
    </>
  )
}
