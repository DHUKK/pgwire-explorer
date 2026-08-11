import { packetCount } from './capture'
import type { SessionCapture } from '../types'

/**
 * Captures a visitor has uploaded before, kept in this browser's IndexedDB so
 * they can be reopened without finding the file again.
 *
 * IndexedDB, not localStorage: localStorage caps at a few megabytes per
 * origin and a real capture can be tens of megabytes, so localStorage would
 * throw on exactly the files this feature exists for.
 *
 * The database holds two object stores, both keyed by filename so a second
 * upload of the same name replaces the first rather than duplicating it:
 *
 *   - `capture-meta`: one small record per capture, everything the landing
 *     page's list needs to draw a row.
 *   - `capture-data`: the full parsed capture.
 *
 * Splitting them is what lets the landing page list saved captures without
 * reading their bytes. Reading `capture-data` just to draw a list would
 * defeat the point on a 32MB capture.
 *
 * The pure helpers (deriveMeta, sortByNewest, formatFileSize, formatSavedAt)
 * are exported separately from the IndexedDB glue so they can be unit tested
 * without a real IndexedDB, which is not available in this project's test
 * environment and cannot be added as a dependency.
 */

export interface SavedCaptureMeta {
  /** The filename it was uploaded as. Also the storage key. */
  name: string
  /** ISO timestamp of when it was saved. */
  savedAt: string
  /** Size of the original file, in bytes. */
  size: number
  sessionCount: number
  packetCount: number
}

/** Thrown for anything that stops a save, load, list or delete from completing. */
export class SavedCapturesUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavedCapturesUnavailableError'
  }
}

/** Derives the metadata row for a capture. Counts come from the parsed capture, not a re-read. */
export function deriveMeta(
  name: string,
  capture: SessionCapture,
  size: number,
  savedAt: string,
): SavedCaptureMeta {
  return {
    name,
    savedAt,
    size,
    sessionCount: capture.sessions.length,
    packetCount: packetCount(capture),
  }
}

/** Newest first. Ties (identical timestamps) break on filename, so the order is stable. */
export function sortByNewest(entries: readonly SavedCaptureMeta[]): SavedCaptureMeta[] {
  return [...entries].sort((a, b) => {
    if (a.savedAt !== b.savedAt) return a.savedAt > b.savedAt ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/** "1.2 MB", "340 KB", "58 B". Binary units, one decimal place above 1 KB. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unitIndex]}`
}

/**
 * "2026-08-12 14:03 UTC". Fixed to UTC and to this exact shape rather than
 * `toLocaleString`, which varies by locale and time zone and would make this
 * untestable and inconsistent between a saver and a later viewer.
 */
/**
 * When a capture was saved, in the reader's own time zone, since "yesterday
 * afternoon" is the question being answered and UTC makes that arithmetic.
 *
 * timeZone is only for tests, which need one fixed answer rather than the
 * machine's.
 */
export function formatSavedAt(iso: string, timeZone?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  })
}

const DB_NAME = 'pgwire-explorer'
const DB_VERSION = 1
const META_STORE = 'capture-meta'
const DATA_STORE = 'capture-data'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(
      new SavedCapturesUnavailableError('IndexedDB is not available in this browser.'),
    )
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION)
      } catch (err) {
        reject(new SavedCapturesUnavailableError((err as Error).message))
        return
      }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'name' })
        }
        if (!db.objectStoreNames.contains(DATA_STORE)) {
          db.createObjectStore(DATA_STORE, { keyPath: 'name' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => {
        dbPromise = null
        reject(
          new SavedCapturesUnavailableError(
            request.error?.message ?? 'Could not open browser storage.',
          ),
        )
      }
      request.onblocked = () => {
        dbPromise = null
        reject(new SavedCapturesUnavailableError('Browser storage is blocked by another tab.'))
      }
    })
  }
  return dbPromise
}

/** Metadata only, newest first. Never reads capture-data, so this stays cheap regardless of capture size. */
export async function listSavedCaptures(): Promise<SavedCaptureMeta[]> {
  const db = await openDb()
  const entries = await new Promise<SavedCaptureMeta[]>((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly')
    const request = tx.objectStore(META_STORE).getAll()
    request.onsuccess = () => resolve(request.result as SavedCaptureMeta[])
    request.onerror = () =>
      reject(
        new SavedCapturesUnavailableError(
          request.error?.message ?? 'Could not list saved captures.',
        ),
      )
  })
  return sortByNewest(entries)
}

/** The full capture, or undefined if nothing is saved under that name. */
export async function loadSavedCapture(name: string): Promise<SessionCapture | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DATA_STORE, 'readonly')
    const request = tx.objectStore(DATA_STORE).get(name)
    request.onsuccess = () => {
      const row = request.result as { name: string; capture: SessionCapture } | undefined
      resolve(row?.capture)
    }
    request.onerror = () =>
      reject(
        new SavedCapturesUnavailableError(
          request.error?.message ?? 'Could not load the saved capture.',
        ),
      )
  })
}

/**
 * Saves a capture under `name`, replacing any existing entry with that name.
 * Call only after the capture has parsed and validated successfully: a
 * capture that fails validation must never end up in this list.
 */
export async function saveCapture(
  name: string,
  capture: SessionCapture,
  size: number,
): Promise<void> {
  const db = await openDb()
  const meta = deriveMeta(name, capture, size, new Date().toISOString())
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite')
    tx.objectStore(META_STORE).put(meta)
    tx.objectStore(DATA_STORE).put({ name, capture })
    tx.oncomplete = () => resolve()
    tx.onerror = () =>
      reject(
        new SavedCapturesUnavailableError(tx.error?.message ?? 'Could not save the capture.'),
      )
  })
}

export async function deleteSavedCapture(name: string): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite')
    tx.objectStore(META_STORE).delete(name)
    tx.objectStore(DATA_STORE).delete(name)
    tx.oncomplete = () => resolve()
    tx.onerror = () =>
      reject(
        new SavedCapturesUnavailableError(
          tx.error?.message ?? 'Could not delete the saved capture.',
        ),
      )
  })
}
