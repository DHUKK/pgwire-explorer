import { useCallback, useEffect, useState } from 'react'

/**
 * Theme is one of three states, not two. "system" follows the OS, which is the
 * right default and the thing a two-way toggle takes away permanently: once you
 * flip it, you can never get back to following the OS.
 */
export type Theme = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'pgwire-theme'
const ORDER: Theme[] = ['system', 'light', 'dark']

const LABELS: Record<Theme, { icon: string; title: string }> = {
  system: { icon: '◐', title: 'Theme: following the system' },
  light: { icon: '☀', title: 'Theme: light' },
  dark: { icon: '☾', title: 'Theme: dark' },
}

function stored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Private browsing can deny localStorage. Fall back to the system theme.
  }
  return 'system'
}

/**
 * Applies the theme by stamping `data-theme` on the root element, which the token
 * blocks in styles.css select on. "system" removes the attribute so the
 * prefers-color-scheme media query takes over again.
 */
function apply(theme: Theme) {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.dataset.theme = theme
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(stored)

  useEffect(() => {
    apply(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // Not being able to remember the choice is not worth failing over.
    }
  }, [theme])

  const cycle = useCallback(() => {
    setTheme((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]!)
  }, [])

  const { icon, title } = LABELS[theme]

  return (
    <button className="ghost-button theme-toggle" onClick={cycle} title={`${title}. Click to change.`}>
      <span className="theme-toggle-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sr-only">{title}</span>
    </button>
  )
}
