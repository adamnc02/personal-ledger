import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency } from '../lib/format'
import { useLedgerData } from '../context/LedgerContext'
import { calculateNetSalary, type StudentLoanPlan, type PayFrequency, type SalaryDeduction, type DeductionType } from '../lib/tax'
import { THREE_CYCLES_AHEAD } from '../lib/projection'
import { findApplicableSnapshot, latestSalarySnapshot, computeNetPayForPeriod, upcomingPaydays, closedPaydays } from '../lib/salaryLedger'
import { calculateBonusOnTop } from '../lib/tax'
import { AttachBonusButton } from '../components/AttachBonusButton'
import { downloadLedgerBackup, parseLedgerBackupJson } from '../lib/ledgerStorage'
import { Plus, Trash2, Download, Upload, ChevronDown, ChevronUp, Settings, X, Users, CalendarClock, Info, ArrowUpDown } from 'lucide-react'
import type { AppDataV2, Loan, PayCycleConfig, Pension, Person, Pot, RecurrenceFrequency, RecurringTemplate, SavingsInterestMethod, SavingsPot, Transaction } from '../types/ledger'
import { nanoid } from 'nanoid'
import { DeductionModal } from '../components/DeductionModal'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { PausedOccurrencesControl } from '../components/PausedOccurrencesControl'
import { ConfirmModal } from '../components/ConfirmModal'
import { FormButtonRow } from '../components/FormButtons'
import { SavedFlashOverlay } from '../components/SavedFlash'
import { NumberInput } from '../components/NumberInput'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { EditField } from '../components/EditField'
import { hasSalaryConfigured } from '../lib/household'
import { pensionOccurrencePreviews, applyPensionAmountChange, newPension, scheduledPensionDates, setPausedPensionOccurrences, resolvePensionAmount } from '../lib/pensionLedger'
import { JointAccountSetupModal } from '../components/JointAccountSetupModal'
import { formatFullDate } from '../lib/format'
import {
  newSavingsPot,
  applyInterestMethodChange,
  depositOccurrencePreviews,
  savingsPotBalanceAsOf,
  buildSavingsPotScheduleRows,
  type SavingsPotScheduleRow,
} from '../lib/savingsPotLedger'
import { buildExampleLedger } from '../lib/savingsInterest'
import { newPot, potBalanceAsOf, potDepositOccurrencePreviews } from '../lib/potLedger'
import { setPausedTemplateOccurrences, scheduledTemplateDates, templateOccurrencePreviews } from '../lib/schedule'
import { locationsEqual, transferLocationLabel, transferLocationKey, buildTransferLocationOptions, type TransferLocationOption } from '../lib/transferLedger'
import { AmountStep, LocationStep, FrequencyStep, DateStep, type TransferFrequencyChoice, resolveTransferFrequencyChoice } from '../components/TransferSteps'
import {
  hasSalarySortDestinations,
  salarySortDestinations,
  salarySortSuggestion,
  findOneOffTransferConflict,
  findRecurringTransferConflict,
} from '../lib/salarySortLedger'
import type { TransferLocation } from '../types/ledger'

/**
 * Compact amount label for a deduction's collapsed row.
 *
 * Percentage lines say what they're a percentage OF, deliberately. Two rows
 * both reading a bare "4%" while computing quite different amounts (4% of gross
 * vs 4% of qualifying earnings — £100.00 vs £79.20 on a £2,500 gross) is
 * exactly the failure that prompted the tax engine rewrite, and it's invisible
 * unless the basis is on the summary view rather than buried in the editor.
 */
function deductionAmountLabel(d: SalaryDeduction): string {
  if (d.amountType !== 'percent') return `£${formatCurrency(d.amount)}`
  return d.percentBasis === 'qualifying_earnings' ? `${d.amount}% of QE` : `${d.amount}% of gross`
}

const STUDENT_LOAN_LABELS: Record<StudentLoanPlan, string> = {
  none: 'No student loan',
  plan1: 'Plan 1',
  plan2: 'Plan 2',
  plan4: 'Plan 4',
  plan5: 'Plan 5',
  postgrad: 'Postgraduate loan',
}

import { addDays, addMonths } from 'date-fns'
import { todayIso, toLocalIsoDate } from '../lib/date'

function emptySalaryFields() {
  return {
    grossAnnual: 0,
    taxCode: '1257L',
    studentLoanPlan: 'none' as StudentLoanPlan,
    payFrequency: 'monthly' as PayFrequency,
    deductions: [] as SalaryDeduction[],
    employerPensionPercent: undefined as number | undefined,
  }
}

// Same style as Borrowing's per-section AddButton (Loans.tsx) — kept as
// its own local copy rather than a shared import, matching this
// codebase's existing per-page-file convention for small one-off UI bits.
function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'var(--color-coral)' }}>
      <Plus size={14} className="text-white" />
    </button>
  )
}

/**
 * "For" person picker — used inside every new-entry form on this page
 * (Pension's, Savings') per Adam's spec: invisible with just one person
 * (silently binds to them, exactly today's single-user behaviour), an
 * editable dropdown once a second person exists — same field, both at
 * creation AND when editing an existing record afterward, since it's
 * just rendered inline in the form rather than a separate one-off picker
 * step. Defaults to the primary person when nothing's been chosen yet.
 */
function PersonSelectField({ people, value, onChange }: { people: Person[]; value: string; onChange: (personId: string) => void }) {
  if (people.length <= 1) return null
  return (
    <Field label="For">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
      >
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </Field>
  )
}

function activeIncomeSourceCount(person: Person, pensions: Pension[]): number {
  return (hasSalaryConfigured(person) ? 1 : 0) + pensions.filter((p) => p.personId === person.id && p.active).length
}

function FollowingTag() {
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide shrink-0"
      style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink-muted)' }}
    >
      Following
    </span>
  )
}

function FollowingPickerButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'var(--color-bg-elevated)' }} aria-label="Choose which income source the budgeting cycle follows">
      <CalendarClock size={14} className="text-[var(--color-ink)]" />
    </button>
  )
}

