import { CaptureError, validateCapture } from './capture'
import { scenarioById, scenarioUrl } from './scenarios'
import { loadSavedCapture } from './savedCaptures'
import type { LoadedCapture } from '../types'

/**
 * Fetching a capture for a route loader. The router runs these before the screen
 * renders, which is what keeps a deep link from flashing the landing page first.
 */

/**
 * The capture a reader just uploaded, held only until the navigation that
 * follows saving it has read it back.
 *
 * Without this, opening the file a reader picked would save it to IndexedDB and
 * then immediately read all of it out again, which for a 32MB capture is a
 * visible pause on a screen that already had the data in hand.
 */
let justUploaded: LoadedCapture | null = null

export function stashUploaded(loaded: LoadedCapture): void {
  justUploaded = loaded
}

/** A shipped example, by scenario id. Throws CaptureError when it cannot load. */
export async function loadScenarioCapture(id: string): Promise<LoadedCapture> {
  const scenario = scenarioById(id)
  if (!scenario) throw new CaptureError(`There is no example called "${id}".`)

  let response: Response
  try {
    response = await fetch(scenarioUrl(id))
  } catch (err) {
    throw new CaptureError(`Could not load that example: ${(err as Error).message}`)
  }
  if (!response.ok) {
    throw new CaptureError(
      `Could not load the "${scenario.title}" example (HTTP ${response.status}).`,
    )
  }

  try {
    const capture = validateCapture(await response.json())
    return { capture, name: scenario.title, source: 'scenario', scenarioId: id }
  } catch (err) {
    if (err instanceof CaptureError) throw err
    throw new CaptureError(`Could not load that example: ${(err as Error).message}`)
  }
}

/**
 * A capture saved in this browser, by name. Returns undefined when this browser
 * does not hold it, which is not an error worth a red alert: the reader deleted
 * it, or opened the same link somewhere else.
 */
export async function loadLocalCapture(name: string): Promise<LoadedCapture | undefined> {
  if (justUploaded?.name === name) {
    const loaded = justUploaded
    justUploaded = null
    return loaded
  }

  const capture = await loadSavedCapture(name)
  if (!capture) return undefined
  return { capture, name, source: 'file' }
}
