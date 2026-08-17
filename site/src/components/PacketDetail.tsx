import { useEffect, useMemo, useRef, useState } from 'react'
import type { FieldAnnotation, PacketRecord } from '../types'
import { docForTypeName, CATEGORY_LABELS } from '../lib/messages'
import { docsUrlForTypeName } from '../lib/docs'
import { BookIcon } from './icons'
import { Inline } from '../lib/inline'
import { ancestorPaths, fieldAtOffset, fieldAtPath, flattenFields, isEmptyRange } from '../lib/hex'
import { HexDump } from './HexDump'

interface Props {
  packet: PacketRecord
  selectedFieldPath: string | null
  onSelectField: (path: string | null) => void
  onSelectByte: (offset: number) => void
  collapsed: ReadonlySet<string>
  onToggleCollapsed: (path: string) => void
}

export function PacketDetail({
  packet,
  selectedFieldPath,
  onSelectField,
  onSelectByte,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  const [hoveredByte, setHoveredByte] = useState<number | null>(null)
  const doc = docForTypeName(packet.type_name)
  const specUrl = docsUrlForTypeName(packet.type_name)
  const rows = useMemo(
    () => flattenFields(packet.fields ?? [], collapsed),
    [packet.fields, collapsed],
  )

  // The field under the pointer in the dump. Every byte belongs to exactly one
  // innermost field, which is what makes hovering one able to answer "what is
  // this?" without a click.
  const hoveredByteField = useMemo(
    () => (hoveredByte === null ? null : fieldAtOffset(packet.fields ?? [], hoveredByte)),
    [packet.fields, hoveredByte],
  )

  // Hover wins over selection for highlighting, so sweeping the mouse through
  // either pane sweeps the highlight without destroying the pinned field. The
  // two hovers cannot both be live, since leaving either pane clears its own.
  const activePath = hoveredPath ?? hoveredByteField?.path ?? selectedFieldPath

  // Resolved against the tree, not against `rows`. A path outlives the row that
  // produced it: collapsing an ancestor takes the row off screen, and the bytes
  // of the field it named should stay highlighted rather than silently stop.
  const activeField = useMemo(
    () => (activePath === null ? null : fieldAtPath(packet.fields ?? [], activePath)),
    [packet.fields, activePath],
  )
  const activeRange = activeField && !isEmptyRange(activeField) ? activeField.bytes : null

  // Which row to mark. Usually the active field's own, but when that field is
  // collapsed out of sight this is the deepest ancestor still on screen, so
  // hovering a byte inside a collapsed subtree marks the row that contains it
  // instead of marking nothing at all.
  const rowPaths = useMemo(() => new Set(rows.map((r) => r.path)), [rows])
  const activeRowPath = useMemo(() => {
    if (activePath === null) return null
    if (rowPaths.has(activePath)) return activePath
    const ancestors = ancestorPaths(activePath)
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (rowPaths.has(ancestors[i]!)) return ancestors[i]!
    }
    return null
  }, [activePath, rowPaths])

  /**
   * The reverse of HexDump's own reveal: hovering a byte brings that byte's field
   * row into view, so the answer to "what is this?" is never scrolled out of
   * sight in a tree taller than its pane.
   *
   * Only while the dump is what is driving, which is what `hoveredByte` tells
   * us. Hovering a field row must never scroll the list the pointer is already
   * resting on, and that is the same guard, from the other side, as the `reveal`
   * prop passed to HexDump below.
   *
   * Scrolls the tree itself rather than calling `scrollIntoView`, which would
   * also scroll every scrollable ancestor. Below the responsive breakpoint
   * `.explorer-body` is one of those, so the page would move too. Comparing
   * rectangles needs no assumption about which element the row is positioned
   * against, and no padding arithmetic.
   */
  const treeRef = useRef<HTMLUListElement>(null)
  const activeRowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (hoveredByte === null) return
    const list = treeRef.current
    const row = activeRowRef.current
    if (!list || !row) return

    const listBox = list.getBoundingClientRect()
    const rowBox = row.getBoundingClientRect()
    if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top
    else if (rowBox.bottom > listBox.bottom) list.scrollTop += rowBox.bottom - listBox.bottom
  }, [activeRowPath, hoveredByte])

  return (
    <div className="panel detail-panel">
      <div className="panel-head">
        <h2>
          {packet.type_name}
          {/* Beside the name, because the name is what the reader wants to look
              up. Outlined and labelled rather than a bare icon: an icon alone
              did not read as something to click. */}
          {specUrl && (
            <a
              className="spec-link"
              href={specUrl}
              target="_blank"
              rel="noreferrer"
              title="Postgres docs"
              aria-label={`${packet.type_name} in the Postgres docs`}
            >
              <BookIcon size={13} />
              docs
            </a>
          )}
          {packet.type_char && <code className="type-char">{packet.type_char}</code>}
        </h2>

        {/* In the head row rather than under the summary. These three are short,
            fixed labels, and the row had a wide empty middle while they sat in a
            boxed strip taking a whole line of the panel to themselves. */}
        <dl className="doc-facts">
          <div>
            <dt>Sender</dt>
            <dd>
              {doc.sender === 'frontend'
                ? 'client (frontend)'
                : doc.sender === 'backend'
                  ? 'server (backend)'
                  : 'either side'}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{packet.length} bytes</dd>
          </div>
          <div>
            <dt>Stream offset</dt>
            <dd>{packet.stream_offset}</dd>
          </div>
        </dl>

        <span className={`category-chip cat-${doc.category}`}>{CATEGORY_LABELS[doc.category]}</span>
      </div>

      {/* Three regions, not one scroll area. What the message is stays put as the
          context for reading everything below. The fields and the bytes each
          scroll on their own. */}
      <section className="doc-block">
        <p className="doc-summary">
          <Inline text={doc.summary} />
        </p>
        {doc.detail && (
          <p className="doc-detail">
            <Inline text={doc.detail} />
          </p>
        )}
      </section>

      <section className="fields-block">
        <h3>
          Fields
          <span className="hint">click a row to pin it, or click bytes below</span>
        </h3>

        {rows.length === 0 ? (
          <p className="empty-note">This message has no annotated fields.</p>
        ) : (
          <ul className="field-tree" ref={treeRef} onMouseLeave={() => setHoveredPath(null)}>
            {rows.map((row) => {
              const { field, depth, path, hasChildren } = row
              const empty = isEmptyRange(field)
              const isActive = path === activeRowPath
              return (
                <li key={path}>
                  <div
                    ref={isActive ? activeRowRef : undefined}
                    className={isActive ? 'field-row active' : 'field-row'}
                    style={{ paddingLeft: `${depth * 1.1 + 0.5}rem` }}
                    onMouseEnter={() => setHoveredPath(path)}
                    onClick={() => onSelectField(path === selectedFieldPath ? null : path)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onSelectField(path)
                    }}
                  >
                    {hasChildren ? (
                      <button
                        className="field-twisty"
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleCollapsed(path)
                        }}
                        aria-label={collapsed.has(path) ? 'Expand' : 'Collapse'}
                      >
                        {collapsed.has(path) ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span className="field-twisty placeholder" />
                    )}

                    <span className="field-name">{field.name}</span>
                    <FieldValue field={field} />
                    <span className="field-bytes">
                      {empty ? 'none' : `${field.bytes[0]}-${field.bytes[1]}`}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* A message with many fields used to push the bytes out of sight, so
          reaching them scrolled the field tree away, and the two representations
          this view exists to link could not both be on screen at once. */}
      <section className="hex-block">
        <h3>
          Raw bytes
          {/* Naming the hovered byte's field is the whole point of hovering
              one. This line used to read "hover a field above" for as long as
              the pointer was anywhere in the dump, which was exactly when it
              had something to say. */}
          <span className="hint">
            {hoveredByteField
              ? `byte ${hoveredByte} is ${hoveredByteField.field.name}`
              : activeRange
                ? `highlighting ${activeRange[0]}-${activeRange[1]}`
                : 'hover a field above, or a byte below'}
          </span>
        </h3>
        <HexDump
          hex={packet.raw_hex}
          highlight={activeRange}
          onSelectByte={onSelectByte}
          onHoverByte={setHoveredByte}
          reveal={hoveredByte === null}
        />
      </section>
    </div>
  )
}

/**
 * A field's value, with long ones truncated for the row but kept in full in the
 * title so nothing is actually hidden. Numbers and strings are styled apart
 * because "5" the length and "5" the text are different things when reading a
 * protocol.
 */
function FieldValue({ field }: { field: FieldAnnotation }) {
  if (field.value === undefined || field.value === null) {
    return <span className="field-value none" />
  }

  const text = String(field.value)
  const truncated = text.length > 120 ? `${text.slice(0, 120)}…` : text
  const kind = typeof field.value === 'number' ? 'number' : 'text'

  return (
    <span className={`field-value ${kind}`} title={text.length > 120 ? text : undefined}>
      {truncated === '' ? <em className="empty-string">(empty)</em> : truncated}
    </span>
  )
}
