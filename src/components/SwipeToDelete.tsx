import { useRef, useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'

interface SwipeToDeleteProps {
  children: ReactNode
  onDelete: () => void
  /** Shown in a native confirm() before actually deleting — pass a short description, e.g. "Car loan". */
  confirmLabel?: string
}

const REVEAL_WIDTH = 84

// Tapping a native form control (a <select> especially) inside a swipeable
// row must NOT start the swipe-capture gesture — a <select> hands control
// to the OS's own dropdown/picker UI, and pointer capture doesn't cleanly
// resolve once that happens, leaving every subsequent tap anywhere on the
// page misrouted back through this row's pointer handlers (symptom: every
// click re-opens/closes whatever dropdown was last touched). Skip capture
// entirely for taps that land on or inside any interactive control.
//
// `target instanceof Element`, NOT `HTMLElement` — an icon-only button's
// actual pointerdown target is near-always the icon's own <svg>/<path>,
// which is an SVGElement, NOT an HTMLElement (a real, separate branch of
// the DOM class hierarchy). The narrower check silently failed for every
// icon-only button in a swipeable row — confirmed directly as the root
// cause of two real bugs: the loan ledger's info-icon button doing nothing
// on tap, and the calibration modal's icon-only close button not closing
// it. The second one is the more surprising confirmation this fix is
// right: that modal is portalled to document.body, nowhere near this
// component in the real DOM — but React bubbles synthetic events through
// the REACT tree a portal's content logically belongs to, not the DOM
// tree it's rendered into, so this row's own pointerdown handler genuinely
// fires (and, before this fix, wrongly captured the pointer) for a tap
// inside a modal that visually has nothing to do with this row at all.
// `Element.closest` exists identically on both HTML and SVG elements, so
// broadening this one check is the entire fix — nothing else here needs
// to change.
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('select, input, textarea, button, a, label, [role="button"]')
}

export function SwipeToDelete({ children, onDelete, confirmLabel }: SwipeToDeleteProps) {
  const startX = useRef<number | null>(null)
  const startOffset = useRef(0)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)

  function handlePointerDown(e: React.PointerEvent) {
    if (isInteractiveTarget(e.target)) return
    startX.current = e.clientX
    startOffset.current = offset
    setDragging(true)
    // Capture on currentTarget (this wrapper div), not e.target — target
    // could be any nested descendant, and capturing there is both less
    // correct and part of what made the select-interaction bug above
    // possible in the first place.
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (startX.current === null) return
    const delta = e.clientX - startX.current
    const next = Math.min(0, Math.max(-REVEAL_WIDTH, startOffset.current + delta))
    setOffset(next)
  }

  function handlePointerUp() {
    if (startX.current === null) return
    setDragging(false)
    startX.current = null
    // Snap open if dragged more than halfway, otherwise snap closed
    setOffset(offset < -REVEAL_WIDTH / 2 ? -REVEAL_WIDTH : 0)
  }

  function handleDeleteTap() {
    if (confirmLabel && !window.confirm(`Delete ${confirmLabel}? This can't be undone.`)) return
    onDelete()
  }

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <button
        onClick={handleDeleteTap}
        className="absolute top-0 right-0 h-full flex items-center justify-center"
        style={{ width: REVEAL_WIDTH, background: 'var(--color-negative)' }}
      >
        <Trash2 size={18} color="#fff" />
      </button>
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
          touchAction: 'pan-y',
        }}
      >
        {children}
      </div>
    </div>
  )
}
