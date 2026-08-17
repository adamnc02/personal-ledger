import { useEffect, useState } from 'react'
import { formatCurrency } from '../lib/format'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, ChevronDown, ChevronUp, CreditCard as CreditCardIcon } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { summarizeLoan } from '../lib/ledgerLoans'
import { computeMinimumPaymentAmount, pickCreditCardColor } from '../lib/creditCards'
import { CREDIT_CARD_CATEGORY_ID, type CreditCard, type CreditCardLumpPayment, type CreditCardMinimumPayment, type Loan, type LoanRecurringOverpayment } from '../types/ledger'
import type { BillLocation } from '../types/models'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { visibleCategoriesFor } from '../lib/categories'
import { LocationEditor } from '../components/LocationEditor'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { CollapsibleSection } from '../components/CollapsibleSection'

import { todayIso } from '../lib/date'

type LoanPrefill = Partial<Omit<Loan, 'id' | 'overpayments'>>

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-7 h-7 rounded-full flex items-center justify-center" style={{ background: 'var(--color-coral)' }}>
      <Plus size={14} className="text-white" />
    </button>
  )
}

export function Loans() {
  const {
    data,
    addLoan,
    updateLoan,
    removeLoan,
    logLoanOverpayment,
    addCreditCard,
    updateCreditCard,
    removeCreditCard,
    logCreditCardLumpPayment,
    removeCreditCardLumpPayment,
    updateCreditCardLumpPayment,
    addCategory,
  } = useLedgerData()
  const [addingLoan, setAddingLoan] = useState(false)
  const [addingCard, setAddingCard] = useState(false)
  const [expandedLoan, setExpandedLoan] = useState<string | null>(null)
  const [expandedCard, setExpandedCard] = useState<string | null>(null)
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const loanPrefill = (routerLocation.state as { loanPrefill?: LoanPrefill } | null)?.loanPrefill

  // Loans only offer a Personal/Joint choice once there's actually a joint
  // bill to make that split meaningful — see LoanEditPanel/LoanForm's
  // "hasJointBills" prop for the full reasoning.
  const hasJointBills = data.recurringTemplates.some((t) => t.location === 'joint')

  useEffect(() => {
    if (loanPrefill) setAddingLoan(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLocation.state])

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Loans</h1>
      </header>

      <CollapsibleSection title="Loans" className="mb-8" headerExtra={<AddButton onClick={() => setAddingLoan(true)} />}>
        <p className="text-xs text-[var(--color-ink-faint)] mb-3 leading-relaxed">
          Monthly amount + term are the inputs now — the total payable is worked out from those, rather than the
          other way round. Log a real overpayment on any loan below and its remaining schedule shrinks for good.
        </p>

        {addingLoan && (
          <LoanForm
            people={data.people}
            categories={visibleCategoriesFor(data)}
            defaultOwnerId={data.primaryPersonId}
            initial={loanPrefill}
            hasJointBills={hasJointBills}
            onAddCategory={addCategory}
            onCancel={() => {
              setAddingLoan(false)
              if (loanPrefill) navigate('.', { replace: true, state: null })
            }}
            onSave={(loan) => {
              addLoan(loan)
              setAddingLoan(false)
              if (loanPrefill) navigate('.', { replace: true, state: null })
            }}
          />
        )}

        <div className="flex flex-col gap-3">
          {data.loans.map((loan) => {
            const summary = summarizeLoan(loan)
            const category = data.categories.find((c) => c.id === loan.categoryId)
            const percentRepaid =
              summary.totalPayable > 0 ? Math.min(100, ((summary.totalPayable - summary.remainingBalance) / summary.totalPayable) * 100) : 0
            const isOpen = expandedLoan === loan.id
            return (
              <SwipeToDelete key={loan.id} onDelete={() => removeLoan(loan.id)} confirmLabel={loan.name}>
                <div className="rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
                  <button onClick={() => setExpandedLoan(isOpen ? null : loan.id)} className="w-full flex items-center justify-between text-left">
                    <div className="flex items-center gap-2">
                      <CategoryIcon category={category} />
                      <div>
                        <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{loan.name}</h3>
                        <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                          £{formatCurrency(summary.remainingBalance)} remaining · {summary.monthsRemaining} payment
                          {summary.monthsRemaining === 1 ? '' : 's'} left
                        </p>
                      </div>
                    </div>
                    <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                  </button>

                  <div className="h-1.5 rounded-full mt-3 overflow-hidden" style={{ background: 'var(--color-track)' }}>
                    <div className="h-full rounded-full" style={{ width: `${percentRepaid}%`, background: 'var(--color-coral)' }} />
                  </div>

                  {isOpen && (
                    <LoanEditPanel
                      loan={loan}
                      categories={visibleCategoriesFor(data, loan.categoryId)}
                      people={data.people}
                      hasJointBills={hasJointBills}
                      onAddCategory={addCategory}
                      onSave={(u) => updateLoan(loan.id, u)}
                      onLogOverpayment={(amount, date, note) => logLoanOverpayment(loan.id, amount, date, note)}
                    />
                  )}
                </div>
              </SwipeToDelete>
            )
          })}
          {data.loans.length === 0 && !addingLoan && <p className="text-sm text-[var(--color-ink-muted)] text-center py-8">No loans yet.</p>}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="Credit Cards" headerExtra={<AddButton onClick={() => setAddingCard(true)} />}>
        <p className="text-xs text-[var(--color-ink-faint)] mb-3 leading-relaxed">
          A card's minimum/monthly payment is treated like a bill. Spend charged to a card (logged from the Expenses
          page) never touches your cash balance — only actual payments toward the card do.
        </p>

        {addingCard && (
          <CreditCardForm
            people={data.people}
            defaultOwnerId={data.primaryPersonId}
            nextColor={pickCreditCardColor(data.creditCards.length)}
            onCancel={() => setAddingCard(false)}
            onSave={(card) => {
              addCreditCard(card)
              setAddingCard(false)
            }}
          />
        )}

        <div className="flex flex-col gap-3">
          {data.creditCards.map((card) => {
            const minPayment = computeMinimumPaymentAmount(card)
            const isOpen = expandedCard === card.id
            return (
              <SwipeToDelete key={card.id} onDelete={() => removeCreditCard(card.id)} confirmLabel={card.name}>
                <div className="rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
                  <button onClick={() => setExpandedCard(isOpen ? null : card.id)} className="w-full flex items-center justify-between text-left">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex items-center justify-center shrink-0 rounded-full"
                        style={{ width: 32, height: 32, background: `${card.color}22` }}
                      >
                        <CreditCardIcon size={16} strokeWidth={1.75} style={{ color: card.color }} />
                      </span>
                      <div>
                        <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{card.name}</h3>
                        <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                          £{formatCurrency(card.currentBalance)} owed · £{formatCurrency(minPayment)} due on the {card.paymentDayOfMonth}
                          {ordinalSuffix(card.paymentDayOfMonth)}
                        </p>
                      </div>
                    </div>
                    <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
                  </button>

                  {isOpen && (
                    <CreditCardEditPanel
                      card={card}
                      people={data.people}
                      onSave={(u) => updateCreditCard(card.id, u)}
                      onUpdateLumpPayment={(lumpPaymentId, amount, date, note) => updateCreditCardLumpPayment(card.id, lumpPaymentId, amount, date, note)}
                      onRemoveLumpPayment={(lumpPaymentId) => removeCreditCardLumpPayment(card.id, lumpPaymentId)}
                      onLogLumpPayment={(amount, date, note) => logCreditCardLumpPayment(card.id, amount, date, note)}
                    />
                  )}
                </div>
              </SwipeToDelete>
            )
          })}
          {data.creditCards.length === 0 && !addingCard && <p className="text-sm text-[var(--color-ink-muted)] text-center py-8">No credit cards yet.</p>}
        </div>
      </CollapsibleSection>
    </div>
  )
}

function ordinalSuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return 'st'
  if (day % 10 === 2 && day !== 12) return 'nd'
  if (day % 10 === 3 && day !== 13) return 'rd'
  return 'th'
}

// ── Draft-then-Save edit panels — LoanEditPanel and CreditCardEditPanel
// follow the same convention as the Salary page's PeriodEditor: nothing
// persists until the explicit bottom Save button is pressed. Each mounts
// fresh (guarded by isOpen in the parent) whenever its row is expanded, so
// the draft always starts from the record's current saved values.
// Overpayment/lump-payment logging is a separate action (a new ledger
// entry, not a field edit on the loan/card record itself) and stays
// immediate, same as before. ──

type LoanDraft = Omit<Loan, 'id' | 'overpayments'>

function draftFromLoan(loan: Loan): LoanDraft {
  const { id: _id, overpayments: _overpayments, ...rest } = loan
  return rest
}

function LoanEditPanel({
  loan,
  categories,
  people,
  hasJointBills,
  onAddCategory,
  onSave,
  onLogOverpayment,
}: {
  loan: Loan
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  people: { id: string; name: string }[]
  hasJointBills: boolean
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<Loan, 'id' | 'overpayments'>>) => void
  onLogOverpayment: (amount: number, date: string, note?: string) => void
}) {
  const [draft, setDraft] = useState<LoanDraft>(() => draftFromLoan(loan))
  const [savedMessage, setSavedMessage] = useState<string | null>(null)
  const [loggingOverpayment, setLoggingOverpayment] = useState(false)

  function update(patch: Partial<LoanDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
    setSavedMessage(null)
  }

  // Live preview of the schedule impact of unsaved edits — merges the draft
  // onto the persisted loan (id/overpayments aren't part of the draft) so
  // "Total payable" reflects what Save would produce, not just what's
  // already stored.
  const previewSummary = summarizeLoan({ ...loan, ...draft })

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Name" value={draft.name} onChange={(v) => update({ name: v })} />
        <EditField label="Monthly payment (£)" type="number" value={draft.monthlyPayment} onChange={(v) => update({ monthlyPayment: Number(v) })} />
        <EditField label="Term (months)" type="number" value={draft.termMonths} onChange={(v) => update({ termMonths: Number(v) })} />
        <EditField label="Start date" type="date" value={draft.startDate} onChange={(v) => update({ startDate: v })} />
      </div>
      <p className="text-xs text-[var(--color-ink-faint)]">Total payable (nominal): £{formatCurrency(previewSummary.totalPayable)}</p>

      <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />

      {(hasJointBills || draft.location === 'joint') && (
        <LocationEditor
          people={people}
          location={draft.location}
          ownerId={draft.ownerId}
          payee={draft.payee}
          payeeSharePercent={draft.payeeSharePercent}
          onChange={update}
        />
      )}

      {loan.overpayments.length > 0 && (
        <div className="text-xs text-[var(--color-ink-muted)]">
          {loan.overpayments.length} overpayment{loan.overpayments.length === 1 ? '' : 's'} logged, totalling £
          {formatCurrency(loan.overpayments.reduce((sum, o) => sum + o.amount, 0))}
        </div>
      )}
      {!loggingOverpayment ? (
        <button onClick={() => setLoggingOverpayment(true)} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
          + Log an overpayment
        </button>
      ) : (
        <OverpaymentForm
          onLog={(amount, date, note) => {
            onLogOverpayment(amount, date, note)
            setLoggingOverpayment(false)
          }}
        />
      )}

      <RecurringOverpaymentEditor value={draft.recurringOverpayment} onChange={(recurringOverpayment) => update({ recurringOverpayment })} />

      {savedMessage && (
        <p className="text-xs" style={{ color: 'var(--color-positive)' }}>
          {savedMessage}
        </p>
      )}

      <button
        onClick={() => {
          onSave(draft)
          setSavedMessage('Saved.')
        }}
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
    </div>
  )
}