/** Inline "who's this for?" picker — shown before a form when 2+ candidates exist (Adam's spec: skip straight to the form with exactly one). */
function PersonPickerCard({ people, onPick, onCancel }: { people: Person[]; onPick: (personId: string) => void; onCancel: () => void }) {
  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Who's this for?</span>
        <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        {people.map((p) => (
          <button
            key={p.id}
            onClick={() => onPick(p.id)}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  )
}

const PENSION_FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  weekly: 'Weekly',
  every_n_weeks: 'Every N weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annually',
}

interface PensionFields {
  name: string
  amount: number
  frequency: RecurrenceFrequency
  intervalWeeks?: number
  anchorDate: string
  adjustForNonWorkingDay: boolean
  cycleStartFollowsPayday: boolean
}

/** New-pension form — same "For" person picker as every other new-entry form on this page (PersonSelectField), reused unmodified when editing an existing pension's owner (PensionRow passes the same field through). */
function PensionForm({
  people,
  defaultPersonId,
  initial,
  onSave,
  onCancel,
}: {
  people: Person[]
  defaultPersonId: string
  initial?: PensionFields
  onSave: (personId: string, fields: PensionFields) => void
  onCancel: () => void
}) {
  const [personId, setPersonId] = useState(defaultPersonId)
  const [name, setName] = useState(initial?.name ?? '')
  const [amount, setAmount] = useState(initial?.amount ?? 0)
  const [frequency, setFrequency] = useState<RecurrenceFrequency>(initial?.frequency ?? 'monthly')
  const [intervalWeeks, setIntervalWeeks] = useState(initial?.intervalWeeks ?? 2)
  const [anchorDate, setAnchorDate] = useState(initial?.anchorDate ?? todayIso())
  // Same two fields as the salary form's pay-cycle checkboxes — unticked
  // by default here (initial?.adjustForNonWorkingDay ?? false), unlike
  // salary's default-ticked adjustForNonWorkingDay, per Adam's spec: a
  // pension's cadence varies far more (weekly state pension vs monthly
  // private one) so this starts opt-in rather than assumed.
  const [adjustForNonWorkingDay, setAdjustForNonWorkingDay] = useState(initial?.adjustForNonWorkingDay ?? false)
  const [cycleStartFollowsPayday, setCycleStartFollowsPayday] = useState(initial?.cycleStartFollowsPayday ?? false)
  // UAT follow-up (2026-09-04, Adam-reported): when editing (initial is
  // set), Save must be dimmed until something actually changed — a pure
  // validity check (name non-empty) was always true for an
  // already-saved pension, so Save sat at full brightness the instant
  // the row expanded. Creating a new pension (no `initial`) has nothing
  // to diff against, so validity is the only meaningful gate there.
  const dirty =
    !initial ||
    personId !== defaultPersonId ||
    name.trim() !== initial.name ||
    amount !== initial.amount ||
    frequency !== initial.frequency ||
    (frequency === 'every_n_weeks' && intervalWeeks !== (initial.intervalWeeks ?? 2)) ||
    anchorDate !== initial.anchorDate ||
    adjustForNonWorkingDay !== initial.adjustForNonWorkingDay ||
    cycleStartFollowsPayday !== initial.cycleStartFollowsPayday

  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="grid grid-cols-2 gap-3">
        {/* Only shown when EDITING an existing pension (initial is set) —
            creation goes through the person-picker-first flow instead
            (Pensions section header's "+"), same as every other new-entry
            flow on this page. Editing still needs the field live in the
            form itself so reassignment is reachable after creation, per
            Adam's spec — this is that same PersonSelectField, just gated
            to the edit path only rather than always rendered. */}
        {initial && <PersonSelectField people={people} value={personId} onChange={setPersonId} />}
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. State Pension"
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          />
        </Field>
        <Field label="Net amount (£)">
          <NumberInput
            inputMode="decimal"
            value={amount || ''}
            onChange={(v) => setAmount(Number(v) || 0)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
        <Field label="Frequency">
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {(Object.keys(PENSION_FREQUENCY_LABELS) as RecurrenceFrequency[]).map((f) => (
              <option key={f} value={f} style={{ color: '#000' }}>
                {PENSION_FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
        </Field>
        {frequency === 'every_n_weeks' && (
          <EditField label="Every N weeks" type="number" value={String(intervalWeeks)} onChange={(v) => setIntervalWeeks(Math.max(1, Number(v) || 1))} />
        )}
        <EditField label={frequency === 'weekly' || frequency === 'every_n_weeks' ? 'First payment date' : 'Payment date'} type="date" value={anchorDate} onChange={setAnchorDate} />
      </div>
      <label className="flex items-center gap-2 mt-3">
        <input type="checkbox" checked={adjustForNonWorkingDay} onChange={(e) => setAdjustForNonWorkingDay(e.target.checked)} />
        <span className="text-xs text-[var(--color-ink-muted)]">If payment falls on a weekend or UK bank holiday, pay on the last working day before it</span>
      </label>
      <label className="flex items-center gap-2 mt-2.5">
        <input type="checkbox" checked={cycleStartFollowsPayday} onChange={(e) => setCycleStartFollowsPayday(e.target.checked)} />
        <span className="text-xs text-[var(--color-ink-muted)]">
          Start the budgeting cycle on this payment itself, weekend/BH adjustment included — only takes effect while this pension is the one "Following" (see the calendar icon)
        </span>
      </label>
      <div className="flex gap-2 mt-4">
        <button onClick={onCancel} className="flex-1 py-2 rounded-full text-sm font-medium text-[var(--color-ink-muted)]" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-track)' }}>
          Cancel
        </button>
        <button
          disabled={!name.trim() || !dirty}
          onClick={() => {
            if (!name.trim()) return
            onSave(personId, {
              name: name.trim(),
              amount,
              frequency,
              intervalWeeks: frequency === 'every_n_weeks' ? intervalWeeks : undefined,
              anchorDate,
              adjustForNonWorkingDay,
              cycleStartFollowsPayday,
            })
          }}
          className="flex-1 py-2 rounded-full text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

/** A single pension's row — collapsed summary + expand, same pattern as Borrowing's LoanRow/CreditCardRow, and the Salary section's own person rows. */
function PensionRow({
  pension,
  people,
  showFollowingTag,
  isOpen,
  onToggle,
  onSave,
  onRemove,
}: {
  pension: Pension
  people: Person[]
  showFollowingTag: boolean
  isOpen: boolean
  onToggle: () => void
  onSave: (updates: Partial<Omit<Pension, 'id' | 'personId'>> & { personId?: string }) => void
  onRemove: () => void
}) {
  const owner = people.find((p) => p.id === pension.personId)
  const previews = pensionOccurrencePreviews(pension, new Date(), 1)
  const next = previews[0]
  // Same 2-months-back/12-months-forward window SavingsPot's own pause
  // picker uses — pensions have no "opening date" ramp-up concept to
  // clamp against, so this is simpler than schedulePreviewWindow.
  const pauseWindowStart = addMonths(new Date(), -2)
  const pauseWindowEnd = addMonths(new Date(), 12)
  const pauseWindowDates = scheduledPensionDates(pension, pauseWindowStart, pauseWindowEnd)
  const currentlyPausedPensionDates = new Set((pension.occurrenceOverrides ?? []).filter((o) => o.deleted && pauseWindowDates.includes(o.originalDate)).map((o) => o.originalDate))

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={pension.name}>
      <div className="rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-display text-base font-semibold text-[var(--color-ink)] truncate">{pension.name}</span>
            {people.length > 1 && <span className="text-xs text-[var(--color-ink-muted)] shrink-0">{owner?.name ?? 'Unknown'}</span>}
            {showFollowingTag && <FollowingTag />}
          </div>
        </div>

        <button onClick={onToggle} className="w-full flex items-center justify-between text-left py-1">
          <span className="text-sm text-[var(--color-ink-muted)]">
            {pension.active ? (next ? <>Next payment {next.date} · £{formatCurrency(next.amount)}</> : 'No upcoming payment') : 'Paused'}
          </span>
          <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
        </button>

        {isOpen && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
            <PensionForm
              people={people}
              defaultPersonId={pension.personId}
              initial={{
                name: pension.name,
                amount: pension.amount,
                frequency: pension.frequency,
                intervalWeeks: pension.intervalWeeks,
                anchorDate: pension.anchorDate,
                adjustForNonWorkingDay: pension.adjustForNonWorkingDay,
                cycleStartFollowsPayday: pension.cycleStartFollowsPayday,
              }}
              onCancel={onToggle}
              onSave={(personId, fields) => {
                // A standing amount change goes through applyPensionAmountChange
                // (historized, same as a salary snapshot or a bill's amount
                // change) — but only when the amount actually changed; editing
                // just the name/frequency/date shouldn't fabricate a change
                // record for an amount that never moved.
                const amountPatch = fields.amount !== pension.amount ? applyPensionAmountChange(pension, fields.amount, todayIso()) : { amount: fields.amount }
                onSave({
                  personId,
                  name: fields.name,
                  frequency: fields.frequency,
                  intervalWeeks: fields.intervalWeeks,
                  anchorDate: fields.anchorDate,
                  adjustForNonWorkingDay: fields.adjustForNonWorkingDay,
                  cycleStartFollowsPayday: fields.cycleStartFollowsPayday,
                  ...amountPatch,
                })
                onToggle()
              }}
            />
            <label className="flex items-center gap-2 mt-1">
              <input type="checkbox" checked={pension.active} onChange={(e) => onSave({ active: e.target.checked })} />
              <span className="text-xs text-[var(--color-ink-muted)]">Active — paused pensions stop generating new payments</span>
            </label>
            <PausedOccurrencesControl
              windowDates={pauseWindowDates}
              currentlyPaused={currentlyPausedPensionDates}
              amountForDate={(date) => resolvePensionAmount(pension, date)}
              itemLabel="payments"
              nextPaymentPreview={(tentative) => {
                const previewPension: Pension = { ...pension, ...setPausedPensionOccurrences(pension, pauseWindowDates, tentative) }
                return pensionOccurrencePreviews(previewPension, new Date(), 1)[0]?.date ?? null
              }}
              onSave={(pausedDates) => onSave(setPausedPensionOccurrences(pension, pauseWindowDates, pausedDates))}
            />
          </div>
        )}
      </div>
    </SwipeToDelete>
  )
}

// ── Savings pots (backlog item a) ────────────────────────────────────

const INTEREST_METHOD_LABELS: Record<SavingsInterestMethod['type'], string> = {
  aer_credited: 'AER, credited at a fixed frequency',
  daily_accrual_monthly_credited: 'Daily accrual, credited monthly',
}
const CREDITING_FREQUENCY_LABELS: Record<'monthly' | 'quarterly' | 'annual', string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annually',
}

function defaultMethodOfType(type: SavingsInterestMethod['type'], aer: number): SavingsInterestMethod {
  return type === 'aer_credited' ? { type: 'aer_credited', aer, creditingFrequency: 'monthly' } : { type: 'daily_accrual_monthly_credited', aer }
}

/**
 * Explanation pop-up shown on save, per Adam's spec — a plain description
 * of the chosen method plus a worked example ledger (buildExampleLedger,
 * a fixed £1,000 illustrative balance, has nothing to do with the real
 * pot being created/edited) so the mechanic — especially the "credited
 * monthly but accrues daily from the moment money lands" difference the
 * two methods actually have — is visible, not just described in prose.
 * Confirming here is what actually commits the save; "Back" returns to
 * the form with nothing written yet.
 */
function InterestExplanationModal({ method, onConfirm, onBack }: { method: SavingsInterestMethod; onConfirm: () => void; onBack: () => void }) {
  const rows = buildExampleLedger(method)
  return createPortal(
    <div className="fixed inset-0 z-[600] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onBack}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] flex flex-col"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* BUGFIX (Adam-reported, 2026-09-02): the Back/Confirm buttons
            used to be the last children INSIDE this same overflow-y-auto
            scroll region, alongside the worked-example rows. On touch
            devices, a tap on an element inside a scrollable container
            that the browser hasn't yet settled as "not a scroll" can be
            swallowed rather than registered as a click — exactly
            matching "first tap does nothing, second tap works" (the
            first tap resolves the scroll-vs-tap ambiguity, the second is
            unambiguously a tap). The buttons are now a separate, fixed
            footer OUTSIDE the scrolling region entirely — only the
            description + example ledger scroll, same split
            SavingsPotLedgerModal already uses between its header and its
            row list. */}
        <div className="overflow-y-auto flex-1 -mx-5 px-5">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)] mb-2">{INTEREST_METHOD_LABELS[method.type]}</h3>
          {method.type === 'aer_credited' ? (
            <p className="text-xs text-[var(--color-ink-muted)] mb-4">
              Interest is worked out against the balance at the start of each period and paid in {CREDITING_FREQUENCY_LABELS[method.creditingFrequency].toLowerCase()} — a deposit made partway
              through a period doesn't start earning until the following one.
            </p>
          ) : (
            <p className="text-xs text-[var(--color-ink-muted)] mb-4">
              Interest builds up every day against whatever the balance actually is that day — a deposit starts earning from the day it lands — but is only actually paid into the pot once a
              month.
            </p>
          )}
          <p className="text-xs font-semibold text-[var(--color-ink-muted)] mb-2">Worked example, starting from £1,000</p>
          <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
            {rows.map((r, i) => (
              <div key={i} className="py-2 flex items-center justify-between">
                <div>
                  <p className="text-xs text-[var(--color-ink)]">{r.label}</p>
                  <p className="text-[10px] text-[var(--color-ink-faint)]">{r.date}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-mono" style={{ color: r.label.startsWith('Interest') ? 'var(--color-positive)' : 'var(--color-ink)' }}>
                    {r.label.startsWith('Interest') ? '+' : ''}£{formatCurrency(r.amount)}
                  </p>
                  <p className="text-[10px] text-[var(--color-ink-faint)] font-mono">Balance £{formatCurrency(r.balanceAfter)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-2 pt-4 shrink-0">
          <button onClick={onBack} className="flex-1 py-2 rounded-full text-sm font-medium text-[var(--color-ink-muted)]" style={{ background: 'var(--color-bg-elevated)' }}>
            Back
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 rounded-full text-sm font-semibold text-white"
            style={{ background: 'var(--color-coral)' }}
          >
            Looks good, save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

interface SavingsPotFields {
  name: string
  openingBalance: number
  openingDate: string
  interestMethod: SavingsInterestMethod
  targetAmount?: number
  targetDate?: string
  recurringDepositAmount?: number
  recurringDepositDayOfMonth?: number
}

/**
 * Create/edit form for a savings pot. Creation asks "new or existing"
 * FIRST (Adam's spec) — a brand-new pot skips straight to the form with
 * openingBalance locked at 0 and openingDate locked to today (no reason
 * to backdate money that was never there); an existing one shows both
 * fields, openingDate defaulting to today but freely editable. Editing an
 * already-created pot (initial set) skips the chooser entirely — the
 * opening balance/date are a one-time anchor, not something to re-pick
 * every edit (same "immutable anchor, not a live field" treatment
 * CreditCard.balanceAsOfDate already gets).
 */
export function SavingsPotForm({
  people,
  defaultPersonId,
  initial,
  onSave,
  onCancel,
}: {
  people: Person[]
  defaultPersonId: string
  initial?: SavingsPotFields
  onSave: (personId: string, fields: SavingsPotFields) => void
  onCancel: () => void
}) {
  const [personId, setPersonId] = useState(defaultPersonId)
  const [kind, setKind] = useState<'new' | 'existing' | null>(initial ? 'existing' : null)
  const [name, setName] = useState(initial?.name ?? '')
  const [openingBalance, setOpeningBalance] = useState(initial?.openingBalance ?? 0)
  const [openingDate, setOpeningDate] = useState(initial?.openingDate ?? todayIso())
  const [methodType, setMethodType] = useState<SavingsInterestMethod['type']>(initial?.interestMethod.type ?? 'aer_credited')
  const [aer, setAer] = useState(initial?.interestMethod.aer ?? 4.5)
  const [creditingFrequency, setCreditingFrequency] = useState<'monthly' | 'quarterly' | 'annual'>(
    initial?.interestMethod.type === 'aer_credited' ? initial.interestMethod.creditingFrequency : 'monthly',
  )
  const [targetAmount, setTargetAmount] = useState(initial?.targetAmount ?? 0)
  const [targetDate, setTargetDate] = useState(initial?.targetDate ?? '')
  const [recurringDepositAmount, setRecurringDepositAmount] = useState(initial?.recurringDepositAmount ?? 0)
  const [recurringDepositDayOfMonth, setRecurringDepositDayOfMonth] = useState(initial?.recurringDepositDayOfMonth ?? 28)
  const [confirming, setConfirming] = useState(false)

  const method = defaultMethodOfType(methodType, aer)
  // UAT follow-up (2026-09-04, Adam-reported): Save used to gate on
  // `!name.trim()` alone — always false (so always enabled) once a
  // savings pot already has a name, regardless of whether anything had
  // actually changed. Creating a new pot (no `initial`) has nothing to
  // diff against, so validity is the only meaningful gate there.
  const dirty = !initial || JSON.stringify(buildFields()) !== JSON.stringify(initial)

  function buildFields(): SavingsPotFields {
    return {
      name: name.trim(),
      openingBalance: kind === 'new' && !initial ? 0 : openingBalance,
      openingDate,
      interestMethod: method,
      targetAmount: targetAmount > 0 ? targetAmount : undefined,
      targetDate: targetDate || undefined,
      recurringDepositAmount: recurringDepositAmount > 0 ? recurringDepositAmount : undefined,
      recurringDepositDayOfMonth: recurringDepositAmount > 0 ? recurringDepositDayOfMonth : undefined,
    }
  }

  // Creation only: ask new-vs-existing before showing any fields at all.
  if (!initial && kind === null) {
    return (
      <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Is this a new pot, or one you already have?</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => {
              setKind('new')
              setOpeningBalance(0)
              setOpeningDate(todayIso())
            }}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            New pot — starts at £0.00
          </button>
          <button
            onClick={() => setKind('existing')}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            Existing pot — I already have a balance
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      {/* BUGFIX (Adam-reported, 2026-09-02 — "I create a deposit of £250,
          save, and it changes to 243 or 239"): every field below is a
          direct sibling in this grid, and several are conditionally
          shown/hidden (Credited only for aer_credited, On day of month
          only once a deposit amount is entered, Opening balance/date
          only for an existing pot). Without an explicit `key`, React
          reconciles by POSITION — when a conditional sibling appears or
          disappears, everything after it shifts position, and React can
          silently REUSE a NumberInput's underlying instance (uncommitted
          typed text and all) for what is now a DIFFERENT logical field.
          That's a real, known React footgun, and it's the most plausible
          concrete mechanism for a typed value silently becoming a
          different one. Every field now has a stable key tied to what it
          actually IS, not its position, which removes this failure mode
          entirely regardless of how the surrounding fields shift. */}
      <div className="grid grid-cols-2 gap-3">
        {initial && <PersonSelectField key="person" people={people} value={personId} onChange={setPersonId} />}
        <Field key="name" label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Rainy day fund"
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          />
        </Field>
        {/* BUGFIX (Adam-reported, 2026-09-02): the opening balance/date
            are a one-time anchor set once at creation — same "immutable
            anchor, not a live field" treatment CreditCard.balanceAsOfDate
            gets — and were NEVER meant to be editable afterward. `kind`
            defaults to 'existing' whenever `initial` is set (see its own
            useState above) purely so this form doesn't ask "new or
            existing?" again when editing — that default was silently
            ALSO making these two fields reappear on every edit, for
            every pot regardless of how it was originally created. Now
            gated on `!initial` too, so they only ever show during the
            actual creation flow. */}
        {kind === 'existing' && !initial && (
          <Field key="opening-balance" label="Opening balance (£)">
            <NumberInput
              inputMode="decimal"
              value={openingBalance || ''}
              onChange={(v) => setOpeningBalance(Number(v) || 0)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
        )}
        {kind === 'existing' && !initial && <EditField key="opening-date" label="Opening date" type="date" value={openingDate} onChange={setOpeningDate} />}
        <Field key="interest-method" label="Interest method">
          <select
            value={methodType}
            onChange={(e) => setMethodType(e.target.value as SavingsInterestMethod['type'])}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {(Object.keys(INTEREST_METHOD_LABELS) as SavingsInterestMethod['type'][]).map((t) => (
              <option key={t} value={t} style={{ color: '#000' }}>
                {INTEREST_METHOD_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field key="aer" label="AER (%)">
          <NumberInput
            inputMode="decimal"
            value={aer || ''}
            onChange={(v) => setAer(Number(v) || 0)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
        {/* Only the aer_credited method has a crediting-frequency choice — daily_accrual is always monthly, per that method's own comment in types/ledger.ts. Dynamically shown/hidden by methodType, per Adam's spec. */}
        {methodType === 'aer_credited' && (
          <Field key="crediting-frequency" label="Credited">
            <select
              value={creditingFrequency}
              onChange={(e) => setCreditingFrequency(e.target.value as 'monthly' | 'quarterly' | 'annual')}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
            >
              {(Object.keys(CREDITING_FREQUENCY_LABELS) as ('monthly' | 'quarterly' | 'annual')[]).map((f) => (
                <option key={f} value={f} style={{ color: '#000' }}>
                  {CREDITING_FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field key="recurring-deposit-amount" label="Monthly deposit (£, optional)">
          <NumberInput
            inputMode="decimal"
            value={recurringDepositAmount || ''}
            onChange={(v) => setRecurringDepositAmount(Number(v) || 0)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
        {recurringDepositAmount > 0 && (
          <EditField
            key="recurring-deposit-day"
            label="On day of month"
            type="number"
            value={String(recurringDepositDayOfMonth)}
            onChange={(v) => setRecurringDepositDayOfMonth(Math.min(31, Math.max(1, Number(v) || 1)))}
          />
        )}
        <Field key="target-amount" label="Target amount (£, optional)">
          <NumberInput
            inputMode="decimal"
            value={targetAmount || ''}
            onChange={(v) => setTargetAmount(Number(v) || 0)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
        <EditField key="target-date" label="Target date (optional)" type="date" value={targetDate} onChange={setTargetDate} />
      </div>
      <p className="text-[10px] text-[var(--color-ink-faint)] mt-2">
        Target amount shows a progress pie chart on this pot's card. Target date shows how much to save each payday to hit it by then — the two are independent; set either, both, or neither.
      </p>
      <div className="flex gap-2 mt-4">
        <button onClick={onCancel} className="flex-1 py-2 rounded-full text-sm font-medium text-[var(--color-ink-muted)]" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-track)' }}>
          Cancel
        </button>
        <button
          disabled={!name.trim() || !dirty}
          onClick={() => {
            if (!name.trim()) return
            setConfirming(true)
          }}
          className="flex-1 py-2 rounded-full text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Save
        </button>
      </div>
      {confirming && (
        <InterestExplanationModal
          method={method}
          onBack={() => setConfirming(false)}
          onConfirm={() => {
            onSave(personId, buildFields())
            setConfirming(false)
          }}
        />
      )}
    </div>
  )
}

/** A single pot's row — collapsed summary + expand, mirroring PensionRow exactly, plus the info-icon ledger modal (same placement/pattern as CreditCardRow's in Loans.tsx). */
/**
 * The recurring-deposit editor shared by Savings/Pots/Joint Wallet-page
 * cards (2026-09-04 session, "single clean consistent method to create
 * them throughout" — Adam-specified). Writes/edits a RecurringTemplate
 * with kind: 'transfer', transferTo: `location` — the EXACT same entity
 * the Transactions page's Transfer pill creates, so a recurring deposit
 * set up from either place shows up (and is editable) from the other.
 * Deliberately deposit-only (transferFrom always 'personal') — a
 * recurring WITHDRAWAL from one of these entities is set up from the
 * Transfer pill itself, same as it always was for a one-off withdrawal.
 */
type RecurringCreateStep = 'closed' | 'type' | 'amount' | 'location' | 'frequency' | 'date'

/**
 * UAT Batch 4 (2026-09-04, items 2/7): rebuilt from a single "amount,
 * then Continue" step (which silently created a Current-Account-only
 * monthly deposit) into Adam's full picker-wizard spec — a Deposit/
 * Withdrawal choice, then Amount → Location → Frequency (→ weeks, if
 * every-N-weeks) → Date, the date step skipped entirely when the
 * frequency choice was "follow payday"/"follow my budgeting cycle"
 * (those resolve their own date at generation time — see
 * schedule.ts's generateTransactionsForTemplate). Recurring can now be
 * EITHER direction (a pot/savings pot/joint account can have a standing
 * recurring WITHDRAWAL just as easily as a deposit), so `existing` now
 * matches a template touching this location on either side, not just
 * `transferTo`.
 */
function RecurringTransferEditor({
  location,
  defaultName,
  templates,
  locationOptions,
  onAdd,
  onUpdate,
  onRemove,
}: {
  location: TransferLocation
  defaultName: string
  templates: RecurringTemplate[]
  locationOptions: TransferLocationOption[]
  onAdd: (template: Omit<RecurringTemplate, 'id' | 'active' | 'kind' | 'categoryId' | 'paymentMethod' | 'location' | 'ownerId' | 'payee' | 'payeeSharePercent'>) => void
  onUpdate: (id: string, updates: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemove: (id: string) => void
}) {
  // UAT Batch 4 follow-up (2026-09-04, Adam-reported): this used to match
  // ANY transfer touching this location and treat it as THE one slot —
  // so configuring a recurring deposit made the "+ Add" button disappear
  // entirely, with no way to also add a recurring withdrawal (or vice
  // versa). A deposit (transferTo === location) and a withdrawal
  // (transferFrom === location) are independent slots now; the "+"
  // button only disappears once BOTH are configured.
  const existingDeposit = templates.find((t) => t.kind === 'transfer' && locationsEqual(t.transferTo, location))
  const existingWithdrawal = templates.find((t) => t.kind === 'transfer' && locationsEqual(t.transferFrom, location))
  const bothConfigured = !!existingDeposit && !!existingWithdrawal
  const fixedKey = transferLocationKey(location)

  const [step, setStep] = useState<RecurringCreateStep>('closed')
  const [type, setType] = useState<'deposit' | 'withdrawal'>('deposit')
  const [draftAmount, setDraftAmount] = useState('')
  const [otherLocation, setOtherLocation] = useState<TransferLocationOption | null>(null)
  const [freqChoice, setFreqChoice] = useState<TransferFrequencyChoice | null>(null)
  const [intervalWeeks, setIntervalWeeks] = useState(2)
  const [date, setDate] = useState(todayIso())

  function reset() {
    setStep('closed')
    setType('deposit')
    setDraftAmount('')
    setOtherLocation(null)
    setFreqChoice(null)
    setIntervalWeeks(2)
    setDate(todayIso())
  }

  function commitCreate() {
    if (!otherLocation || !freqChoice) return
    const resolved = resolveTransferFrequencyChoice(freqChoice)
    onAdd({
      name: defaultName,
      amount: Number(draftAmount) || 0,
      frequency: resolved.frequency,
      intervalWeeks: resolved.frequency === 'every_n_weeks' ? intervalWeeks : undefined,
      anchorDate: date,
      transferFrom: type === 'deposit' ? otherLocation.location : location,
      transferTo: type === 'deposit' ? location : otherLocation.location,
      followsPayday: resolved.followsPayday,
      followsCycleStart: resolved.followsCycleStart,
    })
    reset()
  }

  if (step === 'closed') {
    return (
      <>
        {existingDeposit && <RecurringExistingDeposit template={existingDeposit} onUpdate={onUpdate} onRemove={onRemove} />}
        {existingWithdrawal && <RecurringExistingDeposit template={existingWithdrawal} onUpdate={onUpdate} onRemove={onRemove} />}
        {!bothConfigured && (
          <button
            onClick={() => {
              // Skip the Deposit/Withdrawal choice entirely when only one
              // direction is still available — nothing meaningful to pick.
              if (existingDeposit && !existingWithdrawal) {
                setType('withdrawal')
                setStep('amount')
              } else if (existingWithdrawal && !existingDeposit) {
                setType('deposit')
                setStep('amount')
              } else {
                setStep('type')
              }
            }}
            className="text-xs font-medium self-start"
            style={{ color: 'var(--color-coral)' }}
          >
            + Add a recurring transfer
          </button>
        )}
      </>
    )
  }

  // Adam's explicit correction (2026-09-04): Deposit/Withdrawal is its
  // own first step here, same reasoning as LogTransferButton's — this
  // wizard needs direction before the location step can label itself.
  if (step === 'type') {
    return (
      <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Deposit or withdrawal?</span>
          <button onClick={reset} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setType('deposit')
              setStep('amount')
            }}
            className="flex-1 py-2 rounded-full text-sm font-medium"
            style={{ background: 'var(--color-surface)', color: 'var(--color-ink)' }}
          >
            Deposit
          </button>
          <button
            onClick={() => {
              setType('withdrawal')
              setStep('amount')
            }}
            className="flex-1 py-2 rounded-full text-sm font-medium"
            style={{ background: 'var(--color-surface)', color: 'var(--color-ink)' }}
          >
            Withdrawal
          </button>
        </div>
      </div>
    )
  }

  if (step === 'amount') {
    return <AmountStep value={draftAmount} onChange={setDraftAmount} onCancel={reset} onContinue={() => setStep('location')} />
  }

  if (step === 'location') {
    return (
      <LocationStep
        title={type === 'deposit' ? 'From' : 'To'}
        options={locationOptions}
        excludeKey={fixedKey}
        onPick={(o) => {
          setOtherLocation(o)
          setStep('frequency')
        }}
        onCancel={reset}
      />
    )
  }

  if (step === 'frequency') {
    return (
      <FrequencyStep
        choice={freqChoice}
        intervalWeeks={intervalWeeks}
        onChoiceChange={setFreqChoice}
        onIntervalWeeksChange={setIntervalWeeks}
        onCancel={reset}
        onContinue={() => {
          if (freqChoice === 'follows_payday' || freqChoice === 'follows_cycle_start') commitCreate()
          else setStep('date')
        }}
      />
    )
  }

  // step === 'date'
  return <DateStep value={date} onChange={setDate} onCancel={reset} onContinue={commitCreate} continueLabel="Create" />
}

/** The already-configured-template half of RecurringTransferEditor, above — split out once it needed its own draft/collapse state. Batch 3 (2026-09-04 UAT): this used to live-save every field the instant it changed and was always expanded; now a collapsed one-line summary by default (tap to expand), and edits are a local draft that only commits on Save/reverts on Cancel — matching every other editable card in this file (PotRow, SavingsPotRow) rather than being the one live-editing exception.
 *
 * Batch 4 (2026-09-04 UAT): gained the same mutually-exclusive
 * `followsCycleStart` checkbox the Transfer page's own recurring-transfer
 * form already has, worded identically ("Land on payday, even if it
 * moves" / "Land on the start of my budgeting cycle instead") — plus the
 * "On day of month" field greys out (and is functionally frozen, via
 * EditField's new `disabled`) whenever either checkbox is ticked, since
 * the day only matters when neither payday nor cycle-start governs the
 * date. */
function RecurringExistingDeposit({
  template,
  onUpdate,
  onRemove,
}: {
  template: RecurringTemplate
  onUpdate: (id: string, updates: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemove: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [draftAmount, setDraftAmount] = useState(template.amount)
  const [draftDay, setDraftDay] = useState(new Date(template.anchorDate).getDate())
  const [draftFollowsPayday, setDraftFollowsPayday] = useState(!!template.followsPayday)
  const [draftFollowsCycleStart, setDraftFollowsCycleStart] = useState(!!template.followsCycleStart)

  function startEditing() {
    setDraftAmount(template.amount)
    setDraftDay(new Date(template.anchorDate).getDate())
    setDraftFollowsPayday(!!template.followsPayday)
    setDraftFollowsCycleStart(!!template.followsCycleStart)
    setExpanded(true)
  }

  if (!expanded) {
    return (
      <button onClick={startEditing} className="rounded-xl p-3 flex items-center justify-between text-left" style={{ background: 'var(--color-bg-elevated)' }}>
        <div>
          <span className="text-xs font-medium text-[var(--color-ink)]">Recurring deposit</span>
          <p className="text-xs text-[var(--color-ink-muted)]">
            £{formatCurrency(template.amount)}/mo · day {new Date(template.anchorDate).getDate()}
            {template.followsPayday ? ' · follows payday' : ''}
            {template.followsCycleStart ? ' · follows cycle start' : ''}
          </p>
        </div>
        <ChevronDown size={16} className="text-[var(--color-ink-muted)] shrink-0" />
      </button>
    )
  }

  const dayFieldDisabled = draftFollowsPayday || draftFollowsCycleStart
  // UAT follow-up (2026-09-04, Adam-reported): Save used to gate on
  // `draftAmount > 0` alone — always true for an already-saved template,
  // so it sat at full brightness the instant this expanded, whether or
  // not anything had actually changed.
  const dirty =
    draftAmount !== template.amount ||
    draftDay !== new Date(template.anchorDate).getDate() ||
    draftFollowsPayday !== !!template.followsPayday ||
    draftFollowsCycleStart !== !!template.followsCycleStart

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-ink)]">Recurring deposit</span>
        <button onClick={() => onRemove(template.id)} className="text-xs" style={{ color: 'var(--color-negative)' }}>
          Remove
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Amount (£)" type="number" value={draftAmount} onChange={(v) => setDraftAmount(Number(v) || 0)} />
        <EditField
          label="On day of month"
          type="number"
          value={draftDay}
          onChange={(v) => setDraftDay(Math.min(31, Math.max(1, Number(v) || 1)))}
          disabled={dayFieldDisabled}
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <input
          type="checkbox"
          checked={draftFollowsPayday}
          onChange={(e) => {
            setDraftFollowsPayday(e.target.checked)
            if (e.target.checked) setDraftFollowsCycleStart(false)
          }}
        />
        Land on payday, even if it moves
      </label>
      <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <input
          type="checkbox"
          checked={draftFollowsCycleStart}
          onChange={(e) => {
            setDraftFollowsCycleStart(e.target.checked)
            if (e.target.checked) setDraftFollowsPayday(false)
          }}
        />
        Land on the start of my budgeting cycle instead
      </label>
      <RecurringTransferPauseControl template={template} onUpdate={(updates) => onUpdate(template.id, updates)} />
      <FormButtonRow
        onCancel={() => setExpanded(false)}
        onSave={() => {
          const anchor = new Date(template.anchorDate)
          anchor.setDate(draftDay)
          onUpdate(template.id, {
            amount: draftAmount,
            anchorDate: toLocalIsoDate(anchor),
            followsPayday: draftFollowsPayday,
            followsCycleStart: draftFollowsCycleStart,
          })
          setExpanded(false)
        }}
        saveDisabled={!(draftAmount > 0) || !dirty}
      />
    </div>
  )
}

/** Pause/resume checklist for a recurring transfer — same shared PausedOccurrencesControl widget every other recurring entity (Bills/Pensions/the old SavingsPot fields) already uses, against schedule.ts's generic template occurrence functions rather than an entity-specific pair. */
function RecurringTransferPauseControl({ template, onUpdate }: { template: RecurringTemplate; onUpdate: (updates: Partial<Omit<RecurringTemplate, 'id'>>) => void }) {
  const start = new Date()
  const end = new Date()
  end.setFullYear(end.getFullYear() + 1)
  const windowDates = scheduledTemplateDates(template, start, end)
  const currentlyPaused = new Set((template.occurrenceOverrides ?? []).filter((o) => o.deleted && windowDates.includes(o.originalDate)).map((o) => o.originalDate))

  return (
    <PausedOccurrencesControl
      windowDates={windowDates}
      currentlyPaused={currentlyPaused}
      amountForDate={() => template.amount}
      itemLabel="deposits"
      nextPaymentPreview={(tentative) => {
        const previewTemplate: RecurringTemplate = { ...template, ...setPausedTemplateOccurrences(template, windowDates, tentative) }
        return templateOccurrencePreviews(previewTemplate, new Date(), 1)[0]?.date ?? null
      }}
      onSave={(pausedDates) => onUpdate(setPausedTemplateOccurrences(template, windowDates, pausedDates))}
    />
  )
}

function SavingsPotRow({
  pot,
  people,
  transactions,
  isOpen,
  onToggle,
  onSave,
  onRemove,
  onOverrideInterest,
  onLogDeposit,
  onLogWithdrawal,
  locationOptions,
  recurringTemplates,
  onAddRecurringTransfer,
  onUpdateRecurringTemplate,
  onRemoveRecurringTemplate,
}: {
  pot: SavingsPot
  people: Person[]
  transactions: Transaction[]
  isOpen: boolean
  onToggle: () => void
  onSave: (updates: Partial<Omit<SavingsPot, 'id' | 'personId'>> & { personId?: string }) => void
  onRemove: () => void
  onOverrideInterest: (date: string, amount: number) => void
  // Phase 5 (2026-09 session) — same entry point Loans.tsx gives a loan
  // for logging an overpayment, right on the pot's own row. UAT Batch 4
  // (2026-09-04): now takes the picked OTHER location directly and calls
  // straight through to logTransfer, rather than the legacy
  // logSavingsDeposit/logSavingsWithdrawal wrappers (which always
  // assumed Current Account was the other side).
  onLogDeposit: (amount: number, date: string, from: TransferLocation, note?: string) => void
  onLogWithdrawal: (amount: number, date: string, to: TransferLocation, note?: string) => void
  locationOptions: TransferLocationOption[]
  // Transfer pill (2026-09-04 session) — the recurring deposit editor
  // below now creates/edits a RecurringTemplate against these, the same
  // "single clean consistent method" the Transactions page's Transfer
  // pill uses, rather than writing to this pot's own legacy fields.
  recurringTemplates: RecurringTemplate[]
  onAddRecurringTransfer: (template: Omit<RecurringTemplate, 'id' | 'active' | 'kind' | 'categoryId' | 'paymentMethod' | 'location' | 'ownerId' | 'payee' | 'payeeSharePercent'>) => void
  onUpdateRecurringTemplate: (id: string, updates: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemoveRecurringTemplate: (id: string) => void
}) {
  const owner = people.find((p) => p.id === pot.personId)
  const balance = savingsPotBalanceAsOf(pot, transactions, new Date())
  const nextDeposit = depositOccurrencePreviews(pot, new Date(), 1)[0]
  const [ledgerOpen, setLedgerOpen] = useState(false)

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={pot.name}>
      <div className="relative rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center gap-2">
          <button onClick={onToggle} className="flex-1 min-w-0 flex items-center justify-between text-left">
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-display text-base font-semibold text-[var(--color-ink)] truncate">{pot.name}</span>
                {people.length > 1 && <span className="text-xs text-[var(--color-ink-muted)] shrink-0">{owner?.name ?? 'Unknown'}</span>}
              </div>
              <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                £{formatCurrency(balance)} · {nextDeposit ? `next deposit ${nextDeposit.date}` : 'no recurring deposit'}
              </p>
            </div>
            <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
          </button>
          <button onClick={() => setLedgerOpen(true)} className="shrink-0 text-[var(--color-ink-faint)]" aria-label={`View ${pot.name}'s ledger`}>
            <Info size={16} />
          </button>
        </div>

        {ledgerOpen && <SavingsPotLedgerModal pot={pot} transactions={transactions} onOverrideInterest={onOverrideInterest} onClose={() => setLedgerOpen(false)} />}

        {isOpen && (
          <div className="mt-3 pt-3 border-t flex flex-col gap-3" style={{ borderColor: 'var(--color-track)' }}>
            <SavingsPotForm
              people={people}
              defaultPersonId={pot.personId}
              initial={{
                name: pot.name,
                openingBalance: pot.openingBalance,
                openingDate: pot.openingDate,
                interestMethod: pot.interestMethod,
                targetAmount: pot.targetAmount,
                targetDate: pot.targetDate,
                recurringDepositAmount: pot.recurringDepositAmount,
                recurringDepositDayOfMonth: pot.recurringDepositDayOfMonth,
              }}
              onCancel={onToggle}
              onSave={(personId, fields) => {
                // A rate CHANGE goes through applyInterestMethodChange
                // (historized, same as Pension's amount changes/a bill's
                // amount change) — but only when the method actually
                // changed, same "don't fabricate a change record for
                // nothing that moved" guard PensionRow already applies.
                const methodChanged = JSON.stringify(fields.interestMethod) !== JSON.stringify(pot.interestMethod)
                const methodPatch = methodChanged ? applyInterestMethodChange(pot, fields.interestMethod, todayIso()) : { interestMethod: fields.interestMethod }
                onSave({
                  personId,
                  name: fields.name,
                  targetAmount: fields.targetAmount,
                  targetDate: fields.targetDate,
                  recurringDepositAmount: fields.recurringDepositAmount,
                  recurringDepositDayOfMonth: fields.recurringDepositDayOfMonth,
                  recurringDepositStartDate: fields.recurringDepositAmount ? (pot.recurringDepositStartDate ?? todayIso()) : undefined,
                  ...methodPatch,
                })
                onToggle()
              }}
            />

            {/* Phase 5 (2026-09 session) — same "+ Log a payment" pattern
                Loans.tsx gives a loan, right on the pot's own row. Writes
                through logTransfer (Batch 4: now location-aware) — a
                second entry point onto the same data the Transactions
                page's Transfer pill uses, not a parallel mechanism. */}
            <LogTransferButton fixedLocation={{ type: 'savings', savingsPotId: pot.id }} locationOptions={locationOptions} onLogDeposit={onLogDeposit} onLogWithdrawal={onLogWithdrawal} />

            {/* Transfer pill (2026-09-04 session) — same discoverable,
                Loan-style entry point as before, now creating/editing a
                RecurringTemplate (kind: 'transfer') instead of this
                pot's own legacy fields, so it shows up in the
                Transactions page's Transfer pill too. */}
            <RecurringTransferEditor
              location={{ type: 'savings', savingsPotId: pot.id }}
              defaultName={pot.name}
              templates={recurringTemplates}
              locationOptions={locationOptions}
              onAdd={onAddRecurringTransfer}
              onUpdate={onUpdateRecurringTemplate}
              onRemove={onRemoveRecurringTemplate}
            />
          </div>
        )}
      </div>
    </SwipeToDelete>
  )
}

/**
 * Pause/resume the recurring deposit schedule — redesigned per Adam's
 * explicit spec (2026-09-02), replacing an earlier "Active" checkbox
 * that conflated pot-wide activity with just pausing deposits, which
 * wasn't what was asked for. Tap "Pause deposits" (inline red text, per
 * spec), pick one of the SAME last-2/next-12 deposit occurrences the
 * info-icon ledger modal shows, Save — that occurrence and everything
 * after it stops generating. The button becomes "Resume deposits";
 * picking a date there closes the pause window from that point on.
 * Growth-over-time concern (Adam's own): openPauseWindow/pauseDepositsFrom/
 * resumeDepositsFrom's own comments in savingsPotLedger.ts cover why this
 * doesn't run away — one array entry per pause CYCLE, not per skipped
 * occurrence, same shape as every other historized array in this app.
 */
/**
 * Manage paused deposits — REDESIGNED 2026-09-02 per Adam's explicit
 * correction: no separate pause/resume flow. One checklist, over the
 * SAME last-2/next-12 window the info-icon modal shows, pre-checked with
 * whichever dates are already paused. Multi-select freely, Save writes
 * the whole set in one go (setPausedDeposits reconciles the checked set
 * against recurringDepositOverrides — see its own comment). Checking a
 * date pauses it; unchecking an already-paused one un-pauses it; there's
 * no separate "resume" concept or button any more.
 */
/**
 * "+ Log a deposit / withdrawal" — Phase 5's other new entry point,
 * mirroring Loans.tsx's LoggedPaymentEditForm/"+ Log a payment" flow
 * exactly: a lightweight toggle button that reveals amount/date/type/note
 * fields, with a Cancel/Save pair, writing straight through to
 * logSavingsDeposit/logSavingsWithdrawal on save. Deliberately simpler
 * than the loan version — a deposit has no recast-mode choice to make,
 * it's genuinely just "how much, when, which direction."
 */
/**
 * UAT Batch 4 (2026-09-04, items 2/7): unifies the old LogSavingsTransactionButton/
 * LogPotTransactionButton (identical copies, one per entity type) into one
 * component — used by Savings, Pots, AND Joint alike — and rebuilt from a
 * flat "type toggle + amount + date + note" form into Adam's picker-wizard
 * spec: Deposit/Withdrawal choice, Amount, then a Location step (the
 * OTHER side — From if depositing, To if withdrawing; this entity's own
 * side is fixed and excluded from the picker), then a final Date/Note
 * screen. Writes through logTransfer directly (via the parent's
 * onLogDeposit/onLogWithdrawal, now location-aware) rather than the
 * legacy logSavingsDeposit/logPotDeposit wrappers, which always assumed
 * Current Account was the other side.
 */
function LogTransferButton({
  fixedLocation,
  locationOptions,
  onLogDeposit,
  onLogWithdrawal,
}: {
  fixedLocation: TransferLocation
  locationOptions: TransferLocationOption[]
  onLogDeposit: (amount: number, date: string, from: TransferLocation, note?: string) => void
  onLogWithdrawal: (amount: number, date: string, to: TransferLocation, note?: string) => void
}) {
  const fixedKey = transferLocationKey(fixedLocation)
  const [step, setStep] = useState<'closed' | 'type' | 'amount' | 'location' | 'final'>('closed')
  const [type, setType] = useState<'deposit' | 'withdrawal'>('deposit')
  const [amount, setAmount] = useState('')
  const [otherLocation, setOtherLocation] = useState<TransferLocationOption | null>(null)
  const [date, setDate] = useState(todayIso())
  const [note, setNote] = useState('')

  function reset() {
    setStep('closed')
    setType('deposit')
    setAmount('')
    setOtherLocation(null)
    setDate(todayIso())
    setNote('')
  }

  if (step === 'closed') {
    return (
      <button onClick={() => setStep('type')} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
        + Log a deposit or withdrawal
      </button>
    )
  }

  // Adam's explicit correction (2026-09-04): Deposit/Withdrawal is its
  // own first step here — unlike the Transactions page's Transfer pill,
  // which determines direction from its own Deposit/Withdrawal pills
  // separately, this wizard needs to know direction before the location
  // step can even correctly label itself "From" vs "To".
  if (step === 'type') {
    return (
      <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Deposit or withdrawal?</span>
          <button onClick={reset} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setType('deposit')
              setStep('amount')
            }}
            className="flex-1 py-2 rounded-full text-sm font-medium"
            style={{ background: 'var(--color-surface)', color: 'var(--color-ink)' }}
          >
            Deposit
          </button>
          <button
            onClick={() => {
              setType('withdrawal')
              setStep('amount')
            }}
            className="flex-1 py-2 rounded-full text-sm font-medium"
            style={{ background: 'var(--color-surface)', color: 'var(--color-ink)' }}
          >
            Withdrawal
          </button>
        </div>
      </div>
    )
  }

  if (step === 'amount') {
    return <AmountStep value={amount} onChange={setAmount} onCancel={reset} onContinue={() => setStep('location')} />
  }

  if (step === 'location') {
    return (
      <LocationStep
        title={type === 'deposit' ? 'From' : 'To'}
        options={locationOptions}
        excludeKey={fixedKey}
        onPick={(o) => {
          setOtherLocation(o)
          setStep('final')
        }}
        onCancel={reset}
      />
    )
  }

  // final — date + note, matching the original form's trailing fields
  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <FormButtonRow
        onCancel={reset}
        onSave={() => {
          if (!otherLocation) return
          if (type === 'deposit') onLogDeposit(Number(amount) || 0, date, otherLocation.location, note || undefined)
          else onLogWithdrawal(Number(amount) || 0, date, otherLocation.location, note || undefined)
          reset()
        }}
        saveDisabled={!(Number(amount) > 0)}
      />
    </div>
  )
}

/**
 * Info-icon ledger modal — same bottom-sheet/"tap a row to adjust"
 * pattern as CreditCardLedgerModal (Loans.tsx), against
 * buildSavingsPotScheduleRows' ramp-up window instead of a fixed
 * lookback. Only interest rows are tappable — deposits/withdrawals are
 * shown but not editable from here, per Adam's spec.
 */
function SavingsPotLedgerModal({
  pot,
  transactions,
  onOverrideInterest,
  onClose,
}: {
  pot: SavingsPot
  transactions: Transaction[]
  onOverrideInterest: (date: string, amount: number) => void
  onClose: () => void
}) {
  const rows = buildSavingsPotScheduleRows(pot, transactions)
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  function startEditing(row: { date: string; amount: number }) {
    setEditingDate(row.date)
    setEditValue(String(row.amount))
  }
  function commitEdit() {
    if (editingDate && Number(editValue) >= 0) onOverrideInterest(editingDate, Number(editValue))
    setEditingDate(null)
  }

  const rowLabel = (type: SavingsPotScheduleRow['type']) => (type === 'savings_deposit' ? 'Deposit' : type === 'savings_withdrawal' ? 'Withdrawal' : 'Interest')

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] flex flex-col"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{pot.name} — ledger</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-muted)] mb-3">Tap an interest payment to adjust it. Deposits and withdrawals come from the Transactions page.</p>

        <div className="overflow-y-auto flex-1 -mx-5 px-5 flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
          {rows.map((row) =>
            editingDate === row.date && row.type === 'savings_interest' ? (
              <div key={`${row.type}-${row.date}`} className="py-2 flex items-center gap-2">
                <span className="text-xs text-[var(--color-ink-muted)] flex-1">{row.date}</span>
                <input
                  type="number"
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-24 bg-transparent border-b border-[var(--color-track)] py-1 text-right text-[var(--color-ink)] outline-none font-mono"
                />
                <button onClick={commitEdit} className="text-xs font-semibold px-2 py-1 rounded-lg text-white" style={{ background: 'var(--color-coral)' }}>
                  Save
                </button>
                <button onClick={() => setEditingDate(null)} className="text-xs text-[var(--color-ink-muted)]">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                key={`${row.type}-${row.date}`}
                onClick={() => row.overridable && startEditing(row)}
                disabled={!row.overridable}
                className="py-2 flex items-center justify-between text-left"
              >
                <span className="text-xs text-[var(--color-ink)]">
                  {row.date} · {rowLabel(row.type)}
                  {row.status === 'pending' && <span className="text-[var(--color-ink-faint)]"> · Upcoming</span>}
                </span>
                <span className="text-xs font-mono" style={{ color: row.type === 'savings_withdrawal' ? 'var(--color-negative)' : 'var(--color-positive)' }}>
                  {row.type === 'savings_withdrawal' ? '-' : '+'}£{formatCurrency(row.amount)}
                </span>
              </button>
            ),
          )}
          {rows.length === 0 && <p className="py-4 text-center text-xs text-[var(--color-ink-faint)]">Nothing scheduled yet.</p>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * PHASE 4 (2026-09 session) — the Pots backlog item's Wallet-page half.
 * Mirrors SavingsPot's component set immediately above wherever the two
 * genuinely share shape (recurring deposit, pause control, hand-logged
 * deposit/withdrawal), and is genuinely new wherever they don't (the
 * bill/loan include/exclude checklist — see Pot's own header comment in
 * types/ledger.ts for why membership is derived, not stored). No
 * info-icon ledger modal here, deliberately — Adam's own spec: "No info
 * modal needed for this." The pot's full ledger view (deposits,
 * withdrawals, and every bill/loan payment it funds, same "this cycle /
 * next 3 cycles" style as Personal) lives on the Summary page's own pot
 * swipe card instead (Phase 7) — this row only needs enough to manage
 * the pot itself, not re-show its whole history a second time.
 */

/** Every bill/loan eligible to be paid from this pot (already personal, or already this pot's own) — shared shape between PotEditForm's checklist and its Save handler. */
/**
 * UAT Batch 4 follow-up (2026-09-04, Adam-reported): this used to filter
 * templates by `location`/`ownerId` alone, with no `kind` check — a
 * transfer template DEPOSITING into this pot resolves `location:
 * 'personal'` too (locationTypeForTransfer treats personal-leg transfers
 * that way), so it silently satisfied the "personal bill eligible to
 * move into this pot" condition and showed up here as if it were a bill,
 * unticked and reassignable, which makes no sense for money moving IN.
 * Now explicitly `kind: 'transaction'` only for bills/loans, PLUS a
 * separate, always-ticked-and-LOCKED entry for any recurring transfer
 * WITHDRAWAL already set up FROM this pot (transferFrom === this pot) —
 * that's a real standing pot outgoing worth showing here, but its
 * location isn't something this checklist can reassign (it's fixed by
 * the transfer's own from/to, edited via RecurringTransferEditor
 * instead), so it's neither a deposit nor an untickable bill.
 */
function potEligibleItems(pot: Pot, templates: RecurringTemplate[], loans: Loan[]) {
  // A real bill's `kind` is undefined in practice (never explicitly
  // 'bill' — see RecurringTemplate.kind's own comment; 'transaction' and
  // 'transfer' are the two later-added extensions), so the exclusion has
  // to be `!== 'transfer'`, not `=== 'transaction'` — the latter silently
  // excluded every real bill and made this whole checklist vanish.
  const eligibleTemplates = templates.filter(
    (t) => t.kind !== 'transfer' && t.ownerId === pot.personId && (t.location === 'personal' || (t.location === 'pot' && t.potId === pot.id)),
  )
  const eligibleLoans = loans.filter((l) => l.ownerId === pot.personId && (l.location === 'personal' || (l.location === 'pot' && l.potId === pot.id)))
  const potWithdrawals = templates.filter((t) => t.kind === 'transfer' && t.transferFrom?.type === 'pot' && t.transferFrom.potId === pot.id)
  type Item = { key: string; id: string; kind: 'template' | 'loan' | 'withdrawal'; name: string; amount: number; inPot: boolean; locked?: boolean }
  const items: Item[] = [
    ...eligibleTemplates.map((t) => ({ key: `t:${t.id}`, id: t.id, kind: 'template' as const, name: t.name, amount: t.amount, inPot: t.location === 'pot' })),
    ...eligibleLoans.map((l) => ({ key: `l:${l.id}`, id: l.id, kind: 'loan' as const, name: l.name, amount: l.monthlyPayment, inPot: l.location === 'pot' })),
    ...potWithdrawals.map((t) => ({ key: `w:${t.id}`, id: t.id, kind: 'withdrawal' as const, name: t.name, amount: t.amount, inPot: true, locked: true })),
  ]
  return items
}

/** Pot creation — person is already chosen by the PersonPickerCard step before this ever renders (Adam's spec step 1), so unlike SavingsPotForm there's no person selector here, creation-only or edit-mode split.
 *
 * Batch 3 (2026-09-04 UAT): a brand-new pot used to always start at £0 as
 * of today with no way to say otherwise — root-caused as the actual cause
 * of a reported "£100 total" bug (a stray already-cleared recurring
 * transfer occurrence was the only thing giving the pot any balance at
 * all, since there was no legitimate opening balance to anchor to). Now
 * asks new-vs-existing FIRST, same as SavingsPotForm's own step, before
 * name/checklist. */
function PotForm({
  eligibleBills,
  onCancel,
  onSave,
}: {
  eligibleBills: RecurringTemplate[]
  onCancel: () => void
  onSave: (fields: { name: string; openingBalance: number; openingDate: string; billIdsToMoveIn: string[]; effectiveFrom: string }) => void
}) {
  const [kind, setKind] = useState<'new' | 'existing' | null>(null)
  const [name, setName] = useState('')
  const [openingBalance, setOpeningBalance] = useState(0)
  const [openingDate, setOpeningDate] = useState(todayIso())
  const [checkedBillIds, setCheckedBillIds] = useState<Set<string>>(new Set())
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso())

  function toggle(id: string) {
    setCheckedBillIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (kind === null) {
    return (
      <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Is this a new pot, or one you already have?</span>
          <button onClick={onCancel} className="text-[var(--color-ink-faint)]">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => {
              setKind('new')
              setOpeningBalance(0)
              setOpeningDate(todayIso())
            }}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            New pot — starts at £0.00
          </button>
          <button
            onClick={() => setKind('existing')}
            className="w-full text-left px-3 py-2 rounded-xl text-sm text-[var(--color-ink)]"
            style={{ background: 'var(--color-surface)' }}
          >
            Existing pot — I already have a balance
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Bills"
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        />
      </Field>

      {kind === 'existing' && (
        <div className="grid grid-cols-2 gap-3 mt-3">
          <Field label="Opening balance (£)">
            <NumberInput
              inputMode="decimal"
              value={openingBalance || ''}
              onChange={(v) => setOpeningBalance(Number(v) || 0)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <EditField label="Opening date" type="date" value={openingDate} onChange={setOpeningDate} />
        </div>
      )}

      {eligibleBills.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-[var(--color-ink-muted)] mb-2">Move any existing personal bills into this pot? (optional)</p>
          <div className="flex flex-col divide-y max-h-64 overflow-y-auto" style={{ borderColor: 'var(--color-track)' }}>
            {eligibleBills.map((bill) => (
              <label key={bill.id} className="py-2 flex items-center gap-3 cursor-pointer">
                <input type="checkbox" checked={checkedBillIds.has(bill.id)} onChange={() => toggle(bill.id)} className="accent-[var(--color-coral)]" />
                <span className="flex-1 text-sm text-[var(--color-ink)] truncate">{bill.name}</span>
                <span className="text-xs font-mono text-[var(--color-ink-muted)] shrink-0">£{formatCurrency(bill.amount)}</span>
              </label>
            ))}
          </div>
          {checkedBillIds.size > 0 && (
            <div className="mt-3">
              <EditField label="Changes take effect from" type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2 mt-4">
        <button onClick={onCancel} className="flex-1 py-2 rounded-full text-sm font-medium text-[var(--color-ink-muted)]" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-track)' }}>
          Cancel
        </button>
        <button
          disabled={!name.trim()}
          onClick={() =>
            onSave({
              name: name.trim(),
              openingBalance: kind === 'existing' ? openingBalance : 0,
              openingDate: kind === 'existing' ? openingDate : todayIso(),
              billIdsToMoveIn: [...checkedBillIds],
              effectiveFrom,
            })
          }
          className="flex-1 py-2 rounded-full text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Create
        </button>
      </div>
    </div>
  )
}

/** The edit half of an expanded PotRow — Batch 3 addendum (2026-09-04 UAT): styled to match SavingsPotForm's own editing card (darker --color-bg-elevated background, fields in a 2-column grid, Save/Cancel inside the card) rather than the bare live-saving Field it used to be. Name is the only pot-level field editable here — opening balance/date are a one-time creation-only anchor, same "immutable anchor, not a live field" rule SavingsPot's own opening balance/date already follow (see SavingsPotForm's own bugfix comment).
 *
 * Batch 4 (2026-09-04 UAT): the "what this pot pays" bill/loan checklist —
 * previously its own click-to-reveal card behind a separate red inline
 * text button, sitting outside this form — is now permanently part of
 * this same card, still a checklist, saved together with the name in one
 * Save action. The red inline button is gone. */
function PotEditForm({
  pot,
  templates,
  loans,
  onCancel,
  onSave,
  onAssignTemplateLocation,
  onAssignLoanLocation,
}: {
  pot: Pot
  templates: RecurringTemplate[]
  loans: Loan[]
  onCancel: () => void
  onSave: (updates: Partial<Omit<Pot, 'id' | 'personId'>>) => void
  onAssignTemplateLocation: (templateId: string, location: 'personal' | 'pot', effectiveFrom: string, potId?: string) => void
  onAssignLoanLocation: (loanId: string, location: 'personal' | 'pot', effectiveFrom: string, potId?: string) => void
}) {
  const [name, setName] = useState(pot.name)
  const items = potEligibleItems(pot, templates, loans)
  const [checked, setChecked] = useState<Set<string>>(new Set(items.filter((i) => i.inPot).map((i) => i.key)))
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso())
  // Locked items (recurring withdrawals) are never part of the draft —
  // their checked state always reflects the real data (always `true`,
  // by construction), never the stale `checked` Set from whenever this
  // form last mounted. Without this, a withdrawal created while this
  // form stayed open (e.g. via "+ Add a recurring transfer" just below)
  // rendered unticked until the pot row was collapsed and reopened.
  const isChecked = (item: (typeof items)[number]) => (item.locked ? item.inPot : checked.has(item.key))
  const checklistDirty = items.some((i) => !i.locked && checked.has(i.key) !== i.inPot)
  const nameDirty = name.trim() !== pot.name
  // UAT follow-up (2026-09-04, Adam-reported): Save used to gate on
  // `!name.trim()` alone — always false (so always enabled) for an
  // already-named pot, regardless of whether the name or the checklist
  // had actually changed.
  const dirty = nameDirty || checklistDirty

  function toggle(key: string) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function handleSave() {
    onSave({ name: name.trim() })
    for (const item of items) {
      if (item.kind === 'withdrawal') continue // locked — its location comes from the transfer's own from/to, not reassignable here
      const nowChecked = checked.has(item.key)
      if (nowChecked === item.inPot) continue // untouched — nothing to do
      if (item.kind === 'template') onAssignTemplateLocation(item.id, nowChecked ? 'pot' : 'personal', effectiveFrom, nowChecked ? pot.id : undefined)
      else onAssignLoanLocation(item.id, nowChecked ? 'pot' : 'personal', effectiveFrom, nowChecked ? pot.id : undefined)
    }
  }

  return (
    <div className="rounded-2xl p-4" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          />
        </Field>
      </div>

      {items.length > 0 && (
        <div className="mt-4">
          <span className="text-xs font-medium text-[var(--color-ink)]">What this pot pays</span>
          <div className="flex flex-col divide-y max-h-64 overflow-y-auto mt-2" style={{ borderColor: 'var(--color-track)' }}>
            {items.map((item) => (
              <label key={item.key} className={`py-2 flex items-center gap-3 ${item.locked ? '' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={isChecked(item)}
                  disabled={item.locked}
                  onChange={() => toggle(item.key)}
                  className="accent-[var(--color-coral)] disabled:opacity-50"
                />
                <span className="flex-1 text-sm text-[var(--color-ink)] truncate">
                  {item.name}
                  {item.kind === 'withdrawal' && <span className="text-[var(--color-ink-faint)]"> · recurring withdrawal</span>}
                </span>
                <span className="text-xs font-mono text-[var(--color-ink-muted)] shrink-0">£{formatCurrency(item.amount)}</span>
              </label>
            ))}
          </div>
          {checklistDirty && (
            <div className="mt-3">
              <EditField label="Changes take effect from" type="date" value={effectiveFrom} onChange={setEffectiveFrom} />
            </div>
          )}
        </div>
      )}

      <FormButtonRow onCancel={onCancel} onSave={handleSave} saveDisabled={!name.trim() || !dirty} />
    </div>
  )
}

/** A single pot's row — collapsed summary + expand, mirroring SavingsPotRow's shape minus the ledger modal (see this section's own header comment for why). */
function PotRow({
  pot,
  people,
  templates,
  loans,
  transactions,
  isOpen,
  onToggle,
  onSave,
  onRemove,
  onLogDeposit,
  onLogWithdrawal,
  locationOptions,
  onAssignTemplateLocation,
  onAssignLoanLocation,
  onAddRecurringTransfer,
  onUpdateRecurringTemplate,
  onRemoveRecurringTemplate,
}: {
  pot: Pot
  people: Person[]
  templates: RecurringTemplate[]
  loans: Loan[]
  transactions: Transaction[]
  isOpen: boolean
  onToggle: () => void
  onSave: (updates: Partial<Omit<Pot, 'id' | 'personId'>>) => void
  onRemove: () => void
  onLogDeposit: (amount: number, date: string, from: TransferLocation, note?: string) => void
  onLogWithdrawal: (amount: number, date: string, to: TransferLocation, note?: string) => void
  locationOptions: TransferLocationOption[]
  onAssignTemplateLocation: (templateId: string, location: 'personal' | 'pot', effectiveFrom: string, potId?: string) => void
  onAssignLoanLocation: (loanId: string, location: 'personal' | 'pot', effectiveFrom: string, potId?: string) => void
  onAddRecurringTransfer: (template: Omit<RecurringTemplate, 'id' | 'active' | 'kind' | 'categoryId' | 'paymentMethod' | 'location' | 'ownerId' | 'payee' | 'payeeSharePercent'>) => void
  onUpdateRecurringTemplate: (id: string, updates: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemoveRecurringTemplate: (id: string) => void
}) {
  const owner = people.find((p) => p.id === pot.personId)
  const balance = potBalanceAsOf(pot, transactions, new Date())
  const nextDeposit = potDepositOccurrencePreviews(pot, new Date(), 1)[0]
  const payingCount = templates.filter((t) => t.location === 'pot' && t.potId === pot.id).length + loans.filter((l) => l.location === 'pot' && l.potId === pot.id).length
  // Batch 3 (2026-09-04 UAT): show the opening balance + net activity
  // since, Joint-Account-card style, rather than a single opaque current-
  // balance figure — the opening balance/date now exist on every pot
  // (see PotForm above), so there's something real to break out.
  const netActivity = balance - pot.openingBalance

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={pot.name}>
      <div className="relative rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
        <button onClick={onToggle} className="w-full flex items-center justify-between text-left">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-display text-base font-semibold text-[var(--color-ink)] truncate">{pot.name}</span>
              {people.length > 1 && <span className="text-xs text-[var(--color-ink-muted)] shrink-0">{owner?.name ?? 'Unknown'}</span>}
            </div>
            <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
              £{formatCurrency(pot.openingBalance)} opening ({formatFullDate(pot.openingDate)})
              {netActivity !== 0 ? ` · ${netActivity > 0 ? '+' : '-'}£${formatCurrency(Math.abs(netActivity))} since` : ''}
            </p>
            <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
              £{formatCurrency(balance)} now · {payingCount > 0 ? `pays ${payingCount} bill${payingCount === 1 ? '' : 's'}/loan${payingCount === 1 ? '' : 's'}` : 'not paying anything yet'}
              {nextDeposit ? ` · next deposit ${nextDeposit.date}` : ''}
            </p>
          </div>
          <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
        </button>

        {isOpen && (
          <div className="mt-3 pt-3 border-t flex flex-col gap-3" style={{ borderColor: 'var(--color-track)' }}>
            {/* Batch 3 addendum (2026-09-04 UAT): fields sit on a darker
                --color-bg-elevated card, in a 2-column grid, with the
                Cancel/Save pair INSIDE that card, matching
                SavingsPotRow's own expanded form (SavingsPotForm) — the
                red inline text buttons (Log a deposit/withdrawal,
                recurring deposit) stay outside it, below. Batch 4
                (2026-09-04 UAT): the bills/loans checklist used to be its
                own red-inline-button-gated card here too — now folded
                permanently into PotEditForm itself, see its own comment. */}
            <PotEditForm
              pot={pot}
              templates={templates}
              loans={loans}
              onCancel={onToggle}
              onSave={(updates) => { onSave(updates); onToggle() }}
              onAssignTemplateLocation={onAssignTemplateLocation}
              onAssignLoanLocation={onAssignLoanLocation}
            />

            <LogTransferButton fixedLocation={{ type: 'pot', potId: pot.id }} locationOptions={locationOptions} onLogDeposit={onLogDeposit} onLogWithdrawal={onLogWithdrawal} />
            <RecurringTransferEditor
              location={{ type: 'pot', potId: pot.id }}
              defaultName={pot.name}
              templates={templates}
              locationOptions={locationOptions}
              onAdd={onAddRecurringTransfer}
              onUpdate={onUpdateRecurringTemplate}
              onRemove={onRemoveRecurringTemplate}
            />
          </div>
        )}
      </div>
    </SwipeToDelete>
  )
}

/** People management — add (always visible)/rename/delete/Set-as-me, pulled off the Salary rows into its own surface per Adam's separation-of-concerns direction. */
function PeopleModal({
  people,
  primaryPersonId,
  onAdd,
  onRename,
  onRemove,
  onSetPrimary,
  onClose,
}: {
  people: Person[]
  primaryPersonId: string
  onAdd: (name: string) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
  onSetPrimary: (id: string) => void
  onClose: () => void
}) {
  const [newName, setNewName] = useState('')
  // The single highest-consequence delete in the app (UI consistency
  // review §2/§10 Phase 1) — reassigns everything they own to a fallback
  // person and, for pensions/savings pots, leaves them unowned entirely.
  // Given a plain "this can't be undone" undersells what actually
  // happens, this names the real consequence rather than reusing
  // SwipeToDelete's generic copy.
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null)
  const confirmingPerson = people.find((p) => p.id === confirmingRemoveId)
  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">People</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        {/* Always visible — never gated behind any other flow (linking,
            salary, etc.). See the household-ownership discussion this
            follows from: person creation is independent of everything
            else on this page and always has been. */}
        <div className="rounded-2xl p-3 mb-4 flex gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Add a person"
            className="flex-1 bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          />
          <button
            onClick={() => {
              if (!newName.trim()) return
              onAdd(newName.trim())
              setNewName('')
            }}
            className="px-3 rounded-lg font-medium text-sm"
            style={{ background: 'var(--color-coral)', color: '#fff' }}
          >
            Add
          </button>
        </div>

        <div className="flex flex-col gap-2">
          {people.map((p) => {
            const isPrimary = p.id === primaryPersonId
            return (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-2xl p-3" style={{ background: 'var(--color-bg-elevated)' }}>
                <EditablePersonName name={p.name} onRename={(name) => onRename(p.id, name)} />
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    onClick={() => onSetPrimary(p.id)}
                    disabled={isPrimary}
                    className="px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide transition-colors"
                    style={{ background: isPrimary ? 'var(--color-coral)' : 'var(--color-surface)', color: isPrimary ? '#fff' : 'var(--color-ink-muted)' }}
                    title={isPrimary ? 'This is your own dashboard view' : 'Make this your dashboard view'}
                  >
                    {isPrimary ? 'Me' : 'Set as me'}
                  </button>
                  {people.length > 1 && (
                    <button onClick={() => setConfirmingRemoveId(p.id)} className="text-[var(--color-ink-faint)]">
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {confirmingPerson && (
        <ConfirmModal
          title={`Remove ${confirmingPerson.name}?`}
          description="Their bills, loans, credit cards, pensions, and savings pots will all be reassigned to whoever's left. Already-cleared transactions stay exactly as they are, as a historical record."
          confirmLabel="Remove"
          tone="danger"
          onConfirm={() => {
            onRemove(confirmingPerson.id)
            setConfirmingRemoveId(null)
          }}
          onCancel={() => setConfirmingRemoveId(null)}
        />
      )}
    </div>,
    document.body,
  )
}

/**
 * The calendar-icon "Following" picker — one radio group per person with
 * 2+ active income sources (people with just one are never shown here at
 * all, since there's nothing to choose). Lives on whichever of Salary/
 * Pensions' headers currently hosts the calendar icon; the picker's own
 * content doesn't depend on which — it always covers the whole household.
 */
function FollowingPickerModal({
  people,
  pensions,
  payCycles,
  onChoose,
  onClose,
}: {
  people: Person[]
  pensions: Pension[]
  payCycles: PayCycleConfig[]
  onChoose: (personId: string, source: PayCycleConfig['followsIncomeSource']) => void
  onClose: () => void
}) {
  const eligible = people.filter((p) => activeIncomeSourceCount(p, pensions) >= 2)
  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Which period to follow</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">
          Every income source still generates and shows in the ledger regardless — this only decides which one's cadence sets the budgeting-cycle boundary.
        </p>
        <div className="flex flex-col gap-5">
          {eligible.map((person) => {
            const payCycle = payCycles.find((pc) => pc.personId === person.id)
            const current = payCycle?.followsIncomeSource ?? { type: 'salary' as const }
            const personPensions = pensions.filter((p) => p.personId === person.id && p.active)
            return (
              <div key={person.id}>
                {people.length > 1 && <p className="text-xs font-semibold text-[var(--color-ink-muted)] mb-2">{person.name}</p>}
                <div className="flex flex-col gap-1.5">
                  {hasSalaryConfigured(person) && (
                    <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--color-bg-elevated)' }}>
                      <input type="radio" checked={current.type === 'salary'} onChange={() => onChoose(person.id, { type: 'salary' })} />
                      <span className="text-sm text-[var(--color-ink)]">Salary</span>
                    </label>
                  )}
                  {personPensions.map((pension) => (
                    <label key={pension.id} className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--color-bg-elevated)' }}>
                      <input
                        type="radio"
                        checked={current.type === 'pension' && current.pensionId === pension.id}
                        onChange={() => onChoose(person.id, { type: 'pension', pensionId: pension.id })}
                      />
                      <span className="text-sm text-[var(--color-ink)]">{pension.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
        <button onClick={onClose} className="w-full mt-5 py-2.5 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  )
}

/** Collapsed-row summary line for a person's Salary block — mirrors LoanRow's collapsed summary. */
function SalaryRowSummary({ person, payCycle, hasSalary }: { person: Person; payCycle: PayCycleConfig | undefined; hasSalary: boolean }) {
  if (!hasSalary) {
    return <span className="text-sm" style={{ color: 'var(--color-coral)' }}>Set up salary</span>
  }
  if (!payCycle) {
    return <span className="text-sm text-[var(--color-ink-muted)]">Pay cycle not configured</span>
  }
  const today = new Date()
  const [nextPayday] = upcomingPaydays(payCycle, today, 1)
  if (!nextPayday) {
    // hasSalary but no upcoming payday resolves — the governing snapshot
    // has an end date in the past (or right at today) and nothing
    // supersedes it. Distinct message from "not configured" so it's
    // clear this was a deliberate end, not a missing setup.
    const snapshot = latestSalarySnapshot(person)
    return (
      <span className="text-sm text-[var(--color-ink-muted)]">{snapshot?.endDate ? `Ended ${snapshot.endDate}` : 'No upcoming pay'}</span>
    )
  }
  const dateIso = toLocalIsoDate(nextPayday)
  const netPay = computeNetPayForPeriod(person, dateIso)
  return (
    <span className="text-sm text-[var(--color-ink-muted)]">
      Next payday {dateIso}
      {netPay !== null && <> · £{formatCurrency(netPay)}</>}
    </span>
  )
}

/**
 * The "final salary payment" date-picker (backlog item b). Edits
 * whichever snapshot latestSalarySnapshot resolves to — NOT
 * findApplicableSnapshot(person, today), since that deliberately returns
 * null once a snapshot's own end date has passed, which would make an
 * already-ended salary's end date impossible to view or clear from this
 * field. Clearing the field (the EditField's `v || undefined` pattern,
 * same as Loans.tsx's own "End date" field) resumes indefinite
 * generation, same as it never having been set.
 */
function SalaryEndDateField({ person, onChange }: { person: Person; onChange: (snapshotId: string, endDate: string | undefined) => void }) {
  const snapshot = latestSalarySnapshot(person)
  if (!snapshot) return null
  return (
    <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <EditField label="End date (optional)" type="date" value={snapshot.endDate ?? ''} onChange={(v) => onChange(snapshot.id, v || undefined)} />
      <p className="text-xs text-[var(--color-ink-faint)] mt-1.5 leading-relaxed">
        {snapshot.endDate
          ? `No further salary payments generate after ${snapshot.endDate}. Anything already cleared isn't affected.`
          : 'Set this when this salary is ending — e.g. a new job with different accounting periods, or retiring onto a pension.'}
      </p>
    </div>
  )
}

export function Salary() {
  const {
    data,
    setData,
    addPerson,
    removePerson,
    updatePerson,
    setPrimaryPerson,
    updatePayCycle,
    addSalarySnapshot,
    updateSalarySnapshot,
    removeAllSalaryHistory,
    addSalaryOverride,
    updateSalaryOverride,
    addSavingsPot,
    updateSavingsPot,
    removeSavingsPot,
    overrideSavingsInterest,
    addPension,
    updatePension,
    removePension,
    setJointAccountOpening,
    addPot,
    updatePot,
    removePot,
    assignRecurringTemplateLocation,
    assignLoanLocation,
    addRecurringTransfer,
    updateRecurringTemplate,
    removeRecurringTemplate,
    logTransfer,
    saveSalarySort,
    clearSalarySortTarget,
    clearSalarySort,
  } = useLedgerData()
  // UAT Batch 4 (2026-09-04, items 2/7) — the same From/To picker options
  // the Transactions page's Transfer pill builds, shared via
  // lib/transferLedger.ts so the two never drift. Computed once here and
  // threaded down to every Wallet-page deposit/withdrawal/recurring
  // wizard (Savings/Pots/Joint alike) rather than each row rebuilding it.
  const transferLocationOptions = buildTransferLocationOptions(data.savingsPots, data.pots, !!data.jointAccount, data.primaryPersonId)
  const [editingJointAccount, setEditingJointAccount] = useState(false)
  const [editingDeduction, setEditingDeduction] = useState<{ personId: string; deductionId: string } | null>(null)
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null)
  // Which person's Salary row / which Pension's row is expanded — one at
  // a time per section, same pattern as Borrowing's expandedLoan/
  // expandedCard. Starts on the primary person (rather than fully
  // collapsed) since salary is the main reason most visits happen.
  const [expandedPersonId, setExpandedPersonId] = useState<string | null>(data.primaryPersonId ?? null)
  const [expandedPensionId, setExpandedPensionId] = useState<string | null>(null)
  const [addingPension, setAddingPension] = useState(false)
  const [pickingPensionPerson, setPickingPensionPerson] = useState(false)
  const [pensionDefaultPersonId, setPensionDefaultPersonId] = useState(data.primaryPersonId)
  // Salary's "+" doesn't open a form of its own (salary setup is already
  // inline on each person's row) — with 2+ candidates still needing
  // setup it shows a quick picker; with exactly one, or with everyone
  // already set up, it just expands the relevant row directly.
  const [pickingSalaryPerson, setPickingSalaryPerson] = useState(false)
  const [addingSavingsFor, setAddingSavingsFor] = useState<string | null>(null) // personId once chosen (or the sole person, immediately)
  const [pickingSavingsPerson, setPickingSavingsPerson] = useState(false)
  const [expandedPotId, setExpandedPotId] = useState<string | null>(null)
  // "Pot" (the Pots backlog item's Wallet-page entity) vs SavingsPot,
  // whose own state above already claimed the shorter names — "Bills
  // pot" both disambiguates and matches Adam's own example name for one.
  const [addingBillsPotFor, setAddingBillsPotFor] = useState<string | null>(null)
  const [pickingBillsPotPerson, setPickingBillsPotPerson] = useState(false)
  const [expandedBillsPotId, setExpandedBillsPotId] = useState<string | null>(null)
  const [peopleModalOpen, setPeopleModalOpen] = useState(false)
  const [followingPickerOpen, setFollowingPickerOpen] = useState(false)

  // All three sections (Salary, Pensions, Savings) always render, each
  // with its own "+", matching Borrowing's Loans/Credit Cards layout —
  // per Adam's own instruction, superseding this page's earlier
  // hide-when-empty treatment of Savings specifically.
  //
  // Eligible for a NEW salary: either nobody's set one up at all yet, OR
  // their CURRENT/latest snapshot has an end date set — i.e. they've
  // deliberately signalled "this salary is ending," which is exactly
  // the job-change scenario the end-date field exists for. salaryHistory
  // is already an array precisely because a person's salary changes over
  // time — there's no real "one salary per person" limit in the data, so
  // the gate isn't "already has salary," it's "has an OPEN-ENDED one,"
  // where adding a second, disconnected snapshot wouldn't mean anything
  // (a raise/change for an ongoing job goes through that snapshot's own
  // "all future" edit instead, not a brand new one).
  const peopleEligibleForNewSalary = data.people.filter((p) => {
    const latest = latestSalarySnapshot(p)
    return !latest || !!latest.endDate
  })
  const [showNoEligibleSalaryMessage, setShowNoEligibleSalaryMessage] = useState(false)
  // People button flash — draws the eye to where "add a new person"
  // actually lives, right as the "nobody eligible" message disappears,
  // since that message now also covers the "I need a NEW person, not a
  // new job" case.
  const [flashPeopleButton, setFlashPeopleButton] = useState(false)

  useEffect(() => {
    if (!showNoEligibleSalaryMessage) return
    const t = window.setTimeout(() => {
      setShowNoEligibleSalaryMessage(false)
      setFlashPeopleButton(true)
    }, 6000)
    return () => window.clearTimeout(t)
  }, [showNoEligibleSalaryMessage])

  useEffect(() => {
    if (!flashPeopleButton) return
    const t = window.setTimeout(() => setFlashPeopleButton(false), 1000)
    return () => window.clearTimeout(t)
  }, [flashPeopleButton])
  // Which person's row should show the "start a new job" form — distinct
  // from expandedPersonId's own SalarySetupForm/PayPeriodsSection choice,
  // since this applies to someone who ALREADY has salary (their row
  // already shows PayPeriodsSection) but is adding a genuinely new,
  // disconnected snapshot rather than editing the existing one.
  const [startingNewJobFor, setStartingNewJobFor] = useState<string | null>(null)
  // Whether ANYONE in the household has 2+ active income sources — the
  // calendar-icon "Following" picker is pointless (and stays fully
  // hidden) until that's true for at least one person, same "invisible
  // until it would do something" instinct as the rest of this page.
  const anyoneHasMultipleIncomeSources = data.people.some((p) => activeIncomeSourceCount(p, data.pensions) >= 2)
  // Fallback position for the calendar icon (Adam's own spec): lives on
  // the Salary section's header normally, but once NOBODY in the
  // household has any salary left at all, it moves to the Pensions
  // section header instead — both sections always render regardless, so
  // this only decides which header hosts the icon.
  const anyoneHasSalary = data.people.some(hasSalaryConfigured)

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Wallet</h1>
        <button
          onClick={() => setPeopleModalOpen(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center transition-colors duration-300"
          style={{ background: flashPeopleButton ? 'var(--color-coral)' : 'var(--color-surface)' }}
          aria-label="Manage people"
        >
          <Users size={18} className={flashPeopleButton ? 'text-white' : 'text-[var(--color-ink)]'} />
        </button>
      </header>

      <BackupSection data={data} onRestore={setData} />

      <CollapsibleSection
        title="Salary"
        className="mb-8"
        defaultOpen={anyoneHasSalary}
        headerExtra={
          <div className="flex items-center gap-2">
            {anyoneHasSalary && anyoneHasMultipleIncomeSources && <FollowingPickerButton onClick={() => setFollowingPickerOpen(true)} />}
            <AddButton
              onClick={() => {
                if (peopleEligibleForNewSalary.length === 0) {
                  setShowNoEligibleSalaryMessage(true)
                  return
                }
                const person = peopleEligibleForNewSalary[0]
                if (peopleEligibleForNewSalary.length === 1) {
                  setExpandedPersonId(person.id)
                  if (hasSalaryConfigured(person)) setStartingNewJobFor(person.id)
                } else {
                  setPickingSalaryPerson(true)
                }
              }}
            />
          </div>
        }
      >
        {showNoEligibleSalaryMessage && (
          <div className="rounded-2xl p-4 mb-4" style={{ background: 'var(--color-bg-elevated)' }}>
            <p className="text-xs text-[var(--color-ink-muted)] leading-relaxed">
              Everyone already has an ongoing salary, and none has an end date set. Set an end date on an existing
              salary first if you're changing jobs — that opens up adding the new one. Adding a salary for a NEW
              person? Add them first, using the people icon top-right.
            </p>
          </div>
        )}
        {pickingSalaryPerson && (
          <PersonPickerCard
            people={peopleEligibleForNewSalary}
            onPick={(id) => {
              setExpandedPersonId(id)
              const person = data.people.find((p) => p.id === id)
              if (person && hasSalaryConfigured(person)) setStartingNewJobFor(id)
              setPickingSalaryPerson(false)
            }}
            onCancel={() => setPickingSalaryPerson(false)}
          />
        )}
        <div className="flex flex-col gap-3">
          {/* Batch 3 addendum (2026-09-04 UAT): "always show the primary
              person at the top of the Salary section" — a display-order
              sort local to this list, not a change to data.people's own
              order (which stays whatever it was created in everywhere
              else in the app). */}
          {[...data.people].sort((a, b) => (a.id === data.primaryPersonId ? -1 : b.id === data.primaryPersonId ? 1 : 0)).map((person) => {
            const payCycle = data.payCycles.find((pc) => pc.personId === person.id)
            const hasSalary = hasSalaryConfigured(person)
            const isOpen = expandedPersonId === person.id
            const isFollowed = payCycle?.followsIncomeSource === undefined || payCycle.followsIncomeSource.type === 'salary'
            const showFollowingTag = hasSalary && isFollowed && activeIncomeSourceCount(person, data.pensions) >= 2

            return (
              <div key={person.id} className="rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-display text-base font-semibold text-[var(--color-ink)] truncate">{person.name}</span>
                    {person.id === data.primaryPersonId && <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-coral)] shrink-0">Me</span>}
                    {showFollowingTag && <FollowingTag />}
                  </div>
                  {hasSalary && (
                    <button onClick={() => setSettingsOpenFor(person.id)} className="text-[var(--color-ink-muted)] shrink-0" aria-label="Pay cycle settings">
                      <Settings size={16} />
                    </button>
                  )}
                </div>

                <button
                  onClick={() => setExpandedPersonId(isOpen ? null : person.id)}
                  className="w-full flex items-center justify-between text-left py-1"
                >
                  <SalaryRowSummary person={person} payCycle={payCycle} hasSalary={hasSalary} />
                  <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                </button>

                {isOpen && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
                    {!hasSalary ? (
                      <SalarySetupForm
                        payCycle={payCycle}
                        onSave={(fields, payCycleFields) => {
                          addSalarySnapshot(person.id, { ...fields, effectiveFrom: todayIso() })
                          updatePayCycle(person.id, payCycleFields)
                        }}
                        editingDeduction={editingDeduction}
                        setEditingDeduction={setEditingDeduction}
                      />
                    ) : payCycle ? (
                      <>
                        <PayPeriodsSection
                          person={person}
                          payCycle={payCycle}
                          data={data}
                          saveSalarySort={saveSalarySort}
                          clearSalarySortTarget={clearSalarySortTarget}
                          clearSalarySort={clearSalarySort}
                          onSaveJustThis={(dateIso, fields) => {
                            const netPay = calculateNetSalary(fields).netPerPeriod
                            const existing = person.salaryOverrides.find((o) => o.payPeriodDate === dateIso)
                            const reason = 'Salary amended (this payment only)'
                            if (existing) updateSalaryOverride(person.id, existing.id, { netPayOverride: netPay, reason })
                            else addSalaryOverride(person.id, { payPeriodDate: dateIso, netPayOverride: netPay, reason })
                          }}
                          onSaveAllFuture={(dateIso, fields) => {
                            addSalarySnapshot(person.id, { ...fields, effectiveFrom: dateIso })
                          }}
                          editingDeduction={editingDeduction}
                          setEditingDeduction={setEditingDeduction}
                        />
                        <SalaryEndDateField
                          person={person}
                          onChange={(snapshotId, endDate) => updateSalarySnapshot(person.id, snapshotId, { endDate })}
                        />
                        {/* Only reachable once this person's current
                            salary has an end date set — see
                            peopleEligibleForNewSalary's own comment for
                            why that's the gate. A raise/change for an
                            ONGOING job goes through PayPeriodsSection's
                            "all future" edit above instead, not this. */}
                        {latestSalarySnapshot(person)?.endDate &&
                          (startingNewJobFor === person.id ? (
                            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-track)' }}>
                              <h4 className="text-xs font-semibold text-[var(--color-ink)] mb-2">New job details</h4>
                              <SalarySetupForm
                                payCycle={payCycle}
                                onSave={(fields, payCycleFields) => {
                                  const latest = latestSalarySnapshot(person)
                                  const effectiveFrom = latest?.endDate ? toLocalIsoDate(addDays(new Date(latest.endDate), 1)) : todayIso()
                                  addSalarySnapshot(person.id, { ...fields, effectiveFrom })
                                  updatePayCycle(person.id, payCycleFields)
                                  setStartingNewJobFor(null)
                                }}
                                editingDeduction={editingDeduction}
                                setEditingDeduction={setEditingDeduction}
                              />
                              <button onClick={() => setStartingNewJobFor(null)} className="text-xs text-[var(--color-ink-muted)] mt-2">
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setStartingNewJobFor(person.id)}
                              className="mt-3 text-xs font-medium"
                              style={{ color: 'var(--color-coral)' }}
                            >
                              + Start a new job
                            </button>
                          ))}
                        {/* Savings now has its own section-level "+" below —
                            no per-row stopgap needed here any more. */}
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Pensions"
        className="mb-8"
        defaultOpen={data.pensions.length > 0}
        headerExtra={
          <div className="flex items-center gap-2">
            {!anyoneHasSalary && anyoneHasMultipleIncomeSources && <FollowingPickerButton onClick={() => setFollowingPickerOpen(true)} />}
            <AddButton
              onClick={() => {
                if (data.people.length === 1) {
                  setPensionDefaultPersonId(data.people[0].id)
                  setAddingPension(true)
                } else {
                  setPickingPensionPerson(true)
                }
              }}
            />
          </div>
        }
      >
        {pickingPensionPerson && (
          <PersonPickerCard
            people={data.people}
            onPick={(id) => {
              setPensionDefaultPersonId(id)
              setPickingPensionPerson(false)
              setAddingPension(true)
            }}
            onCancel={() => setPickingPensionPerson(false)}
          />
        )}
        {addingPension && (
          <PensionForm
            people={data.people}
            defaultPersonId={pensionDefaultPersonId}
            onCancel={() => setAddingPension(false)}
            onSave={(personId, fields) => {
              const id = addPension(personId, newPension({ personId, ...fields }))
              setAddingPension(false)
              setExpandedPensionId(id)
            }}
          />
        )}
        <div className="flex flex-col gap-3">
          {data.pensions.map((pension) => {
            const person = data.people.find((p) => p.id === pension.personId)
            const payCycle = data.payCycles.find((pc) => pc.personId === pension.personId)
            const isFollowed = payCycle?.followsIncomeSource?.type === 'pension' && payCycle.followsIncomeSource.pensionId === pension.id
            const showFollowingTag = isFollowed && person && activeIncomeSourceCount(person, data.pensions) >= 2
            return (
              <PensionRow
                key={pension.id}
                pension={pension}
                people={data.people}
                showFollowingTag={!!showFollowingTag}
                isOpen={expandedPensionId === pension.id}
                onToggle={() => setExpandedPensionId(expandedPensionId === pension.id ? null : pension.id)}
                onSave={(updates) => updatePension(pension.id, updates)}
                onRemove={() => removePension(pension.id)}
              />
            )
          })}
          {data.pensions.length === 0 && !addingPension && <p className="text-sm text-[var(--color-ink-muted)] text-center py-8">No pensions yet.</p>}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="Savings"
        className="mb-8"
        defaultOpen={data.savingsPots.length > 0}
        headerExtra={
          <AddButton
            onClick={() => {
              if (data.people.length === 1) setAddingSavingsFor(data.people[0].id)
              else setPickingSavingsPerson(true)
            }}
          />
        }
      >
        {pickingSavingsPerson && (
          <PersonPickerCard
            people={data.people}
            onPick={(id) => {
              setAddingSavingsFor(id)
              setPickingSavingsPerson(false)
            }}
            onCancel={() => setPickingSavingsPerson(false)}
          />
        )}
        {addingSavingsFor && (
          <SavingsPotForm
            people={data.people}
            defaultPersonId={addingSavingsFor}
            onCancel={() => setAddingSavingsFor(null)}
            onSave={(personId, fields) => {
              const id = addSavingsPot(
                personId,
                newSavingsPot({
                  personId,
                  name: fields.name,
                  openingBalance: fields.openingBalance,
                  openingDate: fields.openingDate,
                  interestMethod: fields.interestMethod,
                  targetAmount: fields.targetAmount,
                  targetDate: fields.targetDate,
                }),
              )
              if (fields.recurringDepositAmount) {
                updateSavingsPot(id, {
                  recurringDepositAmount: fields.recurringDepositAmount,
                  recurringDepositDayOfMonth: fields.recurringDepositDayOfMonth,
                  recurringDepositStartDate: fields.openingDate,
                })
              }
              setAddingSavingsFor(null)
              // BUGFIX (Adam-reported, 2026-09 session — "I have to click
              // Looks good twice before the modal disappears and
              // collapses the card"). Traced this thoroughly: there's
              // only ever one SavingsPotForm instance mounted in each
              // mode, and React 19's automatic batching means every
              // state update in this one click (addSavingsPot,
              // optionally updateSavingsPot, setAddingSavingsFor,
              // and InterestExplanationModal's own setConfirming(false))
              // commits together — I couldn't find a genuine double-
              // render in the code. The one real difference from Pot's
              // own (unreported) auto-expand-on-create is that Pot has no
              // confirm-modal step to collide with — Savings Pot's
              // InterestExplanationModal was closing on the exact same
              // click that also immediately expanded the new pot's row
              // into a second, freshly-mounted SavingsPotForm (in edit
              // mode). Removing the auto-expand removes that collision
              // entirely regardless of the precise mechanism — the new
              // pot's row now opens the way every other newly-created
              // item in this list already does (collapsed, one tap away),
              // rather than reopening it mid-creation. Flagged as a
              // best-diagnosed fix rather than a confirmed one — let me
              // know if it doesn't fully resolve the flash.
            }}
          />
        )}
        <div className="flex flex-col gap-3">
          {data.savingsPots.map((pot) => (
            <SavingsPotRow
              key={pot.id}
              pot={pot}
              people={data.people}
              transactions={data.transactions}
              isOpen={expandedPotId === pot.id}
              onToggle={() => setExpandedPotId(expandedPotId === pot.id ? null : pot.id)}
              onSave={(updates) => updateSavingsPot(pot.id, updates)}
              onRemove={() => removeSavingsPot(pot.id)}
              onOverrideInterest={(date, amount) => overrideSavingsInterest(pot.id, date, amount)}
              onLogDeposit={(amount, date, from, note) => logTransfer(from, { type: 'savings', savingsPotId: pot.id }, amount, date, note)}
              onLogWithdrawal={(amount, date, to, note) => logTransfer({ type: 'savings', savingsPotId: pot.id }, to, amount, date, note)}
              locationOptions={transferLocationOptions}
              recurringTemplates={data.recurringTemplates}
              onAddRecurringTransfer={addRecurringTransfer}
              onUpdateRecurringTemplate={updateRecurringTemplate}
              onRemoveRecurringTemplate={removeRecurringTemplate}
            />
          ))}
          {data.savingsPots.length === 0 && !addingSavingsFor && (
            <p className="text-sm text-[var(--color-ink-muted)] text-center py-8">No savings pots yet.</p>
          )}
        </div>
      </CollapsibleSection>

      {/* Pots backlog item, Phase 4 (2026-09 session) — same "always
          visible, its own +" layout as Salary/Pensions/Savings above,
          per Adam's own instruction that these sections stay consistent.
          Unlike those three, Pots doesn't need a "no pots yet" empty
          state guard on the person-picker-skip logic below — a person
          with zero eligible bills still gets a perfectly valid empty pot
          (step 3's checklist is explicitly optional), so there's nothing
          to block on. */}
      <CollapsibleSection
        title="Pots"
        className="mb-8"
        defaultOpen={data.pots.length > 0}
        headerExtra={
          <AddButton
            onClick={() => {
              if (data.people.length === 1) setAddingBillsPotFor(data.people[0].id)
              else setPickingBillsPotPerson(true)
            }}
          />
        }
      >
        {pickingBillsPotPerson && (
          <PersonPickerCard
            people={data.people}
            onPick={(id) => {
              setAddingBillsPotFor(id)
              setPickingBillsPotPerson(false)
            }}
            onCancel={() => setPickingBillsPotPerson(false)}
          />
        )}
        {addingBillsPotFor && (
          <PotForm
            eligibleBills={data.recurringTemplates.filter((t) => t.ownerId === addingBillsPotFor && t.location === 'personal')}
            onCancel={() => setAddingBillsPotFor(null)}
            onSave={({ name, openingBalance, openingDate, billIdsToMoveIn, effectiveFrom }) => {
              const personId = addingBillsPotFor
              const id = addPot(personId, newPot({ personId, name, openingBalance, openingDate }))
              for (const billId of billIdsToMoveIn) assignRecurringTemplateLocation(billId, 'pot', effectiveFrom, { potId: id })
              setAddingBillsPotFor(null)
              setExpandedBillsPotId(id)
            }}
          />
        )}
        <div className="flex flex-col gap-3">
          {data.pots.map((pot) => (
            <PotRow
              key={pot.id}
              pot={pot}
              people={data.people}
              templates={data.recurringTemplates}
              loans={data.loans}
              transactions={data.transactions}
              isOpen={expandedBillsPotId === pot.id}
              onToggle={() => setExpandedBillsPotId(expandedBillsPotId === pot.id ? null : pot.id)}
              onSave={(updates) => updatePot(pot.id, updates)}
              onRemove={() => removePot(pot.id)}
              onLogDeposit={(amount, date, from, note) => logTransfer(from, { type: 'pot', potId: pot.id }, amount, date, note)}
              onLogWithdrawal={(amount, date, to, note) => logTransfer({ type: 'pot', potId: pot.id }, to, amount, date, note)}
              locationOptions={transferLocationOptions}
              onAssignTemplateLocation={(templateId, location, effectiveFrom, potId) => assignRecurringTemplateLocation(templateId, location, effectiveFrom, { potId })}
              onAssignLoanLocation={(loanId, location, effectiveFrom, potId) => assignLoanLocation(loanId, location, effectiveFrom, { potId })}
              onAddRecurringTransfer={addRecurringTransfer}
              onUpdateRecurringTemplate={updateRecurringTemplate}
              onRemoveRecurringTemplate={removeRecurringTemplate}
            />
          ))}
          {data.pots.length === 0 && !addingBillsPotFor && <p className="text-sm text-[var(--color-ink-muted)] text-center py-8">No pots yet.</p>}
        </div>
      </CollapsibleSection>

      {/* New section (Adam-specified, 2026-09-03): only appears once a
          joint account actually exists — same "invisible until it would
          do something" instinct every other section on this page already
          follows. Adam left WHERE this should live up to us, with the
          steer "keep the UI consistent" and a guess it'd be a new Wallet
          section that appears once a joint account is detected — that's
          exactly what this is. */}
      {data.jointAccount && (
        <CollapsibleSection title="Joint Account" className="mb-8">
          <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
            {/* BUGFIX (Adam-reported, 2026-09 session) — used to be a plain
                info div with a separate text "Edit" button; every other
                card in this list (Pots, Savings Pots, Pensions) opens its
                edit surface by tapping the card itself, not a dedicated
                Edit link. Matches that now — the whole balance/date row is
                the tap target. */}
            <button onClick={() => setEditingJointAccount(true)} className="w-full flex items-center justify-between text-left">
              <div>
                <p className="text-sm font-medium text-[var(--color-ink)]">£{formatCurrency(data.jointAccount.openingBalance)} opening balance</p>
                <p className="text-xs text-[var(--color-ink-muted)]">as of {formatFullDate(data.jointAccount.openingBalanceDate)}</p>
              </div>
              <ChevronDown size={16} className="text-[var(--color-ink-muted)] shrink-0" />
            </button>

            {/* Transfer pill (2026-09-04 session, "joint account should be
                treated the same, and get the same buttons in the wallet
                page" — Adam-specified) — same log/recurring-deposit
                pattern as the Savings/Pots cards above, writing through
                the exact same logTransfer/RecurringTemplate mechanism the
                Transactions page's Transfer pill uses. */}
            <LogTransferButton
              fixedLocation={{ type: 'joint' }}
              locationOptions={transferLocationOptions}
              onLogDeposit={(amount, date, from, note) => logTransfer(from, { type: 'joint' }, amount, date, note)}
              onLogWithdrawal={(amount, date, to, note) => logTransfer({ type: 'joint' }, to, amount, date, note)}
            />
            <RecurringTransferEditor
              location={{ type: 'joint' }}
              defaultName="Joint Account"
              templates={data.recurringTemplates}
              locationOptions={transferLocationOptions}
              onAdd={addRecurringTransfer}
              onUpdate={updateRecurringTemplate}
              onRemove={removeRecurringTemplate}
            />
          </div>
        </CollapsibleSection>
      )}
      {editingJointAccount && data.jointAccount && (
        <JointAccountSetupModal
          initial={data.jointAccount}
          dismissable
          onSave={(openingBalance, openingBalanceDate) => {
            setJointAccountOpening(openingBalance, openingBalanceDate)
            setEditingJointAccount(false)
          }}
          onCancel={() => setEditingJointAccount(false)}
        />
      )}

      {peopleModalOpen && (
        <PeopleModal
          people={data.people}
          primaryPersonId={data.primaryPersonId}
          onAdd={(name) => addPerson({ name, color: '#7c6fe0' })}
          onRename={(id, name) => updatePerson(id, { name })}
          onRemove={removePerson}
          onSetPrimary={setPrimaryPerson}
          onClose={() => setPeopleModalOpen(false)}
        />
      )}

      {followingPickerOpen && (
        <FollowingPickerModal
          people={data.people}
          pensions={data.pensions}
          payCycles={data.payCycles}
          onChoose={(personId, source) => updatePayCycle(personId, { followsIncomeSource: source })}
          onClose={() => setFollowingPickerOpen(false)}
        />
      )}

      {settingsOpenFor &&
        (() => {
          const person = data.people.find((p) => p.id === settingsOpenFor)
          const payCycle = data.payCycles.find((pc) => pc.personId === settingsOpenFor)
          if (!person) return null
          return (
            <PayCycleSettingsModal
              personName={person.name}
              isPrimary={person.id === data.primaryPersonId}
              payday={payCycle?.paydayDayOfMonth ?? 28}
              adjustForNonWorkingDay={payCycle?.paydayAdjustForNonWorkingDay ?? true}
              cycleStartDay={payCycle?.cycleStartDayOfMonth ?? 1}
              cycleStartFollowsPayday={payCycle?.cycleStartFollowsPayday ?? false}
              salarySortBasis={payCycle?.salarySortBasis ?? 'payday'}
              openingBalance={payCycle?.openingBalance ?? 0}
              openingBalanceDate={payCycle?.openingBalanceDate ?? todayIso()}
              onSave={(updates) => updatePayCycle(person.id, updates)}
              onDeleteSalary={() => {
                removeAllSalaryHistory(person.id)
                setSettingsOpenFor(null)
                setExpandedPersonId(null)
              }}
              onClose={() => setSettingsOpenFor(null)}
            />
          )
        })()}

      <p className="text-xs text-[var(--color-ink-faint)] mt-6 leading-relaxed">
        Estimates use 2026/27 UK tax year rates, calculated as annual ÷ pay periods. Real payroll uses HMRC's
        cumulative period-by-period PAYE tables, so expect results within pennies of a real payslip rather than an
        exact match. Doesn't account for multiple jobs, benefits in kind, or higher/additional-rate pension relief
        reclaimed via Self Assessment.
      </p>
    </div>
  )
}

/**
 * Tap the name to rename the person — the seeded primary person starts out
 * as the literal string "Me" (lib/ledgerStorage.ts) and, until now, there
 * was nowhere in the app to change it, so it followed the person onto the
 * Summary hero card and every household/joint row for good.
 *
 * Commits on Enter or blur, reverts on Escape, and refuses to save an
 * empty name (blanking it would leave an unlabelable row with no way back
 * in). The wrapping <button> is deliberate — SwipeToDelete only skips its
 * pointer capture for taps that land on a real interactive element, so a
 * bare <h2> here would start a swipe gesture instead of a rename.
 */
function EditablePersonName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  function commit() {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== name) onRename(trimmed)
    else setDraft(name)
    setEditing(false)
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(name)
          setEditing(true)
        }}
        className="font-display text-lg font-semibold text-[var(--color-ink)] text-left"
        title="Tap to rename"
      >
        {name}
      </button>
    )
  }

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          setDraft(name)
          setEditing(false)
        }
      }}
      aria-label="Name"
      className="font-display text-lg font-semibold text-[var(--color-ink)] bg-transparent border-b border-[var(--color-coral)] outline-none w-32 py-0"
    />
  )
}

// ── One-time salary setup — disappears for good once saved, replaced by Pay Periods ──

function SalarySetupForm({
  payCycle,
  onSave,
  editingDeduction,
  setEditingDeduction,
}: {
  payCycle: PayCycleConfig | undefined
  onSave: (fields: ReturnType<typeof emptySalaryFields>, payCycleFields: Omit<PayCycleConfig, 'personId'>) => void
  editingDeduction: { personId: string; deductionId: string } | null
  setEditingDeduction: (v: { personId: string; deductionId: string } | null) => void
}) {
  const [grossAnnual, setGrossAnnual] = useState('')
  const [taxCode, setTaxCode] = useState('1257L')
  const [studentLoanPlan, setStudentLoanPlan] = useState<StudentLoanPlan>('none')
  const [payFrequency, setPayFrequency] = useState<PayFrequency>('monthly')
  const [employerPensionPercent, setEmployerPensionPercent] = useState('')
  const [deductions, setDeductions] = useState<SalaryDeduction[]>([])
  const [confirmingDeductionId, setConfirmingDeductionId] = useState<string | null>(null)

  // Mandatory pay-cycle fields, loaded from the current model (created
  // automatically alongside the person) so there's always a sensible
  // starting point — but all of them are required before saving.
  const [paydayDayOfMonth, setPaydayDayOfMonth] = useState(String(payCycle?.paydayDayOfMonth ?? 28))
  const [paydayAdjustForNonWorkingDay, setPaydayAdjustForNonWorkingDay] = useState(payCycle?.paydayAdjustForNonWorkingDay ?? true)
  const [cycleStartDayOfMonth, setCycleStartDayOfMonth] = useState(String(payCycle?.cycleStartDayOfMonth ?? 1))
  const [cycleStartFollowsPayday, setCycleStartFollowsPayday] = useState(payCycle?.cycleStartFollowsPayday ?? false)
  const [openingBalance, setOpeningBalance] = useState(payCycle ? String(payCycle.openingBalance) : '')
  const [openingBalanceDate, setOpeningBalanceDate] = useState(payCycle?.openingBalanceDate ?? todayIso())

  // fake personId placeholder for the deduction-editing modal lookup below — this form has no real person.id to key off yet until save, so it uses a fixed sentinel scoped to setup only.
  const setupDeductionKey = 'setup'

  function addDeduction() {
    const id = nanoid(6)
    setDeductions((d) => [...d, { id, name: '', type: 'relief_at_source', amountType: 'percent', amount: 0 }])
    setEditingDeduction({ personId: setupDeductionKey, deductionId: id })
  }
  function updateDeduction(id: string, patch: Partial<SalaryDeduction>) {
    setDeductions((d) => d.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  }
  function removeDeduction(id: string) {
    setDeductions((d) => d.filter((x) => x.id !== id))
  }
  function moveDeduction(id: string, direction: -1 | 1) {
    setDeductions((list) => {
      const idx = list.findIndex((d) => d.id === id)
      const swapWith = idx + direction
      if (idx < 0 || swapWith < 0 || swapWith >= list.length) return list
      const next = list.slice()
      ;[next[idx], next[swapWith]] = [next[swapWith], next[idx]]
      return next
    })
  }

  const canSave =
    Number(grossAnnual) > 0 &&
    taxCode.trim() &&
    Number(paydayDayOfMonth) >= 1 &&
    Number(paydayDayOfMonth) <= 31 &&
    Number(cycleStartDayOfMonth) >= 1 &&
    Number(cycleStartDayOfMonth) <= 31 &&
    openingBalance.trim() !== '' &&
    !Number.isNaN(Number(openingBalance)) &&
    openingBalanceDate

  return (
    <div className="mb-4">
      <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-2">Salary</h3>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <Field label="Gross annual salary (£)">
          <input
            type="number"
            inputMode="decimal"
            value={grossAnnual}
            onChange={(e) => setGrossAnnual(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
        <Field label="Tax code">
          <input
            value={taxCode}
            onChange={(e) => setTaxCode(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono uppercase"
          />
        </Field>
        <Field label="Student loan">
          <select
            value={studentLoanPlan}
            onChange={(e) => setStudentLoanPlan(e.target.value as StudentLoanPlan)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {Object.entries(STUDENT_LOAN_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Paid">
          <select
            value={payFrequency}
            onChange={(e) => setPayFrequency(e.target.value as PayFrequency)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            <option value="monthly">Monthly (12/yr)</option>
            <option value="four_weekly">Every 4 weeks (13/yr)</option>
          </select>
        </Field>
        <Field label="Employer pension %">
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            value={employerPensionPercent}
            onChange={(e) => setEmployerPensionPercent(e.target.value)}
            placeholder="0"
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-body text-sm font-semibold text-[var(--color-ink)]">Deductions</h3>
          <button onClick={addDeduction} className="text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
            + Add deduction
          </button>
        </div>
        {deductions.length === 0 && <p className="text-xs text-[var(--color-ink-faint)]">None yet — add pension contributions or anything else that comes off your pay.</p>}
        <div className="flex flex-col gap-1.5">
          {deductions.map((d) => (
            <button
              key={d.id}
              onClick={() => setEditingDeduction({ personId: setupDeductionKey, deductionId: d.id })}
              className="w-full flex items-center justify-between rounded-xl px-3 py-2.5 text-left"
              style={{ background: 'var(--color-bg-elevated)' }}
            >
              <span className="text-sm text-[var(--color-ink)]">{d.name || 'Unnamed deduction'}</span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-sm text-[var(--color-ink-muted)]">{deductionAmountLabel(d)}</span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmingDeductionId(d.id)
                  }}
                  className="text-[var(--color-ink-faint)]"
                >
                  <Trash2 size={14} />
                </span>
              </span>
            </button>
          ))}
        </div>
        {confirmingDeductionId && (
          <ConfirmModal
            title="Remove this deduction?"
            description="This can't be undone."
            confirmLabel="Remove"
            tone="danger"
            onConfirm={() => {
              removeDeduction(confirmingDeductionId)
              setConfirmingDeductionId(null)
            }}
            onCancel={() => setConfirmingDeductionId(null)}
          />
        )}
        {editingDeduction?.personId === setupDeductionKey &&
          (() => {
            const idx = deductions.findIndex((d) => d.id === editingDeduction.deductionId)
            const d = deductions[idx]
            if (!d) return null
            return (
              <DeductionModal
                deduction={d}
                canMoveUp={idx > 0}
                canMoveDown={idx < deductions.length - 1}
                onChange={(patch) => updateDeduction(d.id, patch)}
                onMove={(direction) => moveDeduction(d.id, direction)}
                onDelete={() => {
                  removeDeduction(d.id)
                  setEditingDeduction(null)
                }}
                onClose={() => setEditingDeduction(null)}
              />
            )
          })()}
      </div>

      <div className="mb-4">
        <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-2">Pay cycle</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payday (day of month)">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={paydayDayOfMonth}
              onChange={(e) => setPaydayDayOfMonth(e.target.value)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label={cycleStartFollowsPayday ? 'Budgeting cycle starts on (following payday)' : 'Budgeting cycle starts on'}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={cycleStartDayOfMonth}
              disabled={cycleStartFollowsPayday}
              onChange={(e) => setCycleStartDayOfMonth(e.target.value)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono disabled:opacity-40"
            />
          </Field>
          <Field label="Opening balance (£)">
            <input
              type="number"
              inputMode="decimal"
              value={openingBalance}
              onChange={(e) => setOpeningBalance(e.target.value)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label="...as of">
            <input
              type="date"
              value={openingBalanceDate}
              onChange={(e) => setOpeningBalanceDate(e.target.value)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 mt-3">
          <input type="checkbox" checked={paydayAdjustForNonWorkingDay} onChange={(e) => setPaydayAdjustForNonWorkingDay(e.target.checked)} />
          <span className="text-xs text-[var(--color-ink-muted)]">If payday falls on a weekend or UK bank holiday, pay on the last working day before it</span>
        </label>
        <label className="flex items-center gap-2 mt-2.5">
          <input type="checkbox" checked={cycleStartFollowsPayday} onChange={(e) => setCycleStartFollowsPayday(e.target.checked)} />
          <span className="text-xs text-[var(--color-ink-muted)]">
            Start the budgeting cycle on payday itself, weekend/bank-holiday adjustment included
          </span>
        </label>
      </div>

      <button
        disabled={!canSave}
        onClick={() =>
          onSave(
            {
              grossAnnual: Number(grossAnnual),
              taxCode: taxCode.trim(),
              studentLoanPlan,
              payFrequency,
              deductions,
              employerPensionPercent: employerPensionPercent ? Number(employerPensionPercent) : undefined,
            },
            {
              paydayDayOfMonth: Number(paydayDayOfMonth),
              paydayAdjustForNonWorkingDay,
              cycleStartDayOfMonth: Number(cycleStartDayOfMonth),
              cycleStartFollowsPayday,
              openingBalance: Number(openingBalance),
              openingBalanceDate,
            },
          )
        }
        className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Set up salary
      </button>
    </div>
  )
}

// ── Pay cycle settings — payday, weekend adjustment, cycle boundary, opening balance. Moved out of the main flow behind the settings cog, since it's set once and rarely touched. ──

function PayCycleSettingsModal({
  personName,
  isPrimary,
  payday,
  adjustForNonWorkingDay,
  cycleStartDay,
  cycleStartFollowsPayday,
  salarySortBasis,
  openingBalance,
  openingBalanceDate,
  onSave,
  onDeleteSalary,
  onClose,
}: {
  personName: string
  isPrimary: boolean
  payday: number
  adjustForNonWorkingDay: boolean
  cycleStartDay: number
  cycleStartFollowsPayday: boolean
  salarySortBasis: 'payday' | 'budget_cycle'
  openingBalance: number
  openingBalanceDate: string
  onSave: (updates: {
    paydayDayOfMonth: number
    paydayAdjustForNonWorkingDay: boolean
    cycleStartDayOfMonth: number
    cycleStartFollowsPayday: boolean
    salarySortBasis: 'payday' | 'budget_cycle'
    openingBalance: number
    openingBalanceDate: string
  }) => void
  onDeleteSalary: () => void
  onClose: () => void
}) {
  // Staged draft — was previously live-applying every keystroke straight
  // to updatePayCycle via an onChange prop, which meant "Done" was purely
  // a dismiss button with nothing to cancel. Converted per Adam's
  // explicit call (UI consistency review §1/§10 Phase 3) to match every
  // other edit panel in the app: edits stay local until Save commits
  // them; Cancel discards the draft and reverts to nothing having
  // changed at all, not just to whatever the fields happened to read.
  const [draftPayday, setDraftPayday] = useState(payday)
  const [draftAdjust, setDraftAdjust] = useState(adjustForNonWorkingDay)
  const [draftCycleStartDay, setDraftCycleStartDay] = useState(cycleStartDay)
  const [draftCycleFollowsPayday, setDraftCycleFollowsPayday] = useState(cycleStartFollowsPayday)
  const [draftSalarySortBasis, setDraftSalarySortBasis] = useState<'payday' | 'budget_cycle'>(salarySortBasis)
  const [draftOpeningBalance, setDraftOpeningBalance] = useState(String(openingBalance))
  const [draftOpeningBalanceDate, setDraftOpeningBalanceDate] = useState(openingBalanceDate)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  // UAT follow-up (2026-09-04, Adam-requested app-wide sweep): dims Save
  // when nothing's changed, same rule the new Transfer wizards follow.
  const dirty =
    draftPayday !== payday ||
    draftAdjust !== adjustForNonWorkingDay ||
    draftCycleStartDay !== cycleStartDay ||
    draftCycleFollowsPayday !== cycleStartFollowsPayday ||
    draftSalarySortBasis !== salarySortBasis ||
    (Number(draftOpeningBalance) || 0) !== openingBalance ||
    draftOpeningBalanceDate !== openingBalanceDate

  function handleSave() {
    onSave({
      paydayDayOfMonth: draftPayday,
      paydayAdjustForNonWorkingDay: draftAdjust,
      cycleStartDayOfMonth: draftCycleStartDay,
      cycleStartFollowsPayday: draftCycleFollowsPayday,
      salarySortBasis: draftSalarySortBasis,
      openingBalance: Number(draftOpeningBalance) || 0,
      openingBalanceDate: draftOpeningBalanceDate,
    })
    onClose()
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{personName}'s pay cycle</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">Set once, rarely touched again.</p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Payday (day of month)">
            <NumberInput
              inputMode="numeric"
              min={1}
              max={31}
              value={draftPayday}
              onChange={(v) => setDraftPayday(Math.max(1, Math.min(31, Number(v) || 1)))}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label={draftCycleFollowsPayday ? 'Budgeting cycle starts on (following payday)' : 'Budgeting cycle starts on'}>
            <NumberInput
              inputMode="numeric"
              min={1}
              max={31}
              value={draftCycleStartDay}
              disabled={draftCycleFollowsPayday}
              onChange={(v) => setDraftCycleStartDay(Math.max(1, Math.min(31, Number(v) || 1)))}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono disabled:opacity-40"
            />
          </Field>
          <Field label="Opening balance (£)">
            <input
              type="number"
              inputMode="decimal"
              value={draftOpeningBalance}
              onChange={(e) => setDraftOpeningBalance(e.target.value)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label="...as of">
            <input
              type="date"
              value={draftOpeningBalanceDate}
              onChange={(e) => setDraftOpeningBalanceDate(e.target.value)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 mt-3">
          <input type="checkbox" checked={draftAdjust} onChange={(e) => setDraftAdjust(e.target.checked)} />
          <span className="text-xs text-[var(--color-ink-muted)]">
            If payday falls on a weekend or UK bank holiday, pay on the last working day before it
          </span>
        </label>
        <label className="flex items-center gap-2 mt-2.5">
          <input type="checkbox" checked={draftCycleFollowsPayday} onChange={(e) => setDraftCycleFollowsPayday(e.target.checked)} />
          <span className="text-xs text-[var(--color-ink-muted)]">
            Start the budgeting cycle on payday itself, weekend/bank-holiday adjustment included
          </span>
        </label>
        <p className="text-xs text-[var(--color-ink-faint)] mt-2">
          {draftCycleFollowsPayday ? (
            <>
              Each cycle now runs from one payday to the day before the next, so a payday that shifts earlier takes its
              cycle boundary with it. The day above is kept but unused — untick to go back to it.
            </>
          ) : (
            <>The budgeting cycle boundary stays fixed even when the actual payday drifts a day or two earlier.</>
          )}{' '}
          Nothing dated before the opening balance date will appear anywhere in {personName}'s ledger.
        </p>

        {isPrimary && (
          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--color-track)' }}>
            <p className="text-xs font-semibold text-[var(--color-ink-muted)] mb-2">Salary Sort suggestions follow</p>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--color-bg-elevated)' }}>
                <input type="radio" checked={draftSalarySortBasis === 'payday'} onChange={() => setDraftSalarySortBasis('payday')} />
                <span className="text-sm text-[var(--color-ink)]">Payday — the window is this payday up to the day before the next</span>
              </label>
              <label className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: 'var(--color-bg-elevated)' }}>
                <input type="radio" checked={draftSalarySortBasis === 'budget_cycle'} onChange={() => setDraftSalarySortBasis('budget_cycle')} />
                <span className="text-sm text-[var(--color-ink)]">My budgeting cycle — even if it doesn't track payday</span>
              </label>
            </div>
          </div>
        )}

        <FormButtonRow onCancel={onClose} onSave={handleSave} saveDisabled={!dirty} />

        <div className="mt-6 pt-4 border-t" style={{ borderColor: 'var(--color-track)' }}>
          <button onClick={() => setConfirmingDelete(true)} className="w-full text-center py-2 text-xs font-medium text-[var(--color-ink-faint)]">
            Delete {personName}'s salary
          </button>
          {confirmingDelete && (
            <ConfirmModal
              title={`Delete ${personName}'s salary?`}
              description="Deletes every salary snapshot and override. Already-cleared payments stay in the ledger as plain income — only future ones stop."
              confirmLabel="Delete"
              tone="danger"
              onConfirm={() => {
                setConfirmingDelete(false)
                onDeleteSalary()
              }}
              onCancel={() => setConfirmingDelete(false)}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── Pay periods — upcoming (next 4) + collapsed history, both tappable into the SAME unified editor ──

function PayPeriodsSection({
  person,
  payCycle,
  data,
  saveSalarySort,
  clearSalarySortTarget,
  clearSalarySort,
  onSaveJustThis,
  onSaveAllFuture,
  editingDeduction,
  setEditingDeduction,
}: {
  person: Person
  payCycle: PayCycleConfig
  data: AppDataV2
  saveSalarySort: (payDate: string, targets: { to: TransferLocation; amount: number }[]) => void
  clearSalarySortTarget: (payDate: string, location: TransferLocation) => void
  clearSalarySort: (payDate: string) => void
  onSaveJustThis: (dateIso: string, fields: ReturnType<typeof emptySalaryFields>) => void
  onSaveAllFuture: (dateIso: string, fields: ReturnType<typeof emptySalaryFields>) => void
  editingDeduction: { personId: string; deductionId: string } | null
  setEditingDeduction: (v: { personId: string; deductionId: string } | null) => void
}) {
  const [expandedDate, setExpandedDate] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [flashDates, setFlashDates] = useState<string[]>([])

  useEffect(() => {
    if (flashDates.length === 0) return
    const t = window.setTimeout(() => setFlashDates([]), 1300)
    return () => window.clearTimeout(t)
  }, [flashDates])

  const today = new Date()
  // 4, matching the Summary page's "Next 3 cycles" horizon (current +
  // THREE_CYCLES_AHEAD). These two views are read side by side, so a
  // payday that Summary projects into its window but Salary doesn't list
  // reads as a missing period rather than a difference of horizon.
  // Sourced from the shared constant so the two can't drift apart.
  // Filtered through computeNetPayForPeriod !== null so a period past the
  // person's salary end date (backlog item b) drops out of this editable
  // list entirely, rather than showing as a hollow £0.00 row — this list
  // is a synthetic calendar projection for editing, not the real
  // Transaction ledger, so removing a date here never touches an
  // already-materialized/cleared transaction elsewhere in the app.
  const upcoming = upcomingPaydays(payCycle, today, 1 + THREE_CYCLES_AHEAD)
    .map(toLocalIsoDate)
    .filter((d) => computeNetPayForPeriod(person, d) !== null)
  const closed = closedPaydays(payCycle, today, 6)
    .map(toLocalIsoDate)
    .filter((d) => computeNetPayForPeriod(person, d) !== null)
  // REDESIGN (Adam-specified, 2026-09-02): History used to also include
  // the most-recent payment — the same row shown twice, once prominently
  // above Upcoming, once again inside History. Now History is
  // everything BEFORE the most recent one only; "Most recent pay" is the
  // sole place that row appears. historyOnly stays empty until there's a
  // SECOND past payment.
  const mostRecent = closed.length > 0 ? closed[closed.length - 1] : null
  const historyOnly = mostRecent ? closed.slice(0, -1) : closed

  // Saving "just this" period only ever affects the one row being edited.
  function handleSaveJustThis(dateIso: string, fields: ReturnType<typeof emptySalaryFields>) {
    onSaveJustThis(dateIso, fields)
    setExpandedDate(null)
    setFlashDates([dateIso])
  }

  // "This and all future payments" affects every upcoming payday from
  // dateIso onward, so flash all of those rows — not just the one that
  // was expanded — so the user can see everything that changed.
  function handleSaveAllFuture(dateIso: string, fields: ReturnType<typeof emptySalaryFields>) {
    onSaveAllFuture(dateIso, fields)
    setExpandedDate(null)
    setFlashDates(upcoming.filter((d) => d >= dateIso))
  }

  return (
    <div className="mb-4">
      {mostRecent && (
        <>
          <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-2">Most recent pay</h3>
          <div className="flex flex-col gap-2 mb-3">
            <PayPeriodRow
              person={person}
              dateIso={mostRecent}
              isClosed
              canSort={data.primaryPersonId === person.id}
              data={data}
              payCycle={payCycle}
              saveSalarySort={saveSalarySort}
              clearSalarySortTarget={clearSalarySortTarget}
              clearSalarySort={clearSalarySort}
              isOpen={expandedDate === mostRecent}
              flashing={flashDates.includes(mostRecent)}
              onToggle={() => setExpandedDate(expandedDate === mostRecent ? null : mostRecent)}
              onSaveJustThis={(fields) => handleSaveJustThis(mostRecent, fields)}
              onSaveAllFuture={(fields) => handleSaveAllFuture(mostRecent, fields)}
              editingDeduction={editingDeduction}
              setEditingDeduction={setEditingDeduction}
            />
          </div>
        </>
      )}

      <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-2">Upcoming pay</h3>
      <div className="flex flex-col gap-2 mb-3">
        {upcoming.map((dateIso) => (
          <PayPeriodRow
            key={dateIso}
            person={person}
            dateIso={dateIso}
            isClosed={false}
            canSort={data.primaryPersonId === person.id}
            data={data}
            payCycle={payCycle}
            saveSalarySort={saveSalarySort}
            clearSalarySortTarget={clearSalarySortTarget}
            clearSalarySort={clearSalarySort}
            isOpen={expandedDate === dateIso}
            flashing={flashDates.includes(dateIso)}
            onToggle={() => setExpandedDate(expandedDate === dateIso ? null : dateIso)}
            onSaveJustThis={(fields) => handleSaveJustThis(dateIso, fields)}
            onSaveAllFuture={(fields) => handleSaveAllFuture(dateIso, fields)}
            editingDeduction={editingDeduction}
            setEditingDeduction={setEditingDeduction}
          />
        ))}
      </div>

      <button onClick={() => setShowHistory(!showHistory)} className="flex items-center justify-between w-full py-1 text-xs font-medium text-[var(--color-ink-muted)]">
        <span>History ({historyOnly.length})</span>
        {showHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {showHistory && (
        <div className="flex flex-col gap-2 mt-2">
          {historyOnly.map((dateIso) => (
            <PayPeriodRow
              key={dateIso}
              person={person}
              dateIso={dateIso}
              isClosed
              canSort={false}
              data={data}
              payCycle={payCycle}
              saveSalarySort={saveSalarySort}
              clearSalarySortTarget={clearSalarySortTarget}
              clearSalarySort={clearSalarySort}
              isOpen={expandedDate === dateIso}
              flashing={flashDates.includes(dateIso)}
              onToggle={() => setExpandedDate(expandedDate === dateIso ? null : dateIso)}
              onSaveJustThis={(fields) => handleSaveJustThis(dateIso, fields)}
              onSaveAllFuture={(fields) => handleSaveAllFuture(dateIso, fields)}
              editingDeduction={editingDeduction}
              setEditingDeduction={setEditingDeduction}
            />
          ))}
          {historyOnly.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] px-1">No earlier pay periods yet.</p>}
        </div>
      )}
    </div>
  )
}

function PayPeriodRow({
  person,
  dateIso,
  isClosed,
  canSort,
  data,
  payCycle,
  saveSalarySort,
  clearSalarySortTarget,
  clearSalarySort,
  isOpen,
  flashing,
  onToggle,
  onSaveJustThis,
  onSaveAllFuture,
  editingDeduction,
  setEditingDeduction,
}: {
  person: Person
  dateIso: string
  isClosed: boolean
  canSort: boolean
  data: AppDataV2
  payCycle: PayCycleConfig
  saveSalarySort: (payDate: string, targets: { to: TransferLocation; amount: number }[]) => void
  clearSalarySortTarget: (payDate: string, location: TransferLocation) => void
  clearSalarySort: (payDate: string) => void
  isOpen: boolean
  flashing: boolean
  onToggle: () => void
  onSaveJustThis: (fields: ReturnType<typeof emptySalaryFields>) => void
  onSaveAllFuture: (fields: ReturnType<typeof emptySalaryFields>) => void
  editingDeduction: { personId: string; deductionId: string } | null
  setEditingDeduction: (v: { personId: string; deductionId: string } | null) => void
}) {
  const netPay = computeNetPayForPeriod(person, dateIso)
  const existingOverride = person.salaryOverrides.find((o) => o.payPeriodDate === dateIso)
  const [sortOpen, setSortOpen] = useState(false)
  // Hidden entirely with no pots/savings pots/joint account to sort into
  // (Adam's explicit 2026-09 call) — canSort itself already restricts
  // this to the primary person's Most-recent/Upcoming rows only, per the
  // caller.
  const showSortIcon = canSort && hasSalarySortDestinations(data)
  const existingSort = data.salarySorts.find((s) => s.payDate === dateIso)

  return (
    <div className="relative rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="w-full flex items-center gap-2 px-3 py-2.5">
        {showSortIcon && (
          <button
            onClick={() => setSortOpen(true)}
            aria-label="Sort this salary"
            className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
            style={{ background: existingSort ? 'var(--color-coral)' : 'var(--color-surface)' }}
          >
            <ArrowUpDown size={13} className={existingSort ? 'text-white' : 'text-[var(--color-ink-muted)]'} />
          </button>
        )}
        <button onClick={onToggle} className="flex-1 flex items-center justify-between text-left min-w-0">
          <span className="text-sm text-[var(--color-ink)]">
            {dateIso}
            {existingOverride?.bonusGrossAmount && <span className="text-xs text-[var(--color-coral)]"> · Bonus attached</span>}
            {existingOverride && !existingOverride.bonusGrossAmount && <span className="text-xs text-[var(--color-coral)]"> · Adjusted</span>}
          </span>
          <span className="font-mono text-sm text-[var(--color-ink)]">£{formatCurrency(netPay ?? 0)}</span>
        </button>
      </div>
      {isOpen && (
        <PeriodEditor
          person={person}
          dateIso={dateIso}
          isClosed={isClosed}
          existingOverride={existingOverride}
          onSaveJustThis={onSaveJustThis}
          onSaveAllFuture={onSaveAllFuture}
          editingDeduction={editingDeduction}
          setEditingDeduction={setEditingDeduction}
        />
      )}
      {sortOpen && (
        <SalarySortModal
          payDate={dateIso}
          data={data}
          payCycle={payCycle}
          onSave={(targets) => {
            saveSalarySort(dateIso, targets)
            setSortOpen(false)
          }}
          onClearTarget={(location) => clearSalarySortTarget(dateIso, location)}
          onClearAll={() => {
            clearSalarySort(dateIso)
            setSortOpen(false)
          }}
          onClose={() => setSortOpen(false)}
        />
      )}
      <SavedFlashOverlay active={flashing} />
    </div>
  )
}

/**
 * The sort icon's modal (App_Dev.md "Salary Sorter & Transfer Pill",
 * 2026-09 session). One row per available destination (savings
 * pots/pots the primary person owns, plus joint if it exists —
 * salarySortDestinations already applies that filter). Each row's
 * PREFILL is the existing saved target's amount if this payDate already
 * has a sort touching that destination, otherwise salarySortSuggestion's
 * own prefill (last-sorted-if-any, else total due); the small label
 * below always shows salarySortSuggestion's own reasonLabel regardless
 * (total due always wins the label text — see that function's own
 * comment). Save runs the reverse-of-the-usual conflict guard only
 * against NEWLY-added targets (a location this payDate's sort didn't
 * already cover) — re-saving an unchanged existing target isn't "sorting
 * a salary" into it again, so it doesn't re-trigger the prompt.
 */
function SalarySortModal({
  payDate,
  data,
  payCycle,
  onSave,
  onClearTarget,
  onClearAll,
  onClose,
}: {
  payDate: string
  data: AppDataV2
  payCycle: PayCycleConfig
  onSave: (targets: { to: TransferLocation; amount: number }[]) => void
  onClearTarget: (location: TransferLocation) => void
  onClearAll: () => void
  onClose: () => void
}) {
  const destinations = salarySortDestinations(data)
  const existingSort = data.salarySorts.find((s) => s.payDate === payDate)

  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const d of destinations) {
      const existingTarget = existingSort?.targets.find((t) => locationsEqual(t.to, d.location))
      if (existingTarget) {
        initial[transferLocationKey(d.location)] = String(existingTarget.amount)
      } else {
        const suggestion = salarySortSuggestion(data, payCycle, payDate, d.location)
        initial[transferLocationKey(d.location)] = suggestion.prefillAmount > 0 ? String(suggestion.prefillAmount) : ''
      }
    }
    return initial
  })

  const [confirmingClearLocation, setConfirmingClearLocation] = useState<TransferLocation | null>(null)
  const [confirmingClearAll, setConfirmingClearAll] = useState(false)
  const [conflictQueue, setConflictQueue] = useState<{ location: TransferLocation; label: string }[] | null>(null)
  const [queuePos, setQueuePos] = useState(0)
  const [pendingTargets, setPendingTargets] = useState<{ to: TransferLocation; amount: number }[]>([])
  const [skipped, setSkipped] = useState<TransferLocation[]>([])

  // UAT follow-up (2026-09-04, Adam-requested app-wide sweep): dims Save
  // when the draft amounts (after the same >0 filter Save itself applies)
  // exactly match what's already saved for this payday — a suggested
  // prefill the person hasn't touched still counts as "nothing to save"
  // until it would actually change a real target.
  const draftTargets = destinations.map((d) => ({ to: d.location, amount: Number(drafts[transferLocationKey(d.location)]) || 0 })).filter((t) => t.amount > 0)
  const currentTargets = existingSort?.targets ?? []
  const dirty =
    draftTargets.length !== currentTargets.length ||
    draftTargets.some((t) => !currentTargets.some((ct) => locationsEqual(ct.to, t.to) && ct.amount === t.amount))

  function handleSaveClick() {
    const targets = destinations.map((d) => ({ to: d.location, amount: Number(drafts[transferLocationKey(d.location)]) || 0 })).filter((t) => t.amount > 0)
    const conflicts = targets
      .filter((t) => !existingSort?.targets.some((et) => locationsEqual(et.to, t.to)))
      .filter((t) => !!findOneOffTransferConflict(data, payDate, t.to) || !!findRecurringTransferConflict(data, payCycle, payDate, t.to))
      .map((t) => ({ location: t.to, label: transferLocationLabel(t.to, data.savingsPots, data.pots) }))

    if (conflicts.length === 0) {
      onSave(targets)
      return
    }
    setPendingTargets(targets)
    setConflictQueue(conflicts)
    setQueuePos(0)
    setSkipped([])
  }

  function respondToConflict(goAhead: boolean) {
    if (!conflictQueue) return
    const current = conflictQueue[queuePos]
    const nextSkipped = goAhead ? skipped : [...skipped, current.location]
    const nextPos = queuePos + 1
    if (nextPos >= conflictQueue.length) {
      const final = pendingTargets.filter((t) => !nextSkipped.some((loc) => locationsEqual(loc, t.to)))
      setConflictQueue(null)
      setQueuePos(0)
      setSkipped([])
      onSave(final)
    } else {
      setSkipped(nextSkipped)
      setQueuePos(nextPos)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Sort this salary</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-faint)] mb-4">{payDate} — moves money out of your Current Account into wherever you choose below.</p>

        <div className="flex flex-col gap-4">
          {destinations.map((d) => {
            const key = transferLocationKey(d.location)
            const suggestion = salarySortSuggestion(data, payCycle, payDate, d.location)
            const hasSavedTarget = !!existingSort?.targets.some((t) => locationsEqual(t.to, d.location))
            return (
              <div key={key} className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-[var(--color-ink)]">{d.label}</span>
                  <button
                    onClick={() => {
                      if (hasSavedTarget) setConfirmingClearLocation(d.location)
                      else setDrafts((prev) => ({ ...prev, [key]: '' }))
                    }}
                    className="text-xs text-[var(--color-ink-faint)]"
                  >
                    Clear
                  </button>
                </div>
                <NumberInput
                  inputMode="decimal"
                  value={drafts[key] ?? ''}
                  onChange={(v) => setDrafts((prev) => ({ ...prev, [key]: v }))}
                  className={`w-full bg-transparent border-b border-[var(--color-track)] py-1 outline-none font-mono ${
                    hasSavedTarget ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-muted)]'
                  }`}
                />
                <p className="text-xs text-[var(--color-ink-faint)]">{suggestion.reasonLabel}</p>
              </div>
            )
          })}
        </div>

        <FormButtonRow onCancel={onClose} onSave={handleSaveClick} saveDisabled={!dirty} />

        {existingSort && (
          <button onClick={() => setConfirmingClearAll(true)} className="w-full text-center py-2 mt-3 text-xs font-medium" style={{ color: 'var(--color-negative)' }}>
            Clear this sort
          </button>
        )}

        {confirmingClearLocation && (
          <ConfirmModal
            title="Clear this transfer?"
            description={`Removes the transfer to ${transferLocationLabel(confirmingClearLocation, data.savingsPots, data.pots)} entirely. This can't be undone.`}
            confirmLabel="Clear"
            tone="danger"
            onConfirm={() => {
              onClearTarget(confirmingClearLocation)
              setDrafts((prev) => ({ ...prev, [transferLocationKey(confirmingClearLocation)]: '' }))
              setConfirmingClearLocation(null)
            }}
            onCancel={() => setConfirmingClearLocation(null)}
          />
        )}

        {confirmingClearAll && (
          <ConfirmModal
            title="Clear this salary sort?"
            description="Removes every transfer it created. This can't be undone."
            confirmLabel="Clear"
            tone="danger"
            onConfirm={() => {
              setConfirmingClearAll(false)
              onClearAll()
            }}
            onCancel={() => setConfirmingClearAll(false)}
          />
        )}

        {conflictQueue && queuePos < conflictQueue.length && (
          <ConfirmModal
            title="Already sorted"
            description={`${conflictQueue[queuePos].label} already has a scheduled or recurring transfer on this date. Go ahead and add the sort's transfer too, or skip it.`}
            confirmLabel="Go ahead"
            cancelLabel="Skip"
            onConfirm={() => respondToConflict(true)}
            onCancel={() => respondToConflict(false)}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}

type SalaryDraftFields = ReturnType<typeof emptySalaryFields>

// ── The unified period editor — identical for upcoming AND closed periods. Same breakdown, same fields, same "+ Add bonus", one Save action (with the scope-confirm modal for upcoming periods only). ──

function PeriodEditor({
  person,
  dateIso,
  isClosed,
  existingOverride,
  onSaveJustThis,
  onSaveAllFuture,
  editingDeduction,
  setEditingDeduction,
}: {
  person: Person
  dateIso: string
  isClosed: boolean
  existingOverride?: Person['salaryOverrides'][number]
  onSaveJustThis: (fields: SalaryDraftFields) => void
  onSaveAllFuture: (fields: SalaryDraftFields) => void
  editingDeduction: { personId: string; deductionId: string } | null
  setEditingDeduction: (v: { personId: string; deductionId: string } | null) => void
}) {
  const applicableSnapshot = findApplicableSnapshot(person, dateIso)
  const [draft, setDraft] = useState<SalaryDraftFields>(() =>
    applicableSnapshot
      ? {
          grossAnnual: applicableSnapshot.grossAnnual,
          taxCode: applicableSnapshot.taxCode,
          studentLoanPlan: applicableSnapshot.studentLoanPlan,
          payFrequency: applicableSnapshot.payFrequency,
          deductions: applicableSnapshot.deductions,
          employerPensionPercent: applicableSnapshot.employerPensionPercent,
        }
      : emptySalaryFields(),
  )
  const [confirming, setConfirming] = useState(false)
  const [confirmingDeductionId, setConfirmingDeductionId] = useState<string | null>(null)

  if (!applicableSnapshot) {
    return (
      <div className="px-3 pb-3 pt-1">
        <p className="text-xs text-[var(--color-ink-faint)]">No salary was configured as of this date yet.</p>
      </div>
    )
  }

  const fullDraft = draft
  // UAT follow-up (2026-09-04, Adam-reported): Save had NO disabled state
  // at all here — full brightness the instant this period expanded,
  // regardless of whether anything had changed. Compared against the
  // same applicableSnapshot-derived shape the draft was seeded from.
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify({
      grossAnnual: applicableSnapshot.grossAnnual,
      taxCode: applicableSnapshot.taxCode,
      studentLoanPlan: applicableSnapshot.studentLoanPlan,
      payFrequency: applicableSnapshot.payFrequency,
      deductions: applicableSnapshot.deductions,
      employerPensionPercent: applicableSnapshot.employerPensionPercent,
    })
  const breakdown = calculateNetSalary(fullDraft)
  const periodLabel = draft.payFrequency === 'four_weekly' ? 'every 4 weeks' : 'monthly'

  // Any bonus attached to THIS period, folded into the breakdown below.
  // Deliberately computed against the live `fullDraft` rather than the
  // person's stored snapshot, so editing the gross salary or a deduction
  // in this panel updates the bonus's tax alongside everything else,
  // before anything is saved — the same reason every other figure on
  // this card reads from the draft.
  //
  // This card previously ignored the override entirely: it showed the
  // snapshot's plain net pay and nothing else, so attaching a bonus
  // changed the collapsed row's figure above but left "Net pay" here
  // unchanged, which read as the bonus having done nothing at all.
  const bonusGross = existingOverride?.bonusGrossAmount ?? 0
  const bonus = bonusGross > 0 ? calculateBonusOnTop(fullDraft, bonusGross) : null
  const netPayWithBonus = breakdown.netPerPeriod + (bonus?.net ?? 0)

  function updateDeductions(deductions: SalaryDeduction[]) {
    setDraft((d) => ({ ...d, deductions }))
  }
  function addDeduction() {
    const id = nanoid(6)
    updateDeductions([...draft.deductions, { id, name: '', type: 'relief_at_source', amountType: 'percent', amount: 0 }])
    setEditingDeduction({ personId: person.id, deductionId: id })
  }
  function updateDeduction(id: string, patch: Partial<SalaryDeduction>) {
    updateDeductions(draft.deductions.map((d) => (d.id === id ? { ...d, ...patch } : d)))
  }
  function removeDeduction(id: string) {
    updateDeductions(draft.deductions.filter((d) => d.id !== id))
  }
  function moveDeduction(id: string, direction: -1 | 1) {
    const list = draft.deductions
    const idx = list.findIndex((d) => d.id === id)
    const swapWith = idx + direction
    if (idx < 0 || swapWith < 0 || swapWith >= list.length) return
    const next = list.slice()
    ;[next[idx], next[swapWith]] = [next[swapWith], next[idx]]
    updateDeductions(next)
  }

  return (
    <div className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Gross annual salary (£)">
          <input
            type="number"
            inputMode="decimal"
            value={fullDraft.grossAnnual || ''}
            onChange={(e) => setDraft({ ...draft, grossAnnual: Number(e.target.value) })}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
        <Field label="Tax code">
          <input
            value={fullDraft.taxCode}
            onChange={(e) => setDraft({ ...draft, taxCode: e.target.value })}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono uppercase"
          />
        </Field>
        <Field label="Student loan">
          <select
            value={fullDraft.studentLoanPlan}
            onChange={(e) => setDraft({ ...draft, studentLoanPlan: e.target.value as StudentLoanPlan })}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {Object.entries(STUDENT_LOAN_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Paid">
          <select
            value={fullDraft.payFrequency}
            onChange={(e) => setDraft({ ...draft, payFrequency: e.target.value as PayFrequency })}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            <option value="monthly">Monthly (12/yr)</option>
            <option value="four_weekly">Every 4 weeks (13/yr)</option>
          </select>
        </Field>
        <Field label="Employer pension %">
          <input
            type="number"
            inputMode="decimal"
            step="0.5"
            value={draft.employerPensionPercent || ''}
            onChange={(e) => setDraft({ ...draft, employerPensionPercent: Number(e.target.value) })}
            placeholder="0"
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-semibold text-[var(--color-ink)]">Deductions</h4>
          <button onClick={addDeduction} className="text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
            + Add deduction
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {draft.deductions.map((d) => (
            <button
              key={d.id}
              onClick={() => setEditingDeduction({ personId: person.id, deductionId: d.id })}
              className="w-full flex items-center justify-between rounded-xl px-3 py-2 text-left"
              style={{ background: 'var(--color-surface)' }}
            >
              <span className="text-sm text-[var(--color-ink)]">{d.name || 'Unnamed deduction'}</span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-sm text-[var(--color-ink-muted)]">{deductionAmountLabel(d)}</span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmingDeductionId(d.id)
                  }}
                  className="text-[var(--color-ink-faint)]"
                >
                  <Trash2 size={14} />
                </span>
              </span>
            </button>
          ))}
        </div>
        {confirmingDeductionId && (
          <ConfirmModal
            title="Remove this deduction?"
            description="This can't be undone."
            confirmLabel="Remove"
            tone="danger"
            onConfirm={() => {
              removeDeduction(confirmingDeductionId)
              setConfirmingDeductionId(null)
            }}
            onCancel={() => setConfirmingDeductionId(null)}
          />
        )}
        {editingDeduction?.personId === person.id &&
          (() => {
            const idx = draft.deductions.findIndex((d) => d.id === editingDeduction.deductionId)
            const d = draft.deductions[idx]
            if (!d) return null
            return (
              <DeductionModal
                deduction={d}
                canMoveUp={idx > 0}
                canMoveDown={idx < draft.deductions.length - 1}
                onChange={(patch) => updateDeduction(d.id, patch)}
                onMove={(direction) => moveDeduction(d.id, direction)}
                onDelete={() => {
                  removeDeduction(d.id)
                  setEditingDeduction(null)
                }}
                onClose={() => setEditingDeduction(null)}
              />
            )
          })()}
      </div>

      <div className="rounded-xl p-4" style={{ background: 'var(--color-surface)' }}>
        <BreakdownRow label="Gross salary" value={breakdown.grossPerPeriod} bold />
        {breakdown.preTaxDeductions.map((d) => (
          <BreakdownRow key={d.id} label={`${d.name || 'Deduction'} (${DEDUCTION_TYPE_SHORT[d.type]})`} value={-d.amountPerPeriod} />
        ))}
        {breakdown.preTaxDeductions.length > 0 && (
          <>
            <div className="h-px my-2" style={{ background: 'var(--color-track)' }} />
            <BreakdownRow label="Gross taxable" value={breakdown.grossTaxablePerPeriod} bold />
          </>
        )}
        <BreakdownRow label="Income tax" value={-breakdown.incomeTaxPerPeriod} />
        <BreakdownRow label="National Insurance" value={-breakdown.nationalInsurancePerPeriod} />
        {breakdown.studentLoanPerPeriod > 0 && <BreakdownRow label="Student loan" value={-breakdown.studentLoanPerPeriod} />}
        {breakdown.postTaxDeductions.map((d) => (
          <BreakdownRow key={d.id} label={d.name || 'Deduction'} value={-d.amountPerPeriod} />
        ))}
        {bonus && (
          <>
            <div className="h-px my-2" style={{ background: 'var(--color-track)' }} />
            <BreakdownRow label="Bonus (gross)" value={bonus.grossBonus} bold />
            <BreakdownRow label="Income tax on bonus" value={-bonus.incomeTax} />
            <BreakdownRow label="National Insurance on bonus" value={-bonus.nationalInsurance} />
          </>
        )}
        <div className="h-px my-2" style={{ background: 'var(--color-track)' }} />
        <BreakdownRow label={`Net pay (${periodLabel})`} value={netPayWithBonus} emphasized />
        {bonus && (
          <p className="text-xs text-[var(--color-ink-faint)] mt-2">
            A bonus is charged income tax and National Insurance at your marginal rate, and nothing else — no student
            loan, and your standing deductions (pension and the rest) come off your salary only, not out of the bonus.
          </p>
        )}
        {(draft.employerPensionPercent ?? 0) > 0 && (
          <p className="text-xs text-[var(--color-ink-faint)] mt-2">
            Your employer separately contributes £{formatCurrency(breakdown.employerPensionContributionPerPeriod)} (
            {draft.employerPensionPercent}%) into your pension — this isn't part of your pay, and doesn't change the
            net figure above by design.
          </p>
        )}
      </div>

      <NetPayOverrideControl personId={person.id} dateIso={dateIso} snapshotNetPay={netPayWithBonus} existingOverride={existingOverride} />

      <div className="flex justify-end">
        <AttachBonusButton personId={person.id} fixedDate={dateIso} existingOverride={existingOverride} />
      </div>

      <button
        disabled={!dirty}
        onClick={() => {
          if (isClosed) {
            onSaveJustThis(fullDraft)
          } else {
            setConfirming(true)
          }
        }}
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>

      {confirming && (
        <ConfirmSalaryChangeModal
          nextPaydayLabel={dateIso}
          onCancel={() => setConfirming(false)}
          onJustNext={() => {
            onSaveJustThis(fullDraft)
            setConfirming(false)
          }}
          onAllFuture={() => {
            onSaveAllFuture(fullDraft)
            setConfirming(false)
          }}
        />
      )}
    </div>
  )
}

/**
 * A direct, quick net-pay override for exactly one pay period — the "one-off"
 * path from SalaryOverride's design comment in types/ledger.ts, distinct
 * from editing gross salary/deductions above (which represents a change to
 * the standing snapshot and offers "just this / all future"). Typing a
 * number here and hitting Set ALWAYS affects only this one period; there's
 * no scope choice because there's nothing to choose between.
 *
 * Hidden when this period's override is actually a bonus attachment
 * (existingOverride.bonusGrossAmount set) — that number is edited via the
 * Bonus control instead, so there's only ever one place a given override's
 * figure gets changed from.
 */
function NetPayOverrideControl({
  personId,
  dateIso,
  snapshotNetPay,
  existingOverride,
}: {
  personId: string
  dateIso: string
  snapshotNetPay: number
  existingOverride?: Person['salaryOverrides'][number]
}) {
  const { addSalaryOverride, updateSalaryOverride, removeSalaryOverride } = useLedgerData()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  if (existingOverride?.bonusGrossAmount) {
    return <p className="text-xs text-[var(--color-ink-faint)]">Net pay for this period is adjusted by an attached bonus — edit or remove it below.</p>
  }

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-2">
        {existingOverride ? (
          <span className="text-xs text-[var(--color-ink-muted)]">
            Net pay manually overridden to £{formatCurrency(existingOverride.netPayOverride)} for this period only.
          </span>
        ) : (
          <span className="text-xs text-[var(--color-ink-faint)]">Net pay for this period will be £{formatCurrency(snapshotNetPay)}.</span>
        )}
        <div className="flex items-center gap-3 shrink-0">
          {existingOverride && (
            <button onClick={() => removeSalaryOverride(personId, existingOverride.id)} className="text-xs font-medium" style={{ color: 'var(--color-negative)' }}>
              Remove
            </button>
          )}
          <button
            onClick={() => {
              setValue(String(existingOverride?.netPayOverride ?? snapshotNetPay))
              setEditing(true)
            }}
            className="text-xs font-medium"
            style={{ color: 'var(--color-coral)' }}
          >
            {existingOverride ? 'Edit override' : 'Override net pay'}
          </button>
        </div>
      </div>
    )
  }

  const numeric = Number(value)
  const canSave = value.trim() !== '' && !Number.isNaN(numeric) && numeric >= 0

  function save() {
    if (!canSave) return
    const reason = 'Net pay manually overridden (this payment only)'
    if (existingOverride) updateSalaryOverride(personId, existingOverride.id, { netPayOverride: numeric, reason, bonusGrossAmount: undefined })
    else addSalaryOverride(personId, { payPeriodDate: dateIso, netPayOverride: numeric, reason })
    setEditing(false)
  }

  return (
    <div className="flex items-end gap-2">
      <label className="flex-1 flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Override net pay for this period only (£)</span>
        <input
          type="number"
          inputMode="decimal"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
        />
      </label>
      <button onClick={save} disabled={!canSave} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40" style={{ background: 'var(--color-coral)' }}>
        Set
      </button>
      <button onClick={() => setEditing(false)} className="text-xs text-[var(--color-ink-muted)] py-1.5">
        Cancel
      </button>
    </div>
  )
}

function ConfirmSalaryChangeModal({
  nextPaydayLabel,
  onCancel,
  onJustNext,
  onAllFuture,
}: {
  nextPaydayLabel: string | null
  onCancel: () => void
  onJustNext: () => void
  onAllFuture: () => void
}) {
  // Portalled to document.body (not rendered inline in the page tree) —
  // otherwise it sits inside #app-shell, which is a fixed-height,
  // overflow-hidden container the nav bar is absolutely positioned
  // within. On iOS that combination clips/misorders a "position: fixed"
  // descendant against the nav's own stacking context, so despite a
  // higher z-index the confirm buttons rendered underneath the nav bar
  // (see the rest of the app's modals — DeductionModal, CategoryIconPickerModal,
  // etc. — which all portal for exactly this reason). Bottom padding
  // matches those same modals so the buttons clear the nav bar itself,
  // not just the safe-area inset.
  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-base font-semibold text-[var(--color-ink)] mb-1">Apply this change to…</h3>
        <p className="text-sm text-[var(--color-ink-muted)] mb-4">
          {nextPaydayLabel ? `Just this payment (${nextPaydayLabel}), or every payment from then on?` : 'Just this payment, or every payment from then on?'}
        </p>
        <div className="flex flex-col gap-2">
          <button onClick={onJustNext} className="w-full py-2.5 rounded-full text-sm font-semibold" style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}>
            Just this payment
          </button>
          <button onClick={onAllFuture} className="w-full py-2.5 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
            This and all future payments
          </button>
          <button onClick={onCancel} className="w-full py-2 text-xs text-[var(--color-ink-muted)]">
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

const DEDUCTION_TYPE_SHORT: Record<DeductionType, string> = {
  salary_sacrifice: 'salary sacrifice',
  net_pay: 'net pay',
  relief_at_source: 'relief at source',
  post_tax: 'post-tax',
}


function BackupSection({ data, onRestore }: { data: AppDataV2; onRestore: (data: AppDataV2) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)

  function handleFile(file: File) {
    setError(null)
    setRestored(false)
    file
      .text()
      .then((text) => {
        const restoredData = parseLedgerBackupJson(text)
        const proceed = window.confirm(
          `This will replace everything currently in the app (${data.people.length} ${data.people.length === 1 ? 'person' : 'people'}, ${data.recurringTemplates.length} bills, ${data.loans.length} loans, ${data.creditCards.length} credit cards, ${data.scenarios.length} scenarios) with the contents of this backup. This can't be undone. Continue?`,
        )
        if (!proceed) return
        onRestore(restoredData)
        setRestored(true)
      })
      .catch((err) => setError(err.message))
  }

  return (
    <div className="rounded-2xl p-4 mb-6 flex items-center justify-between" style={{ background: 'var(--color-surface)' }}>
      <div>
        <h2 className="font-body text-sm font-semibold text-[var(--color-ink)]">Backup</h2>
        <p className="text-xs text-[var(--color-ink-faint)] mt-0.5 max-w-[220px]">
          Everything lives in this browser's storage — save a copy somewhere safe in case it gets cleared.
        </p>
        {error && (
          <p className="text-xs mt-1" style={{ color: 'var(--color-negative)' }}>
            {error}
          </p>
        )}
        {restored && (
          <p className="text-xs mt-1" style={{ color: 'var(--color-positive)' }}>
            Restored.
          </p>
        )}
      </div>
      <div className="flex gap-2 shrink-0">
        <button
          onClick={() => downloadLedgerBackup(data)}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-bg-elevated)' }}
          title="Download a full backup"
        >
          <Download size={16} className="text-[var(--color-ink)]" />
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-bg-elevated)' }}
          title="Restore from a backup file"
        >
          <Upload size={16} className="text-[var(--color-ink)]" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-[var(--color-ink-muted)]">{label}</span>
      {children}
    </label>
  )
}

function BreakdownRow({ label, value, emphasized, bold }: { label: string; value: number; emphasized?: boolean; bold?: boolean }) {
  const negative = value < 0
  return (
    <div className="flex items-center justify-between py-1">
      <span
        className={`font-body ${emphasized || bold ? 'text-sm font-semibold text-[var(--color-ink)]' : 'text-sm text-[var(--color-ink-muted)]'}`}
      >
        {label}
      </span>
      <span
        className={`font-mono tabular-nums ${emphasized ? 'text-base font-semibold' : bold ? 'text-sm font-semibold' : 'text-sm'}`}
        style={{ color: emphasized || bold ? 'var(--color-ink)' : negative ? 'var(--color-negative)' : 'var(--color-ink)' }}
      >
        {negative ? '-' : ''}£{formatCurrency(Math.abs(value))}
      </span>
    </div>
  )
}
