import { useEffect, useState } from 'react'

/**
 * TEMPORARY diagnostic component — not a permanent UI feature. Renders a
 * plain-text block of real getBoundingClientRect() measurements for a set
 * of named elements (passed as refs), plus the device's userAgent, so a
 * person can screenshot it directly from the device where a rendering
 * bug is actually showing (confirmed iOS-only, not reproducible in a
 * standard dev-server browser) and report the real numbers back rather
 * than have the numbers guessed at from a screenshot alone.
 *
 * Usage: create refs for whatever elements are suspect, attach them,
 * pass a name -> ref map here. Remove this component and its call sites
 * entirely once the real bug is found and fixed — it has no reason to
 * ship as a permanent feature.
 */
export function DebugMeasurements({
  refs,
  selectorMap,
  label,
}: {
  refs?: Record<string, React.RefObject<HTMLElement | null>>
  selectorMap?: Record<string, string>
  label: string
}) {
  const [text, setText] = useState('')

  useEffect(() => {
    const lines: string[] = [`${label} — measured at ${new Date().toISOString()}`, `UA: ${navigator.userAgent}`, `devicePixelRatio: ${window.devicePixelRatio}`, `viewport: ${window.innerWidth}x${window.innerHeight}`, '']

    function measure(name: string, el: HTMLElement | null) {
      if (!el) {
        lines.push(`${name}: not mounted`)
        return
      }
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      lines.push(
        `${name}: top=${r.top.toFixed(1)} left=${r.left.toFixed(1)} width=${r.width.toFixed(1)} height=${r.height.toFixed(1)} | font-size=${cs.fontSize} line-height=${cs.lineHeight} padding=${cs.padding} box-sizing=${cs.boxSizing} flex-shrink=${cs.flexShrink} min-width=${cs.minWidth} white-space=${cs.whiteSpace}`,
      )
    }

    for (const [name, ref] of Object.entries(refs ?? {})) measure(name, ref.current)
    for (const [name, selector] of Object.entries(selectorMap ?? {})) measure(name, document.querySelector<HTMLElement>(selector))

    setText(lines.join('\n'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="rounded-lg p-2 mt-2 col-span-2" style={{ background: '#000', border: '1px solid #f00' }}>
      <p className="text-[10px] font-semibold mb-1" style={{ color: '#f66' }}>
        DEBUG — screenshot this box and send it back
      </p>
      <pre className="text-[9px] whitespace-pre-wrap" style={{ color: '#9f9', fontFamily: 'monospace' }}>
        {text}
      </pre>
    </div>
  )
}
