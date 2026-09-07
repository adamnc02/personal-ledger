import { createPortal } from 'react-dom'
import { formatFullDate } from '../lib/format'
import { FormButtonRow } from './FormButtons'

// Batch 7 (2026-09-07, Bug 8) — shared "are you sure?" confirmation for
// any RECURRING bill/loan/transfer change that takes effect from a chosen
// date (Adam's own spec): "shows 1 line for each changed field, from
// state → new state... used for anything RECURRING in the app that
// changed, relating to bills / transactions / loans / transfers." One
// line per changed field, grouped under that field's own sub-header, with
// a plain "→" between the old and new value — deliberately no colour-
// coding or extra formatting per field, so this stays generic enough to
// describe an amount, a location, a frequency, or anything else a future
// caller wants to show without this component needing to know what kind
// of value it's rendering.
export interface RecurringChangeField {
  /** Short sub-header, e.g. "Amount", "Location" — rendered upper-case. */
  label: string
  from: string
  to: string
}

export function RecurringChangeConfirmModal({
  effectiveFrom,
  changes,
  affectsClearedBalance,
  onCancel,
  onConfirm,
}: {
  /** ISO date — "All payments from and including {this} will see..." */
  effectiveFrom: string
  changes: RecurringChangeField[]
  /** Adam's spec: "*This will adjust your current balance if cleared
   * payments are included.*" — shown only when the effective date reaches
   * back far enough to touch an already-cleared payment. */
  affectsClearedBalance?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-base font-semibold text-[var(--color-ink)] mb-1">Are you sure?</h3>
        <p className="text-sm text-[var(--color-ink-muted)] mb-1">
          All payments from and including {formatFullDate(effectiveFrom)} will see the following change{changes.length === 1 ? '' : 's'}:
        </p>
        {affectsClearedBalance && (
          <p className="text-xs italic mb-3" style={{ color: 'var(--color-negative)' }}>
            This will adjust your current balance if cleared payments are included.
          </p>
        )}

        <div className="flex flex-col gap-3 mt-2 mb-2">
          {changes.map((change) => (
            <div key={change.label} className="rounded-xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
              <p className="text-[10px] font-semibold tracking-wide uppercase text-[var(--color-ink-faint)] mb-1">{change.label}</p>
              <p className="text-sm text-[var(--color-ink)] flex items-center gap-2 flex-wrap">
                <span>{change.from}</span>
                <span className="text-[var(--color-ink-muted)]">→</span>
                <span className="font-semibold">{change.to}</span>
              </p>
            </div>
          ))}
        </div>

        <FormButtonRow onCancel={onCancel} onSave={onConfirm} saveLabel="Confirm" />
      </div>
    </div>,
    document.body,
  )
}