type CreditCardDraft = Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>

function draftFromCard(card: CreditCard): CreditCardDraft {
  const { id: _id, lumpPayments: _lumpPayments, active: _active, ...rest } = card
  return rest
}

function CreditCardEditPanel({
  card,
  people,
  onSave,
  onUpdateLumpPayment,
  onRemoveLumpPayment,
  onLogLumpPayment,
}: {
  card: CreditCard
  people: { id: string; name: string }[]
  onSave: (u: Partial<Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>>) => void
  onUpdateLumpPayment: (lumpPaymentId: string, amount: number, date: string, note?: string) => void
  onRemoveLumpPayment: (lumpPaymentId: string) => void
  onLogLumpPayment: (amount: number, date: string, note?: string) => void
}) {
  const [draft, setDraft] = useState<CreditCardDraft>(() => draftFromCard(card))
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  function update(patch: Partial<CreditCardDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
    setSavedMessage(null)
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Name" value={draft.name} onChange={(v) => update({ name: v })} />
        <EditField label="Interest rate (% APR)" type="number" value={draft.interestRatePercent} onChange={(v) => update({ interestRatePercent: Number(v) })} />
        <EditField label="Current balance (£)" type="number" value={draft.currentBalance} onChange={(v) => update({ currentBalance: Number(v) })} />
        <EditField
          label="Payment day of month"
          type="number"
          value={draft.paymentDayOfMonth}
          onChange={(v) => update({ paymentDayOfMonth: Math.max(1, Math.min(31, Number(v))) })}
        />
      </div>

      <MinimumPaymentEditor value={draft.minimumPayment} onChange={(minimumPayment) => update({ minimumPayment })} />

      {people.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Owner</span>
          <select
            value={draft.ownerId}
            onChange={(e) => update({ ownerId: e.target.value })}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <LumpPaymentList payments={card.lumpPayments} onUpdate={onUpdateLumpPayment} onRemove={onRemoveLumpPayment} />
      <OverpaymentForm label="Log a payment" onLog={onLogLumpPayment} />

      {savedMessage && (
        <p className="text-xs" style={{ color: 'var(--color-positive)' }}>
          {savedMessage}
        </p>
      )}

      <button
        onClick={() => {
          onSave(draft)
          setSavedMessage('Saved.')
        }}
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
    </div>
  )
}

// ── Overpayment / lump-payment logging — shared shape for both loans and credit cards ──

function OverpaymentForm({ label = 'Log an overpayment', onLog }: { label?: string; onLog: (amount: number, date: string, note?: string) => void }) {
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayIso())
  const [note, setNote] = useState('')
  const amountNumber = Number(amount)

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <span className="text-xs font-medium text-[var(--color-ink)]">{label}</span>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <button
        disabled={!(amountNumber > 0 && date)}
        onClick={() => {
          onLog(amountNumber, date, note || undefined)
          setAmount('')
          setNote('')
        }}
        className="self-end px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Log
      </button>
    </div>
  )
}

