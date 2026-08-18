import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Landing } from '../components/Landing'
import { parseCapture } from '../lib/capture'
import {
  deleteSavedCapture,
  listSavedCaptures,
  saveCapture,
  type SavedCaptureMeta,
} from '../lib/savedCaptures'
import { stashUploaded } from '../lib/loadCapture'
import { useNotice } from '../lib/notice'

/**
 * The landing page and everything that belongs to it: the saved-capture list,
 * uploading a file, and deleting one.
 *
 * All of that state lives here rather than above the routes, because this is the
 * only screen that renders any of it. The one exception is the notice bar,
 * which outlives this screen and so lives in NoticeProvider.
 */
export function LandingScreen() {
  const navigate = useNavigate()
  const { setNotice } = useNotice()

  const [savedCaptures, setSavedCaptures] = useState<SavedCaptureMeta[]>([])
  // Which example is being fetched, so its card can show a spinner. The router
  // keeps this screen mounted while the loader runs, so a local click still has
  // somewhere to show progress.
  const [loadingId, setLoadingId] = useState<string | null>(null)

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

  const loadFile = useCallback(
    async (file: File) => {
      let capture
      try {
        capture = parseCapture(await file.text())
      } catch (err) {
        // Whatever went wrong, a reader who dropped in a real capture cannot fix
        // it: the file was written by a tool, not typed by hand. The specific
        // reason (an exact JSON path, most of the time) is logged for whoever
        // can actually act on it rather than shown here.
        console.error('Could not load capture from file:', err)
        setNotice('Invalid capture file.')
        return
      }

      try {
        await saveCapture(file.name, capture, file.size)
        await refreshSavedCaptures()
        // Handed to the loader so the navigation below does not read all of it
        // straight back out of IndexedDB. Only routable once it is genuinely
        // stored, because the route is resolved by reading it back.
        stashUploaded({ capture, name: file.name, source: 'file' })
        void navigate({ to: '/local/$name', params: { name: file.name } })
      } catch {
        setNotice(
          `Could not save "${file.name}" for later in this browser. It is still open now.`,
        )
      }
    },
    [navigate, refreshSavedCaptures, setNotice],
  )

  const deleteSaved = useCallback(
    async (name: string) => {
      try {
        await deleteSavedCapture(name)
        await refreshSavedCaptures()
      } catch {
        setNotice(`Could not delete the saved capture "${name}".`)
      }
    },
    [refreshSavedCaptures, setNotice],
  )

  return (
    <Landing
      loadingId={loadingId}
      onPickScenario={(id) => {
        setLoadingId(id)
        void navigate({ to: '/$scenarioId', params: { scenarioId: id } })
      }}
      onPickFile={loadFile}
      savedCaptures={savedCaptures}
      onOpenSaved={(name) => void navigate({ to: '/local/$name', params: { name } })}
      onDeleteSaved={deleteSaved}
      onOpenMessageIndex={() => void navigate({ to: '/messages' })}
    />
  )
}
