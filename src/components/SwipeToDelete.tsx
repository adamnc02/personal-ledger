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
function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest('select, input, textarea, button, a, label, [role="button"]')
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
