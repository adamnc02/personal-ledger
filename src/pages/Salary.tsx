import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency } from '../lib/format'
import { useLedgerData } from '../context/LedgerContext'
import { calculateNetSalary, type StudentLoanPlan, type PayFrequency, type SalaryDeduction, type DeductionType } from '../lib/tax'
import { findApplicableSnapshot, computeNetPayForPeriod, upcomingPaydays, closedPaydays } from '../lib/salaryLedger'
import { calculateBonusOnTop } from '../lib/tax'
import { monthlyAmountForEntry } from '../lib/savings'
import { AttachBonusButton } from '../components/AttachBonusButton'
import { downloadLedgerBackup, parseLedgerBackupJson } from '../lib/ledgerStorage'
import { Plus, Trash2, Download, Upload, ChevronDown, ChevronUp, Settings, X } from 'lucide-react'
import type { AppDataV2, PayCycleConfig, Person, SavingsEntry } from '../types/ledger'
import { nanoid } from 'nanoid'
import { DeductionModal } from '../components/DeductionModal'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { NumberInput } from '../components/NumberInput'

const STUDENT_LOAN_LABELS: Record<StudentLoanPlan, string> = {
  none: 'No student loan',
  plan1: 'Plan 1',
  plan2: 'Plan 2',
  plan4: 'Plan 4',
  plan5: 'Plan 5',
  postgrad: 'Postgraduate loan',
}

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
    addSalaryOverride,
    updateSalaryOverride,
    addSavingsEntry,
    updateSavingsEntry,
    removeSavingsEntry,
  } = useLedgerData()
  const [addingPerson, setAddingPerson] = useState(false)
  const [editingDeduction, setEditingDeduction] = useState<{ personId: string; deductionId: string } | null>(null)
  const [newName, setNewName] = useState('')
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null)

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Salary</h1>
        <button
          onClick={() => setAddingPerson(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-surface)' }}
        >
          <Plus size={18} className="text-[var(--color-ink)]" />
        </button>
      </header>

      <BackupSection data={data} onRestore={setData} />

      {addingPerson && (
        <div className="rounded-2xl p-4 mb-6 flex gap-2" style={{ background: 'var(--color-surface)' }}>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className="flex-1 bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          />
          <button
            onClick={() => {
              if (!newName.trim()) return
              addPerson({ name: newName.trim(), color: '#7c6fe0' })
              setNewName('')
              setAddingPerson(false)
            }}
            className="px-3 rounded-lg font-medium text-sm"
            style={{ background: 'var(--color-coral)', color: '#fff' }}
          >
            Add
          </button>
        </div>
      )}

      <div className="flex flex-col gap-6">
        {data.people.map((person) => {
          const payCycle = data.payCycles.find((pc) => pc.personId === person.id)
          const isPrimary = person.id === data.primaryPersonId
          const hasSalary = person.salaryHistory.length > 0

          return (
            <div key={person.id} className="flex flex-col gap-6">
              <div className="rounded-2xl p-5" style={{ background: 'var(--color-surface)' }}>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <EditablePersonName name={person.name} onRename={(name) => updatePerson(person.id, { name })} />
                    <button
                      onClick={() => setPrimaryPerson(person.id)}
                      disabled={isPrimary}
                      className="px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide transition-colors"
                      style={{
                        background: isPrimary ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                        color: isPrimary ? '#fff' : 'var(--color-ink-muted)',
                      }}
                      title={isPrimary ? 'This is your own dashboard view' : 'Make this your dashboard view'}
                    >
                      {isPrimary ? 'Me' : 'Set as me'}
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    {hasSalary && (
                      <button onClick={() => setSettingsOpenFor(person.id)} className="text-[var(--color-ink-muted)]" aria-label="Pay cycle settings">
                        <Settings size={16} />
                      </button>
                    )}
                    {data.people.length > 1 && (
                      <button onClick={() => removePerson(person.id)} className="text-[var(--color-ink-faint)]">
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>

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
                  <PayPeriodsSection
                    person={person}
                    payCycle={payCycle}
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
                ) : null}

                <SavingsSection
                  entries={person.savingsEntries}
                  onAdd={(entry) => addSavingsEntry(person.id, entry)}
                  onUpdate={(entryId, updates) => updateSavingsEntry(person.id, entryId, updates)}
                  onRemove={(entryId) => removeSavingsEntry(person.id, entryId)}
                />
              </div>
            </div>
          )
        })}
      </div>

      {settingsOpenFor &&
        (() => {
          const person = data.people.find((p) => p.id === settingsOpenFor)
          const payCycle = data.payCycles.find((pc) => pc.personId === settingsOpenFor)
          if (!person) return null
          return (
            <PayCycleSettingsModal
              personName={person.name}
              payday={payCycle?.paydayDayOfMonth ?? 28}
              adjustForNonWorkingDay={payCycle?.paydayAdjustForNonWorkingDay ?? true}
              cycleStartDay={payCycle?.cycleStartDayOfMonth ?? 1}
              openingBalance={payCycle?.openingBalance ?? 0}
              openingBalanceDate={payCycle?.openingBalanceDate ?? todayIso()}
              onChange={(updates) => updatePayCycle(person.id, updates)}
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

  // Mandatory pay-cycle fields, loaded from the current model (created
  // automatically alongside the person) so there's always a sensible
  // starting point — but all of them are required before saving.
  const [paydayDayOfMonth, setPaydayDayOfMonth] = useState(String(payCycle?.paydayDayOfMonth ?? 28))
  const [paydayAdjustForNonWorkingDay, setPaydayAdjustForNonWorkingDay] = useState(payCycle?.paydayAdjustForNonWorkingDay ?? true)
  const [cycleStartDayOfMonth, setCycleStartDayOfMonth] = useState(String(payCycle?.cycleStartDayOfMonth ?? 1))
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
                <span className="font-mono text-sm text-[var(--color-ink-muted)]">{d.amountType === 'percent' ? `${d.amount}%` : `£${formatCurrency(d.amount)}`}</span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeDeduction(d.id)
                  }}
                  className="text-[var(--color-ink-faint)]"
                >
                  <Trash2 size={14} />
                </span>
              </span>
            </button>
          ))}
        </div>
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
          <Field label="Budgeting cycle starts on">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={cycleStartDayOfMonth}
              onChange={(e) => setCycleStartDayOfMonth(e.target.value)}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
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
  payday,
  adjustForNonWorkingDay,
  cycleStartDay,
  openingBalance,
  openingBalanceDate,
  onChange,
  onClose,
}: {
  personName: string
  payday: number
  adjustForNonWorkingDay: boolean
  cycleStartDay: number
  openingBalance: number
  openingBalanceDate: string
  onChange: (updates: { paydayDayOfMonth?: number; paydayAdjustForNonWorkingDay?: boolean; cycleStartDayOfMonth?: number; openingBalance?: number; openingBalanceDate?: string }) => void
  onClose: () => void
}) {
  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div className="w-full max-w-md rounded-t-3xl p-5" style={{ background: 'var(--color-surface)' }} onClick={(e) => e.stopPropagation()}>
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
              value={payday}
              onChange={(v) => onChange({ paydayDayOfMonth: Math.max(1, Math.min(31, Number(v) || 1)) })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label="Budgeting cycle starts on">
            <NumberInput
              inputMode="numeric"
              min={1}
              max={31}
              value={cycleStartDay}
              onChange={(v) => onChange({ cycleStartDayOfMonth: Math.max(1, Math.min(31, Number(v) || 1)) })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label="Opening balance (£)">
            <input
              type="number"
              inputMode="decimal"
              value={openingBalance || ''}
              onChange={(e) => onChange({ openingBalance: Number(e.target.value) })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label="...as of">
            <input
              type="date"
              value={openingBalanceDate}
              onChange={(e) => onChange({ openingBalanceDate: e.target.value })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 mt-3">
          <input type="checkbox" checked={adjustForNonWorkingDay} onChange={(e) => onChange({ paydayAdjustForNonWorkingDay: e.target.checked })} />
          <span className="text-xs text-[var(--color-ink-muted)]">
            If payday falls on a weekend or UK bank holiday, pay on the last working day before it
          </span>
        </label>
        <p className="text-xs text-[var(--color-ink-faint)] mt-2">
          The budgeting cycle boundary stays fixed even when the actual payday drifts a day or two earlier. Nothing
          dated before the opening balance date will appear anywhere in {personName}'s ledger.
        </p>

        <button onClick={onClose} className="w-full mt-4 py-2.5 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  )
}

// ── Pay periods — upcoming (next 3) + collapsed history, both tappable into the SAME unified editor ──

function PayPeriodsSection({
  person,
  payCycle,
  onSaveJustThis,
  onSaveAllFuture,
  editingDeduction,
  setEditingDeduction,
}: {
  person: Person
  payCycle: PayCycleConfig
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
  const upcoming = upcomingPaydays(payCycle, today, 3).map(toLocalIsoDate)
  const closed = closedPaydays(payCycle, today, 6).map(toLocalIsoDate)

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
      <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-2">Upcoming pay</h3>
      <div className="flex flex-col gap-2 mb-3">
        {upcoming.map((dateIso) => (
          <PayPeriodRow
            key={dateIso}
            person={person}
            dateIso={dateIso}
            isClosed={false}
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
        <span>History ({closed.length})</span>
        {showHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {showHistory && (
        <div className="flex flex-col gap-2 mt-2">
          {closed.map((dateIso) => (
            <PayPeriodRow
              key={dateIso}
              person={person}
              dateIso={dateIso}
              isClosed
              isOpen={expandedDate === dateIso}
              flashing={flashDates.includes(dateIso)}
              onToggle={() => setExpandedDate(expandedDate === dateIso ? null : dateIso)}
              onSaveJustThis={(fields) => handleSaveJustThis(dateIso, fields)}
              onSaveAllFuture={(fields) => handleSaveAllFuture(dateIso, fields)}
              editingDeduction={editingDeduction}
              setEditingDeduction={setEditingDeduction}
            />
          ))}
          {closed.length === 0 && <p className="text-xs text-[var(--color-ink-faint)] px-1">No past pay periods yet.</p>}
        </div>
      )}
    </div>
  )
}

function PayPeriodRow({
  person,
  dateIso,
  isClosed,
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

  return (
    <div className="relative rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-elevated)' }}>
      <button onClick={onToggle} className="w-full flex items-center justify-between px-3 py-2.5 text-left">
        <span className="text-sm text-[var(--color-ink)]">
          {dateIso}
          {existingOverride?.bonusGrossAmount && <span className="text-xs text-[var(--color-coral)]"> · Bonus attached</span>}
          {existingOverride && !existingOverride.bonusGrossAmount && <span className="text-xs text-[var(--color-coral)]"> · Adjusted</span>}
        </span>
        <span className="font-mono text-sm text-[var(--color-ink)]">£{formatCurrency(netPay ?? 0)}</span>
      </button>
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
      <SavedFlashOverlay active={flashing} />
    </div>
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

  if (!applicableSnapshot) {
    return (
      <div className="px-3 pb-3 pt-1">
        <p className="text-xs text-[var(--color-ink-faint)]">No salary was configured as of this date yet.</p>
      </div>
    )
  }

  const fullDraft = draft
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
                <span className="font-mono text-sm text-[var(--color-ink-muted)]">{d.amountType === 'percent' ? `${d.amount}%` : `£${formatCurrency(d.amount)}`}</span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeDeduction(d.id)
                  }}
                  className="text-[var(--color-ink-faint)]"
                >
                  <Trash2 size={14} />
                </span>
              </span>
            </button>
          ))}
        </div>
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
        onClick={() => {
          if (isClosed) {
            onSaveJustThis(fullDraft)
          } else {
            setConfirming(true)
          }
        }}
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white"
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
  // (see the rest of the app's modals — DeductionModal, IconPickerModal,
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

function SavingsSection({
  entries,
  onAdd,
  onUpdate,
  onRemove,
}: {
  entries: SavingsEntry[]
  onAdd: (entry: Omit<SavingsEntry, 'id'>) => void
  onUpdate: (entryId: string, updates: Partial<Omit<SavingsEntry, 'id'>>) => void
  onRemove: (entryId: string) => void
}) {
  function addEntry(type: 'goal' | 'plan') {
    const base: Omit<SavingsEntry, 'id'> =
      type === 'goal'
        ? { type: 'goal', name: '', includeInSummary: false, targetAmount: 0, currentAmount: 0, targetDate: '' }
        : { type: 'plan', name: '', includeInSummary: false, monthlyAmount: 0 }
    onAdd(base)
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-body text-sm font-semibold text-[var(--color-ink)]">Savings</h3>
        <div className="flex gap-3">
          <button onClick={() => addEntry('plan')} className="text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
            + Monthly plan
          </button>
          <button onClick={() => addEntry('goal')} className="text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
            + Goal
          </button>
        </div>
      </div>

      {entries.length === 0 && <p className="text-xs text-[var(--color-ink-faint)]">No savings tracked yet.</p>}

      <div className="flex flex-col gap-3">
        {entries.map((entry) => (
          <SavingsEntryCard key={entry.id} entry={entry} onUpdate={(patch) => onUpdate(entry.id, patch)} onRemove={() => onRemove(entry.id)} />
        ))}
      </div>
    </div>
  )
}

function SavingsEntryCard({
  entry,
  onUpdate,
  onRemove,
}: {
  entry: SavingsEntry
  onUpdate: (patch: Partial<SavingsEntry>) => void
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(!entry.name)
  const monthly = monthlyAmountForEntry(entry)
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()

  const percent = entry.type === 'goal' && entry.targetAmount ? Math.min(100, ((entry.currentAmount ?? 0) / entry.targetAmount) * 100) : 0

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={entry.name || 'this entry'}>
      <div className="relative rounded-xl p-4" style={{ background: 'var(--color-bg-elevated)' }}>
        <button className="w-full flex items-center justify-between mb-2 text-left" onClick={() => setEditing(!editing)}>
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-ink-faint)' }}>
            {entry.type === 'goal' ? 'Goal' : 'Monthly plan'}
          </span>
          {editing ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
        </button>

        {editing ? (
          <SavingsEntryEditForm
            entry={entry}
            onSave={(patch) => {
              onUpdate(patch)
              setEditing(false)
              triggerFlash()
            }}
          />
        ) : (
          <>
            <div className="flex items-baseline justify-between mb-1">
              <span className="font-body text-sm text-[var(--color-ink)]">{entry.name || 'Unnamed'}</span>
              {entry.type === 'goal' ? (
                <span className="font-mono text-sm text-[var(--color-ink-muted)]">
                  £{(entry.currentAmount ?? 0).toFixed(0)} / £{(entry.targetAmount ?? 0).toFixed(0)}
                </span>
              ) : (
                <span className="font-mono text-sm text-[var(--color-ink-muted)]">£{formatCurrency(entry.monthlyAmount ?? 0)}/mo</span>
              )}
            </div>
            {entry.type === 'goal' && (
              <div className="h-1.5 rounded-full overflow-hidden mb-1" style={{ background: 'var(--color-track)' }}>
                <div className="h-full rounded-full" style={{ width: `${percent}%`, background: 'var(--color-coral)' }} />
              </div>
            )}
            <p className="text-xs" style={{ color: entry.includeInSummary ? 'var(--color-positive)' : 'var(--color-ink-faint)' }}>
              {entry.pausedFrom
                ? `Paused from ${entry.pausedFrom}`
                : entry.includeInSummary
                  ? monthly > 0
                    ? `£${formatCurrency(monthly)}/month counted in your available balance`
                    : 'Included, but no monthly amount yet'
                  : 'Not counted in available balance'}
            </p>
          </>
        )}

        <SavedFlashOverlay active={flashActive} />
      </div>
    </SwipeToDelete>
  )
}

// ── Draft-then-Save edit form for a savings entry, following the same
// convention as the other panels: nothing persists until Save is pressed.
// Mounted fresh (guarded by `editing` in the parent) each time the entry is
// opened for editing, so the draft always starts from the current saved
// values. Save feedback (collapse + green flash) is owned by the parent
// SavingsEntryCard, matching Bills/Loans/pay-periods — see SavedFlash.tsx. ──

function SavingsEntryEditForm({ entry, onSave }: { entry: SavingsEntry; onSave: (patch: Partial<SavingsEntry>) => void }) {
  const [draft, setDraft] = useState<Omit<SavingsEntry, 'id'>>(() => {
    const { id: _id, ...rest } = entry
    return rest
  })
  // Held separately from `draft.pausedFrom` — committing straight to draft
  // from the date input's onChange meant the moment iOS's native picker
  // opened and defaulted its wheel to today, THAT counted as a change
  // (fired even on a bare tap-to-dismiss, before any deliberate scroll),
  // which flipped this whole block over to the "Paused from" view and
  // yanked the input out from under the person mid-tap. Keeping the pick
  // here until an explicit "Set" tap means opening/dismissing the picker
  // no longer silently pauses anything.
  const [pauseDatePick, setPauseDatePick] = useState('')

  function update(patch: Partial<Omit<SavingsEntry, 'id'>>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Name">
        <input
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder={draft.type === 'goal' ? 'e.g. House deposit' : 'e.g. General savings'}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        />
      </Field>

      {draft.type === 'goal' ? (
        <>
          <Field label="Target date (optional)">
            <input
              type="date"
              value={draft.targetDate ?? ''}
              onChange={(e) => update({ targetDate: e.target.value })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
            />
          </Field>
          <Field label="Target amount (£)">
            <input
              type="number"
              inputMode="decimal"
              value={draft.targetAmount || ''}
              onChange={(e) => update({ targetAmount: Number(e.target.value) })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
          <Field label="Saved so far (£)">
            <input
              type="number"
              inputMode="decimal"
              value={draft.currentAmount || ''}
              onChange={(e) => update({ currentAmount: Number(e.target.value) })}
              className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
            />
          </Field>
        </>
      ) : (
        <Field label="Amount per month (£)">
          <input
            type="number"
            inputMode="decimal"
            value={draft.monthlyAmount || ''}
            onChange={(e) => update({ monthlyAmount: Number(e.target.value) })}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none font-mono"
          />
        </Field>
      )}

      <label className="flex items-center gap-2 col-span-2 mt-1">
        <input type="checkbox" checked={draft.includeInSummary} onChange={(e) => update({ includeInSummary: e.target.checked })} />
        <span className="text-xs text-[var(--color-ink-muted)]">Include in available balance</span>
      </label>

      <div className="col-span-2 mt-1">
        {draft.pausedFrom ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--color-ink-muted)]">Paused from {draft.pausedFrom}</span>
            <button onClick={() => update({ pausedFrom: undefined })} className="text-xs font-medium" style={{ color: 'var(--color-coral)' }}>
              Resume
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => update({ pausedFrom: todayIso() })} className="text-xs font-medium" style={{ color: 'var(--color-negative)' }}>
              Pause now
            </button>
            <span className="text-xs text-[var(--color-ink-faint)]">or</span>
            <input
              type="date"
              value={pauseDatePick}
              onChange={(e) => setPauseDatePick(e.target.value)}
              className="bg-transparent border-b border-[var(--color-track)] py-0.5 text-xs text-[var(--color-ink-muted)] outline-none"
            />
            <span className="text-xs text-[var(--color-ink-faint)]">pause from a date</span>
            {pauseDatePick && (
              <button
                onClick={() => {
                  update({ pausedFrom: pauseDatePick })
                  setPauseDatePick('')
                }}
                className="text-xs font-semibold px-2 py-0.5 rounded-full text-white"
                style={{ background: 'var(--color-coral)' }}
              >
                Set
              </button>
            )}
          </div>
        )}
      </div>

      <button
        onClick={() => onSave(draft)}
        className="col-span-2 w-full py-2.5 rounded-full text-sm font-semibold text-white mt-1"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
    </div>
  )
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
