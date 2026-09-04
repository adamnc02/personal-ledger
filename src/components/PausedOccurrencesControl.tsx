import { useState } from 'react'
import { formatCurrency } from '../lib/format'
import { CancelButton, SaveButton } from './FormButtons'

/**
 * Multi-select date-pause picker — generalized from SavingsPot's own
 * PausedDepositsControl (Phase 4 of the 2026-09 UI consistency work).
 * Adam's confirmed recommendation: no separate pause/resume flow, one
 * checklist of dates instead — a date ticked gets paused, unticked gets
 * resumed, and there's nothing else to it. Deliberately entity-agnostic:
 * the caller supplies the window of candidate dates (including already-
 * paused ones, so they can be unticked), which dates are CURRENTLY
 * paused, how to price each date, and a live "next payment ignoring the
 * tentative selection" preview — everything genuinely different between
 * Bills/Pensions/SavingsPots/loan recurring overpayments stays in each
 * entity's own lib file; only the picker UI itself is shared here.
 */
export function PausedOccurrencesControl({
  windowDates,
  currentlyPaused,
  amountForDate,
  nextPaymentPreview,
  onSave,
  itemLabel = 'payments',
}: {
  windowDates: string[]
  currentlyPaused: Set<string>
  amountForDate: (date: string) => number
  /** Given the tentative (not-yet-saved) full pause set, returns the next date that would actually go ahead — or null if nothing's scheduled. Lets the picker preview the real effect of what's currently ticked, same as SavingsPot's own control did. */
  nextPaymentPreview: (tentativePausedDates: string[]) => string | null
  onSave: (pausedDates: string[]) => void
  itemLabel?: string
}) {
  const [picking, setPicking] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  function startPicking() {
    setChecked(new Set(currentlyPaused))
    setPicking(true)
  }
  function toggle(date: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }
  function commit() {
    onSave([...checked])
    setPicking(false)
  }

  const nextPayment = picking ? nextPaymentPreview([...checked]) : null

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      {!picking ? (
        <button onClick={startPicking} className="text-xs font-semibold" style={{ color: 'var(--color-negative)' }}>
          Manage paused {itemLabel}{currentlyPaused.size > 0 ? ` (${currentlyPaused.size})` : ''}
        </button>
      ) : (
        <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
          <p className="text-xs font-semibold text-[var(--color-ink-muted)] mb-2">Tick any {itemLabel} to pause them</p>
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto mb-2">
            {windowDates.map((date) => (
              <label key={date} className="flex items-center gap-2 px-1 py-1">
                <input type="checkbox" checked={checked.has(date)} onChange={() => toggle(date)} />
                <span className="text-xs text-[var(--color-ink)]">
                  {date} · £{formatCurrency(amountForDate(date))}
                </span>
              </label>
            ))}
            {windowDates.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] px-1">Nothing scheduled to pick from.</p>}
          </div>
          <p className="text-xs text-[var(--color-ink-muted)] mb-1">
            {checked.size} selected · Next payment: {nextPayment ?? 'none scheduled'}
          </p>
          <div className="flex gap-2 mt-2">
            <CancelButton onClick={() => setPicking(false)} />
            <SaveButton onClick={commit} />
          </div>
        </div>
      )}
    </div>
  )
}
