// Canonical Save/Cancel pair for every staged edit form in the app — the
// exact markup/classes lifted from the Pension form (Salary.tsx), which
// Adam confirmed as the preferred style (2026-09 session, UI consistency
// review §1/§10 Phase 3). A side-by-side flex-1 pair: Cancel is a muted
// surface-background pill, Save is the coral pill, both equal width.
//
// Deliberately does NOT cover the two known exceptions — the credit card
// minimum-charge override and the savings interest override — which keep
// their existing small save-only button with no Cancel, per Adam's own
// call: those are single-value inline overrides, not a staged multi-field
// form, so a Cancel alongside them would be adding a control with nothing
// meaningful to discard.

export function CancelButton({ onClick, label = 'Cancel' }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 py-2 rounded-full text-sm font-medium text-[var(--color-ink-muted)]"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-track)' }}
    >
      {label}
    </button>
  )
}

export function SaveButton({
  onClick,
  disabled,
  label = 'Save',
}: {
  onClick: () => void
  disabled?: boolean
  label?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 py-2 rounded-full text-sm font-semibold text-white disabled:opacity-40"
      style={{ background: 'var(--color-coral)' }}
    >
      {label}
    </button>
  )
}

/** The full side-by-side pair — use this in new forms rather than composing CancelButton/SaveButton separately, so the `flex gap-2 mt-4` wrapper can't drift from the canonical spacing either. */
export function FormButtonRow({
  onCancel,
  onSave,
  saveDisabled,
  cancelLabel,
  saveLabel,
}: {
  onCancel: () => void
  onSave: () => void
  saveDisabled?: boolean
  cancelLabel?: string
  saveLabel?: string
}) {
  return (
    <div className="flex gap-2 mt-4">
      <CancelButton onClick={onCancel} label={cancelLabel} />
      <SaveButton onClick={onSave} disabled={saveDisabled} label={saveLabel} />
    </div>
  )
}
