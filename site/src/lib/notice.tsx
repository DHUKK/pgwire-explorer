import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

/**
 * A brief note when saving or loading a saved capture did not go as expected.
 *
 * This lives above the routes rather than inside one, for two reasons. It has to
 * be able to appear whichever screen is on, and some of the notes are set by a
 * route that failed to load, on its way back to the landing page, so the state
 * cannot belong to any single route's component.
 */
interface NoticeValue {
  notice: string | null
  setNotice: (message: string | null) => void
}

const NoticeContext = createContext<NoticeValue | null>(null)

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<string | null>(null)
  const value = useMemo(() => ({ notice, setNotice }), [notice])
  return <NoticeContext.Provider value={value}>{children}</NoticeContext.Provider>
}

export function useNotice(): NoticeValue {
  const value = useContext(NoticeContext)
  if (!value) throw new Error('useNotice was called outside a NoticeProvider')
  return value
}

/** The note itself, rendered by the root route so it sits over every screen. */
export function NoticeBar() {
  const { notice, setNotice } = useNotice()
  if (!notice) return null
  return (
    <div className="notice-bar" role="alert">
      <span>{notice}</span>
      <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
        ×
      </button>
    </div>
  )
}
