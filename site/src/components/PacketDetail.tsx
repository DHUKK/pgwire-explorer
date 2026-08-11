import { useMemo, useState } from 'react'
import type { FieldAnnotation, PacketRecord } from '../types'
import { docForTypeName, CATEGORY_LABELS } from '../lib/messages'
import { Inline } from '../lib/inline'
import { flattenFields, isEmptyRange } from '../lib/hex'
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
  const doc = docForTypeName(packet.type_name)
  const rows = useMemo(
    () => flattenFields(packet.fields ?? [], collapsed),
    [packet.fields, collapsed],
  )

  // Hover wins over selection for highlighting, so sweeping the mouse down the
  // tree sweeps the highlight through the dump without destroying the selection.
  const activePath = hoveredPath ?? selectedFieldPath
  const activeRange = useMemo(() => {
    const row = rows.find((r) => r.path === activePath)
    if (!row || isEmptyRange(row.field)) return null
    return row.field.bytes
  }, [rows, activePath])

  return (
    <div className="panel detail-panel">
      <div className="panel-head">
        <h2>
          {packet.type_name}
          {packet.type_char && <code className="type-char">{packet.type_char}</code>}
        </h2>
        <span className={`category-chip cat-${doc.category}`}>{CATEGORY_LABELS[doc.category]}</span>
      </div>

      <div className="detail-scroll">
        <section className="doc-block">
          <p className="doc-summary">
            <Inline text={doc.summary} />
          </p>
          {doc.detail && (
            <p className="doc-detail">
              <Inline text={doc.detail} />
            </p>
          )}
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
        </section>

        <section className="fields-block">
          <h3>
            Fields
            <span className="hint">click a row to pin it, or click bytes below</span>
          </h3>

          {rows.length === 0 ? (
            <p className="empty-note">This message has no annotated fields.</p>
          ) : (
            <ul className="field-tree" onMouseLeave={() => setHoveredPath(null)}>
              {rows.map((row) => {
                const { field, depth, path, hasChildren } = row
                const empty = isEmptyRange(field)
                const isActive = path === activePath
                return (
                  <li key={path}>
                    <div
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

        <section className="hex-block">
          <h3>
            Raw bytes
            <span className="hint">
              {activeRange
                ? `highlighting ${activeRange[0]}-${activeRange[1]}`
                : 'hover a field above'}
            </span>
          </h3>
          <HexDump hex={packet.raw_hex} highlight={activeRange} onSelectByte={onSelectByte} />
        </section>
      </div>
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
