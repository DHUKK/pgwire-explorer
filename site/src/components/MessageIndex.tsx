import { useMemo, useState } from 'react'
import {
  DIRECTION_LABELS,
  PHASES,
  PHASE_LABELS,
  PROTOCOL_MESSAGES,
  VERSIONS,
  docsUrlFor,
  exampleFor,
  exampleRoute,
  inEveryVersion,
  isDecoded,
  summaryFor,
  versionSpan,
  versionsFor,
  type MessageDirection,
  type Release,
  type MessagePhase,
  type ProtocolMessage,
} from '../lib/protocolIndex'
import { scenarioById } from '../lib/scenarios'
import { PROTOCOL_DOCS_URL } from '../lib/docs'
import { Inline } from '../lib/inline'
import { BookIcon, GitHubIcon } from './icons'
import { REPO_URL } from './Landing'
import { ThemeToggle } from './ThemeToggle'

/**
 * Every message in the protocol, grouped by the phase it belongs to.
 *
 * A reference page rather than a capture: the explorer shows what one session
 * did, and this shows what the protocol has. The data is static reference data in
 * protocolIndex.ts, transcribed from the specification and guarded by a test
 * against the Go decoder's own list.
 *
 * the question this page is most often opened to answer, and tag `p` is the one
 * fact about the protocol a reader most needs before writing a decoder.
 */

/** The filter for direction. `any` is every message, whichever way it travels. */
type DirectionFilter = MessageDirection | 'any'

const DIRECTION_FILTERS: Array<{ value: DirectionFilter; label: string }> = [
  { value: 'any', label: 'Either' },
  { value: 'F', label: 'Frontend' },
  { value: 'B', label: 'Backend' },
]

interface Props {
  /** Back to the landing page. */
  onClose: () => void
  /** Open a shipped capture at one message. */
  onOpenExample: (route: string) => void
}

