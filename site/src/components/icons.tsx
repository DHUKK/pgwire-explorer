/**
 * Inline SVG icons, shared where more than one component needs the same mark.
 *
 * `currentColor` throughout, so an icon follows the colour of whatever it sits
 * in and needs no per-theme rule of its own.
 */

/**
 * An open book, for the Postgres docs.
 *
 * This is `menu_book` from Google's Material Symbols, which is Apache 2.0. The
 * viewBox is theirs too: Material Symbols draw from 0 to -960 on the y axis, so
 * it looks wrong next to a 0 to 16 icon but is correct as authored.
 */
/**
 * A waste bin, for deleting a saved capture.
 *
 * `delete` from the same Material Symbols set as the book below, so the two
 * marks share a weight and an optical size, and the same 0 to -960 viewBox.
 */
export function TrashIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 -960 960 960" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z" />
    </svg>
  )
}

/**
 * A bulleted list, for the message index.
 *
 * Drawn here from primitives rather than lifted from an icon set, because it is
 * three dots and three bars and that needs no licence. The 0 to 16 viewBox is the
 * GitHub mark's, not the Material one below.
 */
export function ListIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <circle cx="2.6" cy="4" r="1.3" />
      <circle cx="2.6" cy="8" r="1.3" />
      <circle cx="2.6" cy="12" r="1.3" />
      <rect x="6" y="3.2" width="8" height="1.6" rx="0.8" />
      <rect x="6" y="7.2" width="8" height="1.6" rx="0.8" />
      <rect x="6" y="11.2" width="8" height="1.6" rx="0.8" />
    </svg>
  )
}

/**
 * The GitHub mark, for linking to the repo. `currentColor` so it follows the
 * button's text colour in both themes.
 */
export function GitHubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

export function BookIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M560-564v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-600q-38 0-73 9.5T560-564Zm0 220v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-380q-38 0-73 9t-67 27Zm0-110v-68q33-14 67.5-21t72.5-7q26 0 51 4t49 10v64q-24-9-48.5-13.5T700-490q-38 0-73 9.5T560-454ZM260-320q47 0 91.5 10.5T440-278v-394q-41-24-87-36t-93-12q-36 0-71.5 7T120-692v396q35-12 69.5-18t70.5-6Zm260 42q44-21 88.5-31.5T700-320q36 0 70.5 6t69.5 18v-396q-33-14-68.5-21t-71.5-7q-47 0-93 12t-87 36v394Zm-40 118q-48-38-104-59t-116-21q-42 0-82.5 11T100-198q-21 11-40.5-1T40-234v-482q0-11 5.5-21T62-752q46-24 96-36t102-12q58 0 113.5 15T480-740q51-30 106.5-45T700-800q52 0 102 12t96 36q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-60 0-116 21t-104 59ZM280-494Z" />
    </svg>
  )
}
