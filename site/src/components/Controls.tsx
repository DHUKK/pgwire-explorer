import { Scrubber } from './Scrubber'
import type { Range } from '../lib/highlight'

interface Props {
  onStep: (delta: number) => void
  onSeek: (index: number) => void
  index: number
  total: number
  /** Stretches this scenario exists to show. Drawn as bands on the track. */
  ranges: readonly Range[]
}

/**
 * Stepping through the session, and a scrubber for jumping.
 *
 * There is no play button. Replaying at the session's real timing sounded good
 * and was useless in practice: a capture is over in milliseconds, so it finished
 * before anything could be read, and stepping is what people actually do.
 *
 * The arrows point up and down rather than left and right, because the list they
 * move through is vertical, and sideways triangles next to a scrubber read as a
 * media player.
 */
export function Controls({ onStep, onSeek, index, total, ranges }: Props) {
  const atStart = index === 0
  const atEnd = index >= total - 1

  return (
    <div className="controls">
      <div className="transport">
        <button
          className="transport-button"
          onClick={() => onStep(-1)}
          disabled={atStart}
          title="Previous message (↑ or k)"
        >
          ↑
        </button>
        <button
          className="transport-button"
          onClick={() => onStep(1)}
          disabled={atEnd}
          title="Next message (↓ or j)"
        >
          ↓
        </button>
      </div>

      <Scrubber index={index} total={total} ranges={ranges} onSeek={onSeek} />
    </div>
  )
}
