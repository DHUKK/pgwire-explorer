import { useCallback, useEffect, useRef, useState } from 'react'

import { bandPercent, type Range } from '../lib/highlight'

interface Props {
  index: number
  total: number
  /** Stretches worth marking on the track. Drawn as bands. */
  ranges: readonly Range[]
  onSeek: (index: number) => void
}

/**
 * Position in the session, as a track that can be clicked and dragged.
 *
 * Built rather than using `<input type="range">` for two reasons. A native
 * thumb's position comes from its value, not from a CSS property, so it cannot be
 * transitioned and jumped between packets when stepping. And the highlight bands
 * belong inside the track, which would mean styling vendor pseudo-elements
 * differently per browser.
 *
 * The transition is disabled while dragging, or the thumb lags behind the
 * pointer, and honoured only when the reader has not asked for reduced motion.
 *
 * Keyboard handling stays in Explorer, which already binds the arrows, `j`, `k`,
 * Home and End globally. This element is focusable and carries the slider ARIA
 * roles so the same keys work when it has focus.
 */
export function Scrubber({ index, total, ranges, onSeek }: Props) {
  const track = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const last = Math.max(0, total - 1)
  const pct = last === 0 ? 0 : (index / last) * 100

  /** Maps a clientX to the nearest packet index. */
  const indexAt = useCallback(
    (clientX: number) => {
      const box = track.current?.getBoundingClientRect()
      if (!box || box.width === 0) return 0
      const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
      return Math.round(ratio * last)
    },
    [last],
  )

  // Drag is tracked on the window, so the pointer can leave the track without
  // the gesture breaking.
  useEffect(() => {
    if (!dragging) return
    const move = (e: PointerEvent) => onSeek(indexAt(e.clientX))
    const up = () => setDragging(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragging, indexAt, onSeek])

  return (
    <div className="scrubber">
      <div
        className={dragging ? 'scrub-track dragging' : 'scrub-track'}
        ref={track}
        onPointerDown={(e) => {
          e.preventDefault()
          setDragging(true)
          onSeek(indexAt(e.clientX))
        }}
        role="slider"
        tabIndex={0}
        aria-label="Position in session"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={index + 1}
      >
        <div className="scrub-fill" style={{ width: `${pct}%` }} />

        {/* One band per range, so a run of interesting messages reads as a
            region rather than a row of ticks. Above the fill, so they stay
            visible on both sides of the thumb. Decorative: the same information
            is on the rows.

            Each band spans the slots its packets own, so one highlighted packet
            in a one-packet session covers the whole track instead of vanishing.
            See bandPercent. */}
        {ranges.map((range) => {
          const { left, width } = bandPercent(range, total)
          return (
            <span
              key={`${range[0]}-${range[1]}`}
              className="scrub-band"
              style={{
                // A one-packet range has no width of its own, so it gets a
                // floor, and the left edge is pulled back far enough for that
                // floor to fit. Without that, a range on the very last packet
                // would start at 100 percent and be drawn off the end.
                left: `min(${left}%, calc(100% - 0.5rem))`,
                width: `max(0.5rem, ${width}%)`,
              }}
              aria-hidden="true"
            />
          )
        })}

        <div className="scrub-thumb" style={{ left: `${pct}%` }} />
      </div>

      <span className="scrubber-label">
        {index + 1} / {total}
      </span>
    </div>
  )
}
