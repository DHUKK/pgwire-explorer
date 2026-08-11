import { Fragment, type ReactNode } from 'react'

/**
 * Renders backtick spans in prose as code, the way markdown does.
 *
 * The explanatory text is full of things that are literally code: message names,
 * byte values, wire numbers, SQLSTATEs, type OIDs. Set in the body font they read
 * as ordinary words, so `SSLRequest` and `42P01` are marked up at the source and
 * rendered in the monospace face here.
 *
 * Backticks are the only markup understood. There is no nesting, no escaping and
 * no other syntax, because the alternative is shipping a markdown parser to style
 * a dozen nouns.
 */
export function renderInline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`)/g)
    .filter((part) => part !== '')
    .map((part, i) =>
      part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
        <code className="inline-code" key={i}>
          {part.slice(1, -1)}
        </code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    )
}

/** renderInline as a component, for use directly in JSX. */
export function Inline({ text }: { text: string }) {
  return <>{renderInline(text)}</>
}