export function MessageIndex({ onClose, onOpenExample }: Props) {
  const [phase, setPhase] = useState<MessagePhase | 'all'>('all')
  const [direction, setDirection] = useState<DirectionFilter>('any')
  const [release, setRelease] = useState<Release | 'any'>('any')

  // A message travelling both ways matches either direction filter, which is why
  // this is not an equality test. CopyData and CopyDone are the two.
  //
  // The release filter asks what a given server would speak, so it keeps a
  // message when that release documents it. Picking 8.0 drops SCRAM and keeps
  // Kerberos V4, which is the point of having it.
  const matches = useMemo(
    () =>
      PROTOCOL_MESSAGES.filter(
        (message) =>
          (phase === 'all' || message.phase === phase) &&
          (direction === 'any' || message.direction === direction || message.direction === 'FB') &&
          (release === 'any' || versionsFor(message).includes(release)),
      ),
    [phase, direction, release],
  )

  return (
    <div className="landing message-index">
      <div className="landing-bar">
        {/* Back sits on the left, where the explorer puts it, rather than in the
            group on the right where it read as one more link. */}
        <div className="landing-bar-left">
          <button className="ghost-button" onClick={onClose} title="Back to the session list">
            <span aria-hidden="true">&larr;</span>
            <span className="ghost-button-label">back</span>
          </button>
          <span className="landing-brand">pgwire explorer</span>
        </div>
        <div className="landing-links">
          <a
            className="ghost-button"
            href={PROTOCOL_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            title="the protocol spec"
          >
            <BookIcon />
            <span className="ghost-button-label">the protocol spec</span>
          </a>
          <a
            className="ghost-button"
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            title="source on GitHub"
          >
            <GitHubIcon />
            <span className="ghost-button-label">source on GitHub</span>
          </a>
          <ThemeToggle />
        </div>
      </div>

      <div className="landing-inner">
        <header className="landing-header">
          <h1>
            Discover the <span className="accent">protocol messages</span>
          </h1>
          {/* The numbers are set as code, the way every other version and wire
              value on this site is. Written as elements rather than as backticks
              through Inline, because they are interpolated rather than prose. The
              class is the one renderInline emits, so they are tinted like any
              other inline code and not merely monospaced. */}
          <p className="lede">
            {PROTOCOL_MESSAGES.length} messages, from protocol{' '}
            <code className="inline-code">3.0</code> and <code className="inline-code">3.2</code>{' '}
            and PostgreSQL <code className="inline-code">{VERSIONS[0]}</code> through{' '}
            <code className="inline-code">{VERSIONS[VERSIONS.length - 1]}</code>.
          </p>
        </header>

        <section className="landing-section">
          <h2>By phase</h2>
          <p className="section-note">
            The phase a message belongs to, in the order a session moves through them.
          </p>

          <div className="mi-filters" role="group" aria-label="Filter the messages">
            <div className="mi-controls">
              <label className="mi-filter">
                <span>Phase</span>
                <select
                  value={phase}
                  onChange={(e) => setPhase(e.target.value as MessagePhase | 'all')}
                >
                  <option value="all">Every phase</option>
                  {PHASES.map((value) => (
                    <option key={value} value={value}>
                      {PHASE_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mi-filter mi-dirs" role="group" aria-label="Direction">
                <span>Direction</span>
                <div className="mi-dir-buttons">
                  {DIRECTION_FILTERS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      className={direction === value ? 'mi-dir active' : 'mi-dir'}
                      aria-pressed={direction === value}
                      onClick={() => setDirection(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="mi-filter">
                <span>Release</span>
                <select
                  value={release}
                  onChange={(e) => setRelease(e.target.value as Release | 'any')}
                >
                  <option value="any">Any release</option>
                  {[...VERSIONS].reverse().map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <span className="mi-count" role="status">
              {matches.length} of {PROTOCOL_MESSAGES.length}
            </span>
          </div>

          {matches.length === 0 && (
            <p className="mi-empty">
              No message matches that. Try a name such as <code>Bind</code>, or a single type byte.
            </p>
          )}

          {PHASES.map((value) => {
            const rows = matches.filter((m) => m.phase === value)
            if (rows.length === 0) return null
            return (
              <div key={value} className="mi-phase">
                <h3>{PHASE_LABELS[value]}</h3>
                <MessageTable rows={rows} onOpenExample={onOpenExample} />
              </div>
            )
          })}
        </section>

        <section className="landing-section" id="unsupported">
          <p className="mi-footnote">
            <Inline text={'\u002a the `pgwire-explorer` proxy does not support this message type.'} />
          </p>
        </section>
      </div>
    </div>
  )
}

function MessageTable({
  rows,
  onOpenExample,
}: {
  rows: readonly ProtocolMessage[]
  onOpenExample: (route: string) => void
}) {
  return (
    // The table is wider than a phone, so it scrolls inside its own box rather
    // than making the page scroll sideways.
    <div className="mi-table-wrap">
      <table className="mi-table">
        <thead>
          <tr>
            <th scope="col">Byte</th>
            <th scope="col">Message</th>
            <th scope="col">Dir</th>
            <th scope="col">Code</th>
            <th scope="col">Versions</th>
            <th scope="col">Example</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((message) => (
            <MessageRow key={message.name} message={message} onOpenExample={onOpenExample} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MessageRow({
  message,
  onOpenExample,
}: {
  message: ProtocolMessage
  onOpenExample: (route: string) => void
}) {
  const docs = docsUrlFor(message)
  const example = exampleFor(message.name)
  const scenario = example ? scenarioById(example.scenario) : undefined

  return (
    <tr>
      <td>
        {message.typeByte ? (
          <code className="mi-byte">{message.typeByte}</code>
        ) : (
          <span className="mi-untagged" title="No type byte: an Int32 length, then an Int32 code">
            untagged
          </span>
        )}
      </td>

      <td>
        <span className="mi-name">
          {docs ? (
            <a href={docs} target="_blank" rel="noreferrer" title="Read the specification's entry">
              {message.name}
            </a>
          ) : (
            message.name
          )}
          {!isDecoded(message.name) && (
            <a
              href="#unsupported"
              className="mi-star"
              aria-label={`${message.name} is not read by the recorder, see the note below`}
              title="Not read by the recorder. See the note below the table"
              onClick={(e) => {
                // A plain hash link here would go through the app's own
                // hash-based router, which treats "unsupported" as an
                // unrecognised route and leaves the message index rather than
                // scrolling to the footnote. Scrolling by hand keeps the
                // click from ever touching location.hash.
                e.preventDefault()
                document.getElementById('unsupported')?.scrollIntoView({ block: 'start' })
              }}
            >
              *
            </a>
          )}
        </span>
        <span className="mi-summary">
          <Inline text={summaryFor(message.name)} />
        </span>
      </td>

      <td>
        <span
          className={`mi-dir-tag dir-${message.direction}`}
          title={DIRECTION_LABELS[message.direction]}
        >
          {message.direction === 'FB' ? 'F & B' : message.direction}
        </span>
      </td>

      <td className="mi-code">{message.code === undefined ? '' : message.code}</td>

      <td className={inEveryVersion(message) ? 'mi-versions' : 'mi-versions partial'}>
        {versionSpan(message)}
      </td>

      <td>
        {example && scenario ? (
          <button
            type="button"
            className="mi-example"
            title={`Open the "${scenario.title}" example at message ${example.packet}`}
            aria-label={`Open a real ${message.name}, in the "${scenario.title}" example`}
            onClick={() => onOpenExample(exampleRoute(example))}
          >
            open
            <span aria-hidden="true"> &rarr;</span>
          </button>
        ) : (
          <span className="mi-no-example" aria-hidden="true" />
        )}
      </td>
    </tr>
  )
}