// ── Logged lump payments — listed individually with edit/delete, not just a summary total. Editing is reverse-then-relog under the hood (see LedgerContext), so it correctly reverses an already-cleared payment's balance effect before reapplying the new values. ──

function LumpPaymentList({
  payments,
  onUpdate,
  onRemove,
}: {
  payments: CreditCardLumpPayment[]
  onUpdate: (lumpPaymentId: string, amount: number, date: string, note?: string) => void
  onRemove: (lumpPaymentId: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  if (payments.length === 0) return null

  const sorted = payments.slice().sort((a, b) => b.date.localeCompare(a.date))
  const total = payments.reduce((sum, p) => sum + p.amount, 0)

  return (
    <div className="rounded-xl p-3 flex flex-col gap-1.5" style={{ background: 'var(--color-bg-elevated)' }}>
      <span className="text-xs font-medium text-[var(--color-ink)]">
        {payments.length} payment{payments.length === 1 ? '' : 's'} logged, totalling £{formatCurrency(total)}
      </span>
      {sorted.map((p) => (
        <div key={p.id} className="rounded-lg overflow-hidden" style={{ background: 'var(--color-surface)' }}>
          <button onClick={() => setEditingId(editingId === p.id ? null : p.id)} className="w-full flex items-center justify-between px-2.5 py-2 text-left">
            <div>
              <p className="text-sm text-[var(--color-ink)]">{p.note || 'Payment'}</p>
              <p className="text-[11px] text-[var(--color-ink-faint)]">{p.date}</p>
            </div>
            <span className="font-mono text-sm text-[var(--color-ink)]">£{formatCurrency(p.amount)}</span>
          </button>
          {editingId === p.id && (
            <LumpPaymentEditForm
              payment={p}
              onSave={(amount, date, note) => {
                onUpdate(p.id, amount, date, note)
                setEditingId(null)
              }}
              onDelete={() => {
                onRemove(p.id)
                setEditingId(null)
              }}
              onCancel={() => setEditingId(null)}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function LumpPaymentEditForm({
  payment,
  onSave,
  onDelete,
  onCancel,
}: {
  payment: CreditCardLumpPayment
  onSave: (amount: number, date: string, note?: string) => void
  onDelete: () => void
  onCancel: () => void
}) {
  const [amount, setAmount] = useState(String(payment.amount))
  const [date, setDate] = useState(payment.date)
  const [note, setNote] = useState(payment.note ?? '')
  const amountNumber = Number(amount)

  return (
    <div className="px-2.5 pb-2.5 flex flex-col gap-2 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <div className="grid grid-cols-2 gap-2 pt-2">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <div className="flex items-center justify-between">
        <button onClick={onDelete} className="text-xs" style={{ color: 'var(--color-negative)' }}>
          Delete
        </button>
        <button onClick={onCancel} className="text-xs text-[var(--color-ink-muted)] px-2">
          Cancel
        </button>
      </div>
      <button
        disabled={!(amountNumber > 0 && date)}
        onClick={() => onSave(amountNumber, date, note || undefined)}
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
    </div>
  )
}

// ── Recurring/standing overpayment — distinct from the one-off log above.
// A real ongoing commitment ("an extra £100 every month", or "an extra 5%
// of whatever's left, every month") folded into the regular monthly
// payment amount, not its own separate ledger line. Toggling it on
// starts with sensible defaults; toggling it off clears it entirely
// (passes undefined, same as never having set one). ──

function RecurringOverpaymentEditor({ value, onChange }: { value: LoanRecurringOverpayment | undefined; onChange: (v: LoanRecurringOverpayment | undefined) => void }) {
  const [showEndDate, setShowEndDate] = useState(!!value?.endDate)

  if (!value) {
    return (
      <button
        onClick={() => onChange({ startDate: todayIso(), amount: { type: 'fixed', amount: 50 } })}
        className="text-xs font-medium self-start"
        style={{ color: 'var(--color-coral)' }}
      >
        + Add a recurring overpayment
      </button>
    )
  }

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-ink)]">Recurring overpayment</span>
        <button
          onClick={() => {
            onChange(undefined)
            setShowEndDate(false)
          }}
          className="text-xs"
          style={{ color: 'var(--color-negative)' }}
        >
          Remove
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-ink-faint)] -mt-1">
        Added on top of the regular monthly payment, every month it's active — not its own separate line, just a
        bigger payment.
      </p>

      <div className="flex gap-2">
        <button
          onClick={() => onChange({ ...value, amount: value.amount.type === 'fixed' ? value.amount : { type: 'fixed', amount: 50 } })}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{ background: value.amount.type === 'fixed' ? 'var(--color-coral)' : 'var(--color-surface)', color: value.amount.type === 'fixed' ? '#fff' : 'var(--color-ink-muted)' }}
        >
          Fixed amount
        </button>
        <button
          onClick={() => onChange({ ...value, amount: value.amount.type === 'percent_of_balance' ? value.amount : { type: 'percent_of_balance', percent: 5 } })}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{
            background: value.amount.type === 'percent_of_balance' ? 'var(--color-coral)' : 'var(--color-surface)',
            color: value.amount.type === 'percent_of_balance' ? '#fff' : 'var(--color-ink-muted)',
          }}
        >
          % of remaining balance
        </button>
      </div>

      {value.amount.type === 'fixed' ? (
        <EditField label="Amount (£)" type="number" value={value.amount.amount} onChange={(v) => onChange({ ...value, amount: { type: 'fixed', amount: Number(v) } })} />
      ) : (
        <EditField
          label="Percent (%)"
          type="number"
          value={value.amount.percent}
          onChange={(v) => onChange({ ...value, amount: { type: 'percent_of_balance', percent: Number(v) } })}
        />
      )}

      <div className="grid grid-cols-2 gap-2">
        <EditField label="Payment date" type="date" value={value.startDate} onChange={(v) => onChange({ ...value, startDate: v })} />
        {showEndDate ? (
          <EditField label="End date" type="date" value={value.endDate ?? ''} onChange={(v) => onChange({ ...value, endDate: v || undefined })} />
        ) : (
          <button onClick={() => setShowEndDate(true)} className="self-end text-xs font-medium pb-1" style={{ color: 'var(--color-coral)' }}>
            + Set an end date
          </button>
        )}
      </div>
      {showEndDate && value.endDate && (
        <button
          onClick={() => {
            onChange({ ...value, endDate: undefined })
            setShowEndDate(false)
          }}
          className="self-start text-xs text-[var(--color-ink-muted)]"
        >
          Clear end date (run indefinitely)
        </button>
      )}
    </div>
  )
}

function MinimumPaymentEditor({ value, onChange }: { value: CreditCardMinimumPayment; onChange: (v: CreditCardMinimumPayment) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-[var(--color-ink-muted)]">Minimum payment</span>
      <div className="flex gap-2">
        <button
          onClick={() => onChange({ type: 'fixed', amount: value.type === 'fixed' ? value.amount : 25 })}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{ background: value.type === 'fixed' ? 'var(--color-coral)' : 'var(--color-surface)', color: value.type === 'fixed' ? '#fff' : 'var(--color-ink-muted)' }}
        >
          Fixed amount
        </button>
        <button
          onClick={() => onChange({ type: 'percent_of_balance', percent: value.type === 'percent_of_balance' ? value.percent : 5 })}
          className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
          style={{
            background: value.type === 'percent_of_balance' ? 'var(--color-coral)' : 'var(--color-surface)',
            color: value.type === 'percent_of_balance' ? '#fff' : 'var(--color-ink-muted)',
          }}
        >
          % of balance
        </button>
      </div>
      {value.type === 'fixed' ? (
        <EditField label="Amount (£)" type="number" value={value.amount} onChange={(v) => onChange({ type: 'fixed', amount: Number(v) })} />
      ) : (
        <EditField label="Percent (%)" type="number" value={value.percent} onChange={(v) => onChange({ type: 'percent_of_balance', percent: Number(v) })} />
      )}
    </div>
  )
}

// ── New loan form ──

function LoanForm({
  people,
  categories,
  defaultOwnerId,
  initial,
  hasJointBills,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultOwnerId: string
  initial?: LoanPrefill
  hasJointBills: boolean
  onAddCategory: (name: string) => { id: string }
  onSave: (loan: Omit<Loan, 'id' | 'overpayments'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [monthlyPayment, setMonthlyPayment] = useState(initial?.monthlyPayment ? String(initial.monthlyPayment) : '')
  const [termMonths, setTermMonths] = useState(initial?.termMonths ? String(initial.termMonths) : '')
  const [startDate, setStartDate] = useState(initial?.startDate ?? todayIso())
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? categories[0]?.id ?? '')
  const [location, setLocation] = useState<BillLocation>(initial?.location ?? 'personal')
  const [ownerId, setOwnerId] = useState(initial?.ownerId || defaultOwnerId)
  const [payee, setPayee] = useState(initial?.payee || (people[0]?.id ?? ''))
  const [payeeSharePercent, setPayeeSharePercent] = useState(initial?.payeeSharePercent ?? 50)

  const canSave = name.trim() && Number(monthlyPayment) > 0 && Number(termMonths) > 0 && startDate && categoryId

  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <EditField label="Name" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Monthly payment (£)" type="number" value={monthlyPayment} onChange={setMonthlyPayment} />
        <EditField label="Term (months)" type="number" value={termMonths} onChange={setTermMonths} />
      </div>
      <EditField label="Start date" type="date" value={startDate} onChange={setStartDate} />
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
      {(hasJointBills || location === 'joint') && (
        <LocationEditor
          people={people}
          location={location}
          ownerId={ownerId}
          payee={payee}
          payeeSharePercent={payeeSharePercent}
          onChange={(patch) => {
            setLocation(patch.location)
            if (patch.ownerId) setOwnerId(patch.ownerId)
            if (patch.payee) setPayee(patch.payee)
            if (patch.payeeSharePercent !== undefined) setPayeeSharePercent(patch.payeeSharePercent)
          }}
        />
      )}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm text-[var(--color-ink-muted)]">
          Cancel
        </button>
        <button
          disabled={!canSave}
          onClick={() =>
            onSave({
              name: name.trim(),
              monthlyPayment: Number(monthlyPayment),
              termMonths: Number(termMonths),
              startDate,
              categoryId,
              location,
              ownerId: location === 'personal' ? ownerId : '',
              payee: location === 'joint' ? payee : '',
              payeeSharePercent: location === 'joint' ? payeeSharePercent : 100,
            })
          }
          className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Add loan
        </button>
      </div>
    </div>
  )
}

// ── New credit card form ──
// categoryId is always the reserved built-in Credit Card category (see
// types/ledger.ts) — not user-chosen, since every card-related
// transaction is forced onto it regardless anyway. Colour is
// auto-assigned round-robin, same idea as Category auto-colour, from the
// separate CREDIT_CARD_COLORS palette.

function CreditCardForm({
  people,
  defaultOwnerId,
  nextColor,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  defaultOwnerId: string
  nextColor: string
  onSave: (card: Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [interestRatePercent, setInterestRatePercent] = useState('')
  const [currentBalance, setCurrentBalance] = useState('')
  const [paymentDayOfMonth, setPaymentDayOfMonth] = useState('1')
  const [minimumPayment, setMinimumPayment] = useState<CreditCardMinimumPayment>({ type: 'percent_of_balance', percent: 5 })
  const [ownerId, setOwnerId] = useState(defaultOwnerId)

  const canSave = name.trim() && Number(currentBalance) >= 0 && Number(paymentDayOfMonth) >= 1 && Number(paymentDayOfMonth) <= 31

  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <EditField label="Name" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Interest rate (% APR)" type="number" value={interestRatePercent} onChange={setInterestRatePercent} />
        <EditField label="Current balance (£)" type="number" value={currentBalance} onChange={setCurrentBalance} />
      </div>
      <EditField label="Payment day of month" type="number" value={paymentDayOfMonth} onChange={setPaymentDayOfMonth} />
      <MinimumPaymentEditor value={minimumPayment} onChange={setMinimumPayment} />
      {people.length > 1 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Owner</span>
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {people.map((p) => (
              <option key={p.id} value={p.id} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm text-[var(--color-ink-muted)]">
          Cancel
        </button>
        <button
          disabled={!canSave}
          onClick={() =>
            onSave({
              name: name.trim(),
              categoryId: CREDIT_CARD_CATEGORY_ID,
              color: nextColor,
              interestRatePercent: Number(interestRatePercent) || 0,
              currentBalance: Number(currentBalance) || 0,
              minimumPayment,
              paymentDayOfMonth: Number(paymentDayOfMonth),
              ownerId,
            })
          }
          className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Add card
        </button>
      </div>
    </div>
  )
}
