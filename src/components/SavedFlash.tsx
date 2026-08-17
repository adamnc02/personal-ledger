import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'

// ── Shared "collapse + flash green" save feedback ──────────────────────────
// Used anywhere a row/card has a Save button: on save, the row collapses and
// briefly flashes a solid green fill (--color-positive) with a check mark
// and "Saved" in white, instead of a static inline "Saved." text. Keeps the
// feedback consistent across Bills, pay periods, Loans, and Savings.

export function useSavedFlash(duration = 1300) {
  const [active, setActive] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  function trigger() {
    setActive(true)
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setActive(false), duration)
  }

  return { active, trigger }
}

// Absolutely-positioned overlay — place inside a `relative` (and ideally
// `overflow-hidden`) container that already has the corner radius you want
// the flash to respect.
export function SavedFlashOverlay({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden={!active}
      className="absolute inset-0 rounded-[inherit] flex items-center justify-center gap-1.5 pointer-events-none transition-opacity duration-300 ease-out"
      style={{
        opacity: active ? 1 : 0,
        background: 'var(--color-positive)',
        zIndex: 5,
      }}
    >
      <Check size={15} strokeWidth={3} className="text-white" />
      <span className="text-sm font-semibold text-white">Saved</span>
    </div>
  )
}
