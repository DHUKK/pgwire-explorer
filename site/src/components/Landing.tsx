import { useCallback, useRef, useState } from 'react'
import { SCENARIOS, SCENARIO_GROUPS } from '../lib/scenarios'
import { formatFileSize, formatSavedAt, type SavedCaptureMeta } from '../lib/savedCaptures'
import { Inline } from '../lib/inline'
import { PROTOCOL_DOCS_URL } from '../lib/docs'
import { BookIcon, GitHubIcon, ListIcon, TrashIcon } from './icons'
import { PROTOCOL_MESSAGES, VERSIONS } from '../lib/protocolIndex'
import { ThemeToggle } from './ThemeToggle'

interface Props {
  loadingId: string | null
  onPickScenario: (id: string) => void
  onPickFile: (file: File) => void
  savedCaptures: SavedCaptureMeta[]
  onOpenSaved: (name: string) => void
  onDeleteSaved: (name: string) => void
  /** Open the index of every message in the protocol. */
  onOpenMessageIndex: () => void
}

export const REPO_URL = 'https://github.com/DHUKK/pgwire-explorer'

// The proxy defaults to listening on 5433 and forwarding to 5432, so the common
// case needs no flags beyond the output file.
const RECORD_COMMAND = 'go run ./cmd/pgwire-capture --out cap.json'

