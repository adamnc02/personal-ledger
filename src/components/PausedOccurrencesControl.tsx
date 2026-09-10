import { useState } from 'react'
import { formatCurrency } from '../lib/format'
import { CancelButton, SaveButton, PauseToggleButton } from './FormButtons'
import { EditField } from './EditField'
import { ConfirmModal } from './ConfirmModal'

import { ChevronDown, ChevronUp } from 'lucide-react'

/**
 * "Manage upcoming payments" (2026-09-10 redesign, Adam-specified —
 * PROMPT-manage-paused-payments-redesign-2026-09-10.md) — evolved in
 * place from the original checkbox-list PausedOccurrencesControl
 * (2026-09 Phase 4) rather than forked, so all 7 call sites
 * (Bills/recurring Transfers/recurring overpayments/Pot+SavingsPot
 * recurring deposits/Pension/the Salary-page recurring transfer) stay in
 * sync on one shared component. Two independent things now live here,
 * with two independent save mechanics on the same row:
 *
 *  1. Pause/unpause — a per-row badge (PauseToggleButton), not a
 *     checkbox, but the SAME section-level stage-then-save contract as
 *     before: tapping only flips local `checked` state, the real
 *     `onSave(pausedDates)` write only happens when the section's own
 *     Save is pressed, and Cancel discards every tentative toggle.
 *  2. Per-occurrence amount edit (the genuinely new capability, only
 *     wired up when the caller passes `onSaveAmount`) — tapping a row's
 *     date/amount opens an inline amount field for THAT occurrence only,
 *     with its OWN Save button. That row Save stages {date, oldAmount,
 *     newAmount} and opens a ConfirmModal (same "Clear this balance?"
 *     pattern as Loans.tsx's CreditCardDueSection) — Confirm commits
 *     immediately via `onSaveAmount`, independent of any pending pause
 *     toggles or other rows' edits; Cancel dismisses back to the
 *     still-editable row without saving anything.
 *
 * Renamed throughout (collapsed trigger AND expanded header): every
 * per-entity "Manage paused {payments|deposits|overpayments|transfers}"
 * wording is now the one consistent "Manage upcoming payments" label,
 * per Adam's resolved 2026-09-10 call — itemLabel is kept only for the
 * empty-state copy, not the trigger/header text.
 */
export function PausedOccurrencesControl({
  windowDates,
  currentlyPaused,
  amountForDate,
  nextPaymentPreview,
  onSave,
  itemLabel = 'payments',
  onSaveAmount,
}: {
  windowDates: string[]
  currentlyPaused: Set<string>
  amountForDate: (date: string) => number
  /** Given the tentative (not-yet-saved) full pause set, returns the next date that would actually go ahead — or null if nothing's scheduled. Lets the picker preview the real effect of what's currently ticked, same as before. */
  nextPaymentPreview: (tentativePausedDates: string[]) => string | null
  onSave: (pausedDates: string[]) => void
  itemLabel?: string
  /**
   * When provided, each row also gets a tap-to-edit inline amount editor
   * for that ONE occurrence, with its own per-row Save + ConfirmModal —
   * see this component's own header comment for the full save-model
   * split from the pause toggle above. `originalDate` is always the
   * occurrence's un-overridden scheduled date (the same key
   * `windowDates`/`currentlyPaused` already use), matching every
   * existing occurrenceOverrides-keyed write in the app. Omit for an
   * entity with no single-occurrence amount write at all (none remain
   * after this build, but kept optional rather than required).
   */
  onSaveAmount?: (originalDate: string, newAmount: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirming, setConfirming] = useState<{ date: string; oldAmount: number; newAmount: number } | null>(null)

  function expand() {
    setChecked(new Set(currentlyPaused))
    setExpanded(true)
  }
  function togglePause(date: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }
  function commitPauseSave() {
    onSave([...checked])
    setExpanded(false)
  }
  function cancelSection() {
    setExpanded(false)
    setEditingDate(null)
    setConfirming(null)
  }
  function startEditing(date: string) {
    setEditingDate((prev) => (prev === date ? null : date))
    setEditValue(String(amountForDate(date)))
  }
  function requestSaveAmount(date: string) {
    const newAmount = Number(editValue)
    if (!Number.isFinite(newAmount)) return
    setConfirming({ date, oldAmount: amountForDate(date), newAmount })
  }

  const nextPayment = expanded ? nextPaymentPreview([...checked]) : null
  const sortedDates = [...windowDates].sort()

  return (
    <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      {!expanded ? (
        <button onClick={expand} className="text-xs font-semibold" style={{ color: 'var(--color-negative)' }}>
          Manage upcoming payments{currentlyPaused.size > 0 ? ` (${currentlyPaused.size} paused)` : ''}
        </button>
      ) : (
        <div className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
          <p className="text-xs font-semibold text-[var(--color-ink)] mb-2">Manage upcoming payments</p>
          <div className="flex flex-col gap-2 max-h-72 overflow-y-auto mb-2">
            {sortedDates.map((date) => {
              const isPaused = checked.has(date)
              const isEditing = editingDate === date
              return (
                <div key={date} className="rounded-xl px-3 py-2" style={{ background: 'var(--color-surface)' }}>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={`flex-1 min-w-0 flex items-center justify-between gap-2 text-left ${onSaveAmount ? '' : 'cursor-default'}`}
                      onClick={() => onSaveAmount && startEditing(date)}
                    >
                      <span className="text-sm text-[var(--color-ink)]">{date}</span>
                      <span className="font-mono text-sm text-[var(--color-ink)]">£{formatCurrency(amountForDate(date))}</span>
                      {onSaveAmount && (isEditing ? <ChevronUp size={14} className="text-[var(--color-ink-faint)] shrink-0" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)] shrink-0" />)}
                    </button>
                    <PauseToggleButton paused={isPaused} onClick={() => togglePause(date)} />
                  </div>
                  {isEditing && onSaveAmount && (
                    <div className="mt-2 pt-2 border-t flex items-end gap-2" style={{ borderColor: 'var(--color-track)' }}>
                      <div className="flex-1">
                        <EditField label="Amount (£) — this payment only" type="number" value={editValue} onChange={setEditValue} />
                      </div>
                      <button
                        onClick={() => requestSaveAmount(date)}
                        className="py-2 px-3 rounded-full text-xs font-semibold text-white shrink-0"
                        style={{ background: 'var(--color-coral)' }}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
            {sortedDates.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] px-1">Nothing scheduled to pick from — no upcoming or recent {itemLabel}.</p>}
          </div>
          <p className="text-xs text-[var(--color-ink-muted)] mb-1">
            {checked.size} paused · Next payment: {nextPayment ?? 'none scheduled'}
          </p>
          <div className="flex gap-2 mt-2">
            <CancelButton onClick={cancelSection} />
            <SaveButton onClick={commitPauseSave} />
          </div>
        </div>
      )}
      {confirming && (
        <ConfirmModal
          title="Update this payment?"
          description={`Changes the payment on ${confirming.date} from £${formatCurrency(confirming.oldAmount)} to £${formatCurrency(confirming.newAmount)}. Every other payment — before and after — is unaffected.`}
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={() => {
            onSaveAmount?.(confirming.date, confirming.newAmount)
            setConfirming(null)
            setEditingDate(null)
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  )
}
