import type { FieldAnnotation } from '../types'

/**
 * Nibble value per character code, so decoding is two table reads and a shift
 * rather than a substring and a parse.
 *
 * The version this replaced called `hex.slice(i * 2, i * 2 + 2)` per byte, which
 * allocated a two-character string for every byte in the packet. A 20MB `CopyData`
 * meant 20 million short-lived strings, and the garbage that produced was the
 * stutter, more than the arithmetic was. Same input, about a tenth of the time.
 *
 * Non-hex characters read as 0. Input is validated when the capture is parsed,
 * so this never has to report an error it cannot do anything about.
 */
const NIBBLE = (() => {
  const table = new Uint8Array(128)
  for (let i = 0; i < 10; i++) table[48 + i] = i // '0' to '9'
  for (let i = 0; i < 6; i++) {
    table[97 + i] = 10 + i // 'a' to 'f'
    table[65 + i] = 10 + i // 'A' to 'F'
  }
  return table
})()

/** Decodes a hex string into bytes. Input is already validated. */
export function hexToBytes(hex: string): Uint8Array {
  return decodeHexRange(hex, 0, hex.length / 2)
}

/**
 * Decodes `count` bytes starting at byte `start`, without touching the rest of
 * the string.
 *
 * This is what keeps a large packet cheap. Hex is fixed width at two characters
 * per byte, so byte `n` begins at character `2n` with nothing to scan past, and
 * the hex dump can decode just the rows it has mounted. Decoding a whole 20MB
 * packet to draw fifty rows of it cost half a second per selection.
 *
 * The range is clamped, so a window running past the end of the packet returns
 * only the bytes that exist rather than trailing zeroes.
 */
export function decodeHexRange(hex: string, start: number, count: number): Uint8Array {
  const total = hex.length / 2
  const first = Math.max(0, Math.min(start, total))
  const length = Math.max(0, Math.min(count, total - first))

  const bytes = new Uint8Array(length)
  for (let i = 0, j = first * 2; i < length; i++, j += 2) {
    bytes[i] = (NIBBLE[hex.charCodeAt(j)]! << 4) | NIBBLE[hex.charCodeAt(j + 1)]!
  }
  return bytes
}

/** Two-digit lowercase hex. */
export function byteToHex(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

/**
 * The character to show for a byte in the ASCII gutter of a hex dump. Anything
 * outside printable ASCII becomes a dot, as in every other hex viewer. The point
 * of the gutter is to make embedded strings jump out.
 */
export function byteToPrintable(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '·'
}

/**
 * A flat list of every field in the tree, each tagged with its depth and the
 * path that identifies it.
 *
 * The tree is rendered as rows rather than nested elements so that keyboard
 * navigation, selection and byte-range lookup all operate on one ordered list.
 */
export interface FlatField {
  field: FieldAnnotation
  depth: number
  /** Stable identity: the index path from the root, e.g. "2.0.1". */
  path: string
  /** True when this field has children, so the row can be collapsible. */
  hasChildren: boolean
}

export function flattenFields(
  fields: FieldAnnotation[],
  collapsed: ReadonlySet<string>,
  depth = 0,
  prefix = '',
): FlatField[] {
  const rows: FlatField[] = []
  fields.forEach((field, i) => {
    const path = prefix === '' ? String(i) : `${prefix}.${i}`
    const children = field.children ?? []
    rows.push({ field, depth, path, hasChildren: children.length > 0 })
    if (children.length > 0 && !collapsed.has(path)) {
      rows.push(...flattenFields(children, collapsed, depth + 1, path))
    }
  })
  return rows
}

/** True when a field annotates no bytes, encoded as `end === start-1`. */
export function isEmptyRange(field: FieldAnnotation): boolean {
  return field.bytes[1] < field.bytes[0]
}

/**
 * The most specific field covering `offset`, meaning the deepest one. Clicking a
 * byte inside a RowDescription column selects that column's type OID rather than
 * the whole message.
 *
 * Returns its path so the caller can select and reveal it.
 */
export function fieldAtOffset(
  fields: FieldAnnotation[],
  offset: number,
  prefix = '',
): { field: FieldAnnotation; path: string } | null {
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    const [start, end] = field.bytes
    if (end < start) continue // empty range covers nothing
    if (offset < start || offset > end) continue

    const path = prefix === '' ? String(i) : `${prefix}.${i}`
    const deeper = fieldAtOffset(field.children ?? [], offset, path)
    return deeper ?? { field, path }
  }
  return null
}

/**
 * The field a path names, or null if the path does not resolve.
 *
 * `fieldAtOffset` hands back a field together with its path, but selection is
 * held as a path on its own, and a path outlives the row that produced it:
 * collapsing an ancestor drops the row from the flattened list without clearing
 * the selection. Resolving against the tree rather than against the visible
 * rows is what keeps a field's bytes highlighted while its own row is collapsed
 * out of sight.
 */
export function fieldAtPath(fields: FieldAnnotation[], path: string): FieldAnnotation | null {
  if (path === '') return null

  let current: FieldAnnotation | undefined
  let level = fields
  for (const part of path.split('.')) {
    const index = Number(part)
    if (!Number.isInteger(index) || index < 0) return null
    current = level[index]
    if (!current) return null
    level = current.children ?? []
  }
  return current ?? null
}

/** Every ancestor path of `path`, so the tree can expand to reveal it. */
export function ancestorPaths(path: string): string[] {
  const parts = path.split('.')
  const result: string[] = []
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i).join('.'))
  }
  return result
}

/** Milliseconds rendered at a sensible precision for a protocol timeline. */
export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