export function Landing({
  loadingId,
  onPickScenario,
  onPickFile,
  savedCaptures,
  onOpenSaved,
  onDeleteSaved,
  onOpenMessageIndex,
}: Props) {
  const [dragging, setDragging] = useState(false)
  const [copied, setCopied] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files[0]
      if (file) onPickFile(file)
    },
    [onPickFile],
  )

  // A confirmation, not just spacing, guards a destructive action that sits
  // right next to an everyday one: a misclick that opens the wrong capture
  // costs nothing, a misclick that deletes one is permanent.
  const handleDelete = useCallback(
    (name: string) => {
      if (window.confirm(`Delete "${name}"? This only removes it from this browser.`)) {
        onDeleteSaved(name)
      }
    },
    [onDeleteSaved],
  )

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(RECORD_COMMAND)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard access can be denied. The command is selectable either way.
    }
  }, [])

  return (
    <div className="landing">
      {/* A bar across the page rather than a cluster of links floating above the
          headline, which is where these used to sit and read as a stray toolbar.
          The wordmark on the left gives it something to be. */}
      <div className="landing-bar">
        <span className="landing-brand">pgwire explorer</span>
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
            Explore the <span className="accent">Postgres wire protocol</span>
          </h1>
          <p className="lede">
            Every Postgres client talks to the server over a binary protocol that is thoroughly
            documented and almost never seen. This site shows real recorded sessions, one message
            at a time, with every byte of every packet mapped to the field that produced it.
          </p>
          <p className="lede lede-more">
            <Inline
              text={
                'Useful for writing a driver, a pooler or a proxy, for debugging a connection that ' +
                'fails before any SQL runs, or for finally seeing what `psql` sends when you type ' +
                '`SELECT 1`.'
              }
            />
          </p>
        </header>

        {/* Its own block rather than a link in the bar above, where it sat between
            the spec link and the theme switch and read as part of the furniture.
            Here it is the second thing on the page, which is what it is. */}
        <button type="button" className="landing-index-link" onClick={onOpenMessageIndex}>
          <span className="landing-index-icon" aria-hidden="true">
            <ListIcon size={18} />
          </span>
          <span className="landing-index-text">
            <span className="landing-index-title">
              Discover the protocol messages
              <span className="landing-index-arrow" aria-hidden="true">
                {' '}
                &rarr;
              </span>
            </span >
            <span className="landing-index-sub">
              {PROTOCOL_MESSAGES.length}, from protocol{' '}
              <code className="inline-code">3.0</code> and <code className="inline-code">3.2</code>{' '}
              and PostgreSQL <code className="inline-code">{VERSIONS[0]}</code> through{' '}
              <code className="inline-code">{VERSIONS[VERSIONS.length - 1]}</code>
            </span>
          </span>
        </button>

        <section className="landing-section">
          <h2>Start with an example</h2>
          <p className="section-note">
            Each example is a full session recording, with the messages it focuses on{' '}
            <span className="key-mark">highlighted</span>
          </p>

          {SCENARIO_GROUPS.map((group) => {
            const scenarios = SCENARIOS.filter((s) => s.group === group)
            if (scenarios.length === 0) return null
            return (
              <div key={group} className="scenario-group">
                <h3>{group}</h3>
                <div className="scenario-grid">
                  {scenarios.map((scenario) => (
                    <button
                      key={scenario.id}
                      className="scenario-card"
                      onClick={() => onPickScenario(scenario.id)}
                      disabled={loadingId !== null}
                      aria-busy={loadingId === scenario.id}
                    >
                      <span className="scenario-title">{scenario.title}</span>
                      <span className="scenario-blurb">
                        <Inline text={scenario.blurb} />
                      </span>
                      {/* The messages the capture exists to show. The blurb says
                          what the exchange is, and this says what to look for in
                          the list. */}
                      <span className="scenario-teaches">
                        {scenario.teaches.map((name) => (
                          <span key={name} className="scenario-teaches-item">
                            {name}
                          </span>
                        ))}
                      </span>
                      {loadingId === scenario.id && (
                        <span className="scenario-loading">loading…</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}
        </section>

        <section className="landing-section">
          <h2>Or explore your own traffic</h2>
          <p className="section-note">
            The proxy sits between your client and your database and relays every byte untouched.
            Clone{' '}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              the repo
            </a>
            , then point your client at port <Inline text="`5433` instead of `5432`" />.
          </p>

          <ol className="steps">
            <li>
              <span className="step-label">Start the proxy</span>
              <div className="command-row">
                <code>{RECORD_COMMAND}</code>
                <button className="ghost-button" onClick={copyCommand}>
                  {copied ? 'copied' : 'copy'}
                </button>
              </div>
            </li>
            <li>
              <span className="step-label">Connect through it</span>
              <code>psql -h localhost -p 5433</code>
            </li>
            <li>
              <span className="step-label">Stop the proxy</span>
              <span className="step-text">
                <kbd>Ctrl</kbd>+<kbd>C</kbd> writes the capture.
              </span>
            </li>
          </ol>

          <div
            className={dragging ? 'dropzone dragging' : 'dropzone'}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click()
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) onPickFile(file)
                e.target.value = ''
              }}
            />
            <strong>Drop your capture here</strong>
            <span>or click to choose a file</span>
            <span className="dropzone-note">
              Parsed entirely in your browser. Nothing is uploaded anywhere.
            </span>
          </div>

          {savedCaptures.length > 0 && (
            <div className="saved-captures">
              <h3>Saved in this browser</h3>
              <p className="saved-note">
                Captures you open are kept in this browser only. Delete one below to remove it.
              </p>
              <ul className="saved-list">
                {savedCaptures.map((entry) => (
                  <li key={entry.name} className="saved-row">
                    <button
                      type="button"
                      className="saved-open"
                      onClick={() => onOpenSaved(entry.name)}
                      title={`Open "${entry.name}"`}
                    >
                      <span className="saved-name">{entry.name}</span>
                      <span className="saved-meta">
                        {entry.sessionCount} session{entry.sessionCount === 1 ? '' : 's'} ·{' '}
                        {entry.packetCount} message{entry.packetCount === 1 ? '' : 's'} ·{' '}
                        {formatFileSize(entry.size)} · saved {formatSavedAt(entry.savedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="saved-delete"
                      onClick={() => handleDelete(entry.name)}
                      aria-label={`Delete saved capture "${entry.name}"`}
                      title={`Delete "${entry.name}"`}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
