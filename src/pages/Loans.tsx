import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatMonthYear } from '../lib/format'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus, ChevronDown, ChevronUp, CreditCard as CreditCardIcon, X, Info, AlertTriangle } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { summarizeLoan, summarizeLoanProgress, estimateSettlementFigure, findLenderCalibrationProfile, previewOverpaymentRecast, previewRecurringOverpaymentRecast, buildLoanLedgerRows, loanFinishInfo, isLoanConfidentlyCalibrated, MAX_CALIBRATION_LINES, type CalibrationResult, type LoanLedgerRowType } from '../lib/ledgerLoans'
import { computeMinimumPaymentAmount, pickCreditCardColor, buildCreditCardMinimumChargeRows } from '../lib/creditCards'
import { CREDIT_CARD_CATEGORY_ID, type CreditCard, type CreditCardMinimumPayment, type Loan, type LoanRecurringOverpayment, type StatementCalibrationLine, type Transaction } from '../types/ledger'
import type { BillLocation } from '../types/models'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { visibleCategoriesFor, seededCategoryIdForIcon } from '../lib/categories'
import { aprToMonthlyRate, standardPayment } from '../lib/interestConventions'
import { LocationEditor } from '../components/LocationEditor'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { peopleWithSalaryCount } from '../lib/household'

import { todayIso } from '../lib/date'

// The pre-seeded "Loan" category (see categories.ts) — LoanForm defaults
// new loans onto this rather than falling through to whatever happens to
// be first in the visible list (which, with no credit cards yet, used to
// resolve to "Income" — clearly wrong for a loan).
const DEFAULT_LOAN_CATEGORY_ID = seededCategoryIdForIcon('loan')

type LoanPrefill = Partial<Omit<Loan, 'id' | 'overpayments'>>

// Handed off from the What-if page's "Log as real payment" / "Make this a
// real recurring overpayment" buttons (see Scenarios.tsx's makeImpactReal)
// — rather than auto-saving there, the user is transported here with the
// target row already open and the relevant fields pre-populated, and
// saves it themselves.
export type OverpaymentPrefill = {
  targetKind: 'loan' | 'credit_card'
  targetId: string
  mode: 'payoff' | 'recurring' // 'recurring' only ever applies to loans — see below
  amount: number
  date?: string // 'payoff' only
}

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
    updateLoanOverpayment,
    removeLoanOverpayment,
    settleLoanAction,
    calibrateLoanAction,
    addCreditCard,
    updateCreditCard,
    updateCreditCardMinimumCharge,
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
  const [overpaymentPrefill, setOverpaymentPrefill] = useState<OverpaymentPrefill | null>(null)
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const loanPrefill = (routerLocation.state as { loanPrefill?: LoanPrefill } | null)?.loanPrefill

  // Loans only offer a Personal/Joint choice once there's actually a joint
  // bill to make that split meaningful — see LoanEditPanel/LoanForm's
  // "hasJointBills" prop for the full reasoning.
  const hasJointBills = data.recurringTemplates.some((t) => t.location === 'joint')
  // ...and, separately, only once 2+ people actually have a salary
  // configured to split — see lib/household.ts's hasSalaryConfigured.
  const canBeJoint = peopleWithSalaryCount(data.people) >= 2

  useEffect(() => {
    if (loanPrefill) setAddingLoan(true)

    const prefill = (routerLocation.state as { overpaymentPrefill?: OverpaymentPrefill } | null)?.overpaymentPrefill
    if (prefill) {
      setOverpaymentPrefill(prefill)
      if (prefill.targetKind === 'loan') setExpandedLoan(prefill.targetId)
      else setExpandedCard(prefill.targetId)
      // Consumed into local state above — clear the router state so a
      // manual close/reopen of this same row later doesn't re-trigger it.
      navigate('.', { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLocation.state])

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Borrowing</h1>
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
            canBeJoint={canBeJoint}
            existingLoans={data.loans}
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
            const progress = summarizeLoanProgress(loan)
            const category = data.categories.find((c) => c.id === loan.categoryId)
            const isOpen = expandedLoan === loan.id
            return (
              <LoanRow
                key={loan.id}
                loan={loan}
                category={category}
                summary={summary}
                progress={progress}
                isOpen={isOpen}
                onToggle={() => setExpandedLoan(isOpen ? null : loan.id)}
                onRemove={() => removeLoan(loan.id)}
                categories={visibleCategoriesFor(data, loan.categoryId)}
                people={data.people}
                hasJointBills={hasJointBills}
                canBeJoint={canBeJoint}
                onAddCategory={addCategory}
                onSave={(u) => updateLoan(loan.id, u)}
                onLogOverpayment={(amount, date, note, recastMode) => logLoanOverpayment(loan.id, amount, date, note, recastMode)}
                onUpdateOverpayment={(overpaymentId, amount, date, note) => updateLoanOverpayment(loan.id, overpaymentId, amount, date, note)}
                onRemoveOverpayment={(overpaymentId) => removeLoanOverpayment(loan.id, overpaymentId)}
                onSettle={(amount, date, note) => settleLoanAction(loan.id, amount, date, note)}
                onCalibrate={(lines) => calibrateLoanAction(loan.id, lines)}
                overpaymentPrefill={overpaymentPrefill?.targetKind === 'loan' && overpaymentPrefill.targetId === loan.id ? overpaymentPrefill : null}
                onPrefillConsumed={() => setOverpaymentPrefill(null)}
              />
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
            categories={visibleCategoriesFor(data, CREDIT_CARD_CATEGORY_ID)}
            defaultOwnerId={data.primaryPersonId}
            nextColor={pickCreditCardColor(data.creditCards.length)}
            onAddCategory={addCategory}
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
              <CreditCardRow
                key={card.id}
                card={card}
                minPayment={minPayment}
                isOpen={isOpen}
                onToggle={() => setExpandedCard(isOpen ? null : card.id)}
                onRemove={() => removeCreditCard(card.id)}
                people={data.people}
                categories={visibleCategoriesFor(data, card.categoryId)}
                transactions={data.transactions}
                onAddCategory={addCategory}
                onSave={(u) => updateCreditCard(card.id, u)}
                onUpdateLumpPayment={(lumpPaymentId, amount, date, note) => updateCreditCardLumpPayment(card.id, lumpPaymentId, amount, date, note)}
                onRemoveLumpPayment={(lumpPaymentId) => removeCreditCardLumpPayment(card.id, lumpPaymentId)}
                onLogLumpPayment={(amount, date, note) => logCreditCardLumpPayment(card.id, amount, date, note)}
                onUpdateMinimumCharge={(date, amount) => updateCreditCardMinimumCharge(card.id, date, amount)}
                overpaymentPrefill={overpaymentPrefill?.targetKind === 'credit_card' && overpaymentPrefill.targetId === card.id ? overpaymentPrefill : null}
                onPrefillConsumed={() => setOverpaymentPrefill(null)}
              />
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

// ── Loan / Credit Card row wrappers — own the collapse-on-save + green
// flash feedback (see SavedFlash.tsx), matching the same pattern used on
// the Bills and Salary pages. The row collapses and its "open" edit
// panel unmounts (via the isOpen && guard), then the whole row briefly
// flashes green with a check mark and "Saved". ──

function LoanRow({
  loan,
  category,
  summary,
  progress,
  isOpen,
  onToggle,
  onRemove,
  categories,
  people,
  hasJointBills,
  canBeJoint,
  onAddCategory,
  onSave,
  onLogOverpayment,
  onUpdateOverpayment,
  onRemoveOverpayment,
  onSettle,
  onCalibrate,
  overpaymentPrefill,
  onPrefillConsumed,
}: {
  loan: Loan
  category: { id: string; name: string; icon: string; iconColor: string } | undefined
  summary: ReturnType<typeof summarizeLoan>
  progress: ReturnType<typeof summarizeLoanProgress>
  isOpen: boolean
  onToggle: () => void
  onRemove: () => void
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  people: { id: string; name: string }[]
  hasJointBills: boolean
  canBeJoint: boolean
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<Loan, 'id' | 'overpayments'>>) => void
  onLogOverpayment: (amount: number, date: string, note?: string, recastMode?: 'reduce_term' | 'reduce_payment') => void
  onUpdateOverpayment: (overpaymentId: string, amount: number, date: string, note?: string) => void
  onRemoveOverpayment: (overpaymentId: string) => void
  onSettle: (amount: number, date: string, note?: string) => void
  onCalibrate: (lines: StatementCalibrationLine[]) => CalibrationResult | null
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
}) {
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()
  const [ledgerOpen, setLedgerOpen] = useState(false)

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={loan.name}>
      <div className="relative rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center gap-2">
          <button onClick={onToggle} className="flex-1 min-w-0 flex items-center justify-between text-left">
            <div className="flex items-center gap-2 min-w-0">
              <CategoryIcon category={category} />
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-[var(--color-ink)] truncate">{loan.name}</h3>
                {/* Headline is the nominal remaining figure — "how much more
                    cash will I hand over if I keep paying as scheduled,"
                    including interest not yet accrued — matching the same
                    figure now headlined on the Home page's pie chart. True
                    capital/principal still owed (what a bank app's own
                    balance figure shows) stays visible on the line below,
                    clearly separate rather than silently swapped for it. */}
                <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                  £{formatCurrency(progress.nominalRemaining)} remaining · {summary.monthsRemaining} payment
                  {summary.monthsRemaining === 1 ? '' : 's'} left
                </p>
                <p className="text-[11px] text-[var(--color-ink-faint)]">£{formatCurrency(progress.capitalRemaining)} capital owed</p>
              </div>
            </div>
            <span className="text-[var(--color-ink-muted)] shrink-0 pl-2">{isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span>
          </button>
          {/* Loan ledger modal entry point (D8, scope §10) — deliberately on THIS card, on the Loans/Borrowing page, not on the Home page's pie card as the scope doc originally described. */}
          <button onClick={() => setLedgerOpen(true)} className="shrink-0 text-[var(--color-ink-faint)]" aria-label={`View ${loan.name}'s ledger`}>
            <Info size={16} />
          </button>
        </div>

        {ledgerOpen && <LoanLedgerModal loan={loan} onClose={() => setLedgerOpen(false)} />}

        <div className="h-1.5 rounded-full mt-3 overflow-hidden" style={{ background: 'var(--color-track)' }}>
          <div className="h-full rounded-full" style={{ width: `${progress.percentPaid}%`, background: 'var(--color-coral)' }} />
        </div>

        {isOpen && (
          <LoanEditPanel
            loan={loan}
            categories={categories}
            people={people}
            hasJointBills={hasJointBills}
            canBeJoint={canBeJoint}
            onAddCategory={onAddCategory}
            onSave={(u) => {
              onSave(u)
              onToggle()
              triggerFlash()
            }}
            onLogOverpayment={onLogOverpayment}
            onUpdateOverpayment={onUpdateOverpayment}
            onRemoveOverpayment={onRemoveOverpayment}
            onSettle={(amount, date, note) => {
              onSettle(amount, date, note)
              onToggle()
              triggerFlash()
            }}
            onCalibrate={onCalibrate}
            overpaymentPrefill={overpaymentPrefill}
            onPrefillConsumed={onPrefillConsumed}
          />
        )}

        <SavedFlashOverlay active={flashActive} />
      </div>
    </SwipeToDelete>
  )
}

function CreditCardRow({
  card,
  minPayment,
  isOpen,
  onToggle,
  onRemove,
  people,
  categories,
  transactions,
  onAddCategory,
  onSave,
  onUpdateLumpPayment,
  onRemoveLumpPayment,
  onLogLumpPayment,
  onUpdateMinimumCharge,
  overpaymentPrefill,
  onPrefillConsumed,
}: {
  card: CreditCard
  minPayment: number
  isOpen: boolean
  onToggle: () => void
  onRemove: () => void
  people: { id: string; name: string }[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  transactions: Transaction[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>>) => void
  onUpdateLumpPayment: (lumpPaymentId: string, amount: number, date: string, note?: string) => void
  onRemoveLumpPayment: (lumpPaymentId: string) => void
  onLogLumpPayment: (amount: number, date: string, note?: string) => void
  onUpdateMinimumCharge: (date: string, amount: number) => void
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
}) {
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()
  const [ledgerOpen, setLedgerOpen] = useState(false)

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={card.name}>
      <div className="relative rounded-2xl p-4" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center gap-2">
          <button onClick={onToggle} className="flex-1 min-w-0 flex items-center justify-between text-left">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center justify-center shrink-0 rounded-full" style={{ width: 32, height: 32, background: `${card.color}22` }}>
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
          <button onClick={() => setLedgerOpen(true)} className="shrink-0 text-[var(--color-ink-faint)]" aria-label={`View ${card.name}'s minimum charges`}>
            <Info size={16} />
          </button>
        </div>

        {ledgerOpen && <CreditCardLedgerModal card={card} transactions={transactions} onUpdateMinimumCharge={onUpdateMinimumCharge} onClose={() => setLedgerOpen(false)} />}

        {isOpen && (
          <CreditCardEditPanel
            card={card}
            people={people}
            categories={categories}
            onAddCategory={onAddCategory}
            onSave={(u) => {
              onSave(u)
              onToggle()
              triggerFlash()
            }}
            onUpdateLumpPayment={onUpdateLumpPayment}
            onRemoveLumpPayment={onRemoveLumpPayment}
            onLogLumpPayment={onLogLumpPayment}
            overpaymentPrefill={overpaymentPrefill}
            onPrefillConsumed={onPrefillConsumed}
          />
        )}

        <SavedFlashOverlay active={flashActive} />
      </div>
    </SwipeToDelete>
  )
}
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
  canBeJoint,
  onAddCategory,
  onSave,
  onLogOverpayment,
  onUpdateOverpayment,
  onRemoveOverpayment,
  onSettle,
  onCalibrate,
  overpaymentPrefill,
  onPrefillConsumed,
}: {
  loan: Loan
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  people: { id: string; name: string }[]
  hasJointBills: boolean
  canBeJoint: boolean
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<Loan, 'id' | 'overpayments'>>) => void
  onLogOverpayment: (amount: number, date: string, note?: string, recastMode?: 'reduce_term' | 'reduce_payment') => void
  onUpdateOverpayment: (overpaymentId: string, amount: number, date: string, note?: string) => void
  onRemoveOverpayment: (overpaymentId: string) => void
  onSettle: (amount: number, date: string, note?: string) => void
  onCalibrate: (lines: StatementCalibrationLine[]) => CalibrationResult | null
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
}) {
  // A 'recurring' prefill (from the What-if page's "Make this a real
  // recurring overpayment" button) seeds the draft's recurringOverpayment
  // straight away rather than the loan's current saved value — the user
  // still has to hit Save to actually commit it. A 'payoff' prefill
  // instead pre-opens the one-off log form below (see loggingOverpayment).
  const [draft, setDraft] = useState<LoanDraft>(() => {
    const base = draftFromLoan(loan)
    if (overpaymentPrefill && overpaymentPrefill.mode === 'recurring') {
      return { ...base, recurringOverpayment: { startDate: todayIso(), amount: { type: 'fixed', amount: overpaymentPrefill.amount } } }
    }
    return base
  })
  const [loggingOverpayment, setLoggingOverpayment] = useState(overpaymentPrefill?.mode === 'payoff')
  const [settlingLoan, setSettlingLoan] = useState(false)
  const [calibratingLoan, setCalibratingLoan] = useState(false)

  // Prefill only needs to seed the initial draft/form state above — once
  // this panel has mounted with it, tell the parent to forget it so a
  // later manual close/reopen of this same row starts fresh.
  useEffect(() => {
    if (overpaymentPrefill) onPrefillConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function update(patch: Partial<LoanDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
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
        <EditField label="Lender (optional)" value={draft.lender ?? ''} onChange={(v) => update({ lender: v || undefined })} />
        <EditField label="Amount borrowed (£)" type="number" value={draft.principal} onChange={(v) => update({ principal: Number(v) })} />
        <EditField label="Interest rate (% APR, optional)" type="number" value={draft.apr ?? ''} onChange={(v) => update({ apr: v ? Number(v) : undefined })} />
        <EditField label="Monthly payment (£)" type="number" value={draft.monthlyPayment} onChange={(v) => update({ monthlyPayment: Number(v) })} />
        <EditField label="Term (months)" type="number" value={draft.termMonths} onChange={(v) => update({ termMonths: Number(v) })} />
        <EditField label="First payment date" type="date" value={draft.startDate} onChange={(v) => update({ startDate: v })} />
        <EditField label="Advance date (optional)" type="date" value={draft.advanceDate ?? ''} onChange={(v) => update({ advanceDate: v || undefined })} />
        {/* Deliberately no mention of WHICH interest convention matched
            anywhere in the app — that's internal plumbing (loan-amortisation
            scope §5.1/§5.5), not something to surface. This is purely a
            status indicator: red + warning icon means the loan is still on
            an uncalibrated estimate and would benefit from real statement
            lines; green means a confident fit already exists. Always
            visible (not hidden once confident) so the affordance to add
            more lines for extra precision never disappears. */}
        <button
          onClick={() => setCalibratingLoan(true)}
          className="flex items-center gap-1.5 text-xs font-medium self-end justify-self-start pb-1"
          style={{ color: isLoanConfidentlyCalibrated(loan) ? 'var(--color-positive)' : 'var(--color-negative)' }}
        >
          {!isLoanConfidentlyCalibrated(loan) && <AlertTriangle size={12} />}
          Calibrate
        </button>
      </div>
      <p className="text-xs text-[var(--color-ink-faint)]">Total payable (nominal): £{formatCurrency(previewSummary.totalPayable)}</p>

      <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />

      {(hasJointBills || draft.location === 'joint') && (
        <LocationEditor
          people={people}
          canBeJoint={canBeJoint}
          location={draft.location}
          ownerId={draft.ownerId}
          payee={draft.payee}
          payeeSharePercent={draft.payeeSharePercent}
          onChange={update}
        />
      )}

      {/* Editable, matching how a credit card's logged lump payments appear — each overpayment is its own row, tappable to edit or delete, not just a rolled-up summary line. */}
      <LoggedPaymentList payments={loan.overpayments} onUpdate={onUpdateOverpayment} onRemove={onRemoveOverpayment} />
      {!loggingOverpayment ? (
        <button onClick={() => setLoggingOverpayment(true)} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
          + Log an overpayment
        </button>
      ) : (
        <LoanOverpaymentForm
          loan={{ ...loan, ...draft }}
          initialAmount={overpaymentPrefill?.mode === 'payoff' ? overpaymentPrefill.amount : undefined}
          initialDate={overpaymentPrefill?.mode === 'payoff' ? overpaymentPrefill.date : undefined}
          onLog={(amount, date, note, recastMode) => {
            onLogOverpayment(amount, date, note, recastMode)
            setLoggingOverpayment(false)
          }}
        />
      )}

      <RecurringOverpaymentEditor loan={{ ...loan, ...draft }} value={draft.recurringOverpayment} onChange={(recurringOverpayment) => update({ recurringOverpayment })} />

      {calibratingLoan && (
        <CalibrationModal loanName={loan.name} existingLinesCount={loan.statementCalibrationLines?.length ?? 0} onCalibrate={onCalibrate} onClose={() => setCalibratingLoan(false)} />
      )}

      {loan.active ? (
        <>
          <button onClick={() => setSettlingLoan(true)} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
            Settle this loan
          </button>
          {settlingLoan && (
            <SettleLoanModal
              loanName={loan.name}
              estimatedSettlement={estimateSettlementFigure({ ...loan, ...draft })}
              trueOutstandingBalance={previewSummary.remainingBalance}
              onSettle={(amount, date, note) => {
                onSettle(amount, date, note)
                setSettlingLoan(false)
              }}
              onClose={() => setSettlingLoan(false)}
            />
          )}
        </>
      ) : (
        <p className="text-xs text-[var(--color-ink-faint)]">
          Settled for £{formatCurrency(loan.settledAmount ?? 0)}
          {loan.closedDate ? ` on ${loan.closedDate}` : ''}
        </p>
      )}

      <button
        onClick={() => onSave(draft)}
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
  categories,
  onAddCategory,
  onSave,
  onUpdateLumpPayment,
  onRemoveLumpPayment,
  onLogLumpPayment,
  overpaymentPrefill,
  onPrefillConsumed,
}: {
  card: CreditCard
  people: { id: string; name: string }[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>>) => void
  onUpdateLumpPayment: (lumpPaymentId: string, amount: number, date: string, note?: string) => void
  onRemoveLumpPayment: (lumpPaymentId: string) => void
  onLogLumpPayment: (amount: number, date: string, note?: string) => void
  overpaymentPrefill: OverpaymentPrefill | null
  onPrefillConsumed: () => void
}) {
  const [draft, setDraft] = useState<CreditCardDraft>(() => draftFromCard(card))

  useEffect(() => {
    if (overpaymentPrefill) onPrefillConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function update(patch: Partial<CreditCardDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
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

      {/* Freely reassignable, same as a loan's — this only changes the
          card's own icon/colour identity everywhere it's shown (its row
          here, the pie-chart centre on Home). Every credit-card
          transaction still always folds into the fixed "Credit Card"
          bucket in the Home page's "group by category" view regardless
          of what's picked here — see groupingCategoryId in Home.tsx. */}
      <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />

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
      <OverpaymentForm
        label="Log a payment"
        initialAmount={overpaymentPrefill?.amount}
        initialDate={overpaymentPrefill?.date}
        onLog={onLogLumpPayment}
      />

      <button
        onClick={() => onSave(draft)}
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
    </div>
  )
}

// ── Overpayment / lump-payment logging — shared shape for both loans and credit cards ──

/**
 * Read-only, scrollable, date-ascending record of every dated event on
 * this loan (scope §10) — reached from the info icon on the loan's own
 * card on THIS page (deliberately, not the Home page's pie card, which
 * is where the scope doc originally placed it). A finish-date banner up
 * top is computed live from the real schedule (loanFinishInfo), and each
 * row is one dated event, not one period — a period with both a regular
 * payment and an overpayment is two rows, keeping the three payment
 * types visually distinguishable per scope's explicit requirement.
 */
function LoanLedgerModal({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const rows = buildLoanLedgerRows(loan)
  const finish = loanFinishInfo(loan)

  const finishLabel = finish.settledEarly
    ? `Settled${finish.finishDate ? ` ${finish.finishDate}` : ''}`
    : finish.finishDate
      ? `Finishes: ${formatMonthYear(finish.finishDate)}${finish.monthsEarly > 0 ? ` (${finish.monthsEarly} month${finish.monthsEarly === 1 ? '' : 's'} early due to overpayments)` : ''}`
      : 'No schedule yet'

  const typeStyles: Record<LoanLedgerRowType, { label: string; color: string }> = {
    'Monthly Repayment': { label: 'Monthly', color: 'var(--color-ink-muted)' },
    'Ad-hoc Overpayment': { label: 'Ad-hoc overpayment', color: 'var(--color-coral)' },
    'Recurring Overpayment': { label: 'Recurring overpayment', color: 'var(--color-coral)' },
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] flex flex-col"
        style={{
          background: 'var(--color-surface)',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{loan.name}</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        <div className="rounded-xl p-3 mb-3" style={{ background: 'var(--color-bg-elevated)' }}>
          <p className="text-sm font-medium text-[var(--color-ink)]">{finishLabel}</p>
        </div>

        <div className="overflow-y-auto flex-1 -mx-5 px-5">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-ink-faint)]" style={{ borderBottom: '1px solid var(--color-track)' }}>
                <th className="py-1.5 font-medium">Date</th>
                <th className="py-1.5 font-medium text-right">Amount</th>
                <th className="py-1.5 font-medium text-right">Capital</th>
                <th className="py-1.5 font-medium text-right">Interest</th>
                <th className="py-1.5 font-medium text-right">Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--color-track)' }}>
                  <td className="py-1.5 text-[var(--color-ink)] whitespace-nowrap">{row.date}</td>
                  <td className="py-1.5 text-right text-[var(--color-ink)]">£{formatCurrency(row.amount)}</td>
                  <td className="py-1.5 text-right text-[var(--color-ink-muted)]">£{formatCurrency(row.capital)}</td>
                  <td className="py-1.5 text-right text-[var(--color-ink-muted)]">£{formatCurrency(row.interest)}</td>
                  <td className="py-1.5 text-right whitespace-nowrap" style={{ color: typeStyles[row.type].color }}>
                    {typeStyles[row.type].label}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-[var(--color-ink-faint)]">
                    No schedule yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * Credit card equivalent of LoanLedgerModal (bug report: "replicate the
 * same modal used for loan ledgers for credit cards") — but deliberately
 * narrower in scope and different in one key way, per the explicit
 * request: ONLY minimum-charge rows (spend and lump payments already
 * have a full ledger on the card's own Home page detail view, so
 * duplicating them here would just be clutter), and rows are tappable —
 * tapping one turns it into an inline amount editor rather than being
 * purely read-only like the loan version. Works for both past
 * (materialized) and future (still-projected) rows transparently — see
 * updateCreditCardMinimumCharge's own comment for how the two cases
 * resolve differently under the hood.
 */
function CreditCardLedgerModal({
  card,
  transactions,
  onUpdateMinimumCharge,
  onClose,
}: {
  card: CreditCard
  transactions: Transaction[]
  onUpdateMinimumCharge: (date: string, amount: number) => void
  onClose: () => void
}) {
  const rows = buildCreditCardMinimumChargeRows(card, transactions)
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  function startEditing(row: { date: string; amount: number }) {
    setEditingDate(row.date)
    setEditValue(String(row.amount))
  }

  function commitEdit() {
    if (editingDate && Number(editValue) >= 0) onUpdateMinimumCharge(editingDate, Number(editValue))
    setEditingDate(null)
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] flex flex-col"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">{card.name} — minimum charges</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-muted)] mb-3">Tap a payment to adjust it — past or future. Spend and other card activity are on the card's own page.</p>

        <div className="overflow-y-auto flex-1 -mx-5 px-5 flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
          {rows.map((row) =>
            editingDate === row.date ? (
              <div key={row.date} className="py-2 flex items-center gap-2">
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
              <button key={row.date} onClick={() => startEditing(row)} className="py-2 flex items-center justify-between text-left">
                <span className="text-xs text-[var(--color-ink)]">
                  {row.date}
                  {row.status === 'pending' && <span className="text-[var(--color-ink-faint)]"> · Upcoming</span>}
                </span>
                <span className="text-xs font-mono text-[var(--color-ink)]">£{formatCurrency(row.amount)}</span>
              </button>
            ),
          )}
          {rows.length === 0 && <p className="py-4 text-center text-xs text-[var(--color-ink-faint)]">No minimum charges yet.</p>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function SettleLoanModal({
  loanName,
  estimatedSettlement,
  trueOutstandingBalance,
  onSettle,
  onClose,
}: {
  loanName: string
  estimatedSettlement: number
  trueOutstandingBalance: number
  onSettle: (amount: number, date: string, note?: string) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState(estimatedSettlement > 0 ? String(estimatedSettlement) : '')
  const [date, setDate] = useState(todayIso())
  const [note, setNote] = useState('')
  const amountNumber = Number(amount)
  const canSave = amountNumber > 0 && date

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{
          background: 'var(--color-surface)',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Settle this loan</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        <p className="text-xs text-[var(--color-ink-muted)] mb-4 leading-relaxed">
          Log the real amount actually paid to close {loanName} early — this may differ from the estimate below.
          Saving zeroes off the loan's balance and marks it settled, regardless of what its schedule predicted.
        </p>

        <div className="rounded-xl p-3 mb-4 flex flex-col gap-1" style={{ background: 'var(--color-bg-elevated)' }}>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--color-ink-muted)]">True outstanding balance</span>
            <span className="text-[var(--color-ink)] font-medium">£{formatCurrency(trueOutstandingBalance)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--color-ink-muted)]">Estimated settlement figure</span>
            <span className="text-[var(--color-ink)] font-medium">£{formatCurrency(estimatedSettlement)}</span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <EditField label="Amount actually paid (£)" type="number" value={amount} onChange={setAmount} />
          <EditField label="Date" type="date" value={date} onChange={setDate} />
          <EditField label="Note (optional)" value={note} onChange={setNote} />
        </div>

        <button
          disabled={!canSave}
          onClick={() => onSettle(amountNumber, date, note || undefined)}
          className="w-full mt-5 py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Save
        </button>
      </div>
    </div>,
    document.body,
  )
}

function CalibrationModal({
  loanName,
  existingLinesCount,
  onCalibrate,
  onClose,
}: {
  loanName: string
  existingLinesCount: number
  onCalibrate: (lines: StatementCalibrationLine[]) => CalibrationResult | null
  onClose: () => void
}) {
  const [rows, setRows] = useState<{ date: string; capital: string; interest: string }[]>([{ date: todayIso(), capital: '', interest: '' }])
  const [result, setResult] = useState<CalibrationResult | null>(null)

  const canAddRow = existingLinesCount + rows.length < MAX_CALIBRATION_LINES
  const validRows = rows.filter((r) => r.date && Number(r.capital) > 0 && Number(r.interest) >= 0)
  const canSubmit = rows.length > 0 && validRows.length === rows.length

  function submit() {
    const lines: StatementCalibrationLine[] = rows.map((r) => ({ date: r.date, capital: Number(r.capital), interest: Number(r.interest) }))
    setResult(onCalibrate(lines))
  }

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5 max-h-[85vh] overflow-y-auto"
        style={{
          background: 'var(--color-surface)',
          paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-base font-semibold text-[var(--color-ink)]">Calibrate interest</h3>
          <button onClick={onClose} className="text-[var(--color-ink-muted)]">
            <X size={20} />
          </button>
        </div>

        {!result ? (
          <>
            <p className="text-xs text-[var(--color-ink-muted)] mb-4 leading-relaxed">
              Enter real statement lines for {loanName} — the date, capital, and interest shown on each real payment. 2-3 is usually enough; up to{' '}
              {MAX_CALIBRATION_LINES} in total including any already saved against this loan.
            </p>
            <div className="flex flex-col gap-3">
              {rows.map((row, i) => (
                <div key={i} className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
                  <div className="grid grid-cols-3 gap-2">
                    <EditField label="Date" type="date" value={row.date} onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, date: v } : r)))} />
                    <EditField label="Capital (£)" type="number" value={row.capital} onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, capital: v } : r)))} />
                    <EditField label="Interest (£)" type="number" value={row.interest} onChange={(v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, interest: v } : r)))} />
                  </div>
                  {rows.length > 1 && (
                    <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-xs self-start" style={{ color: 'var(--color-negative)' }}>
                      Remove line
                    </button>
                  )}
                </div>
              ))}
            </div>
            {canAddRow && (
              <button
                onClick={() => setRows((rs) => [...rs, { date: todayIso(), capital: '', interest: '' }])}
                className="text-xs font-medium self-start mt-3"
                style={{ color: 'var(--color-coral)' }}
              >
                + Add another line
              </button>
            )}
            <button
              disabled={!canSubmit}
              onClick={submit}
              className="w-full mt-5 py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: 'var(--color-coral)' }}
            >
              Calibrate
            </button>
          </>
        ) : (
          <div className="flex flex-col gap-3">
            {result.confidence === 'confident' ? (
              <p className="text-sm text-[var(--color-ink)] leading-relaxed">This loan's real statements matched a known interest pattern — its schedule now uses it.</p>
            ) : (
              <p className="text-sm leading-relaxed" style={{ color: 'var(--color-coral)' }}>
                {result.message}
              </p>
            )}
            {/* No convention name surfaced here or anywhere else in the app —
                which of the growable library's candidates matched is
                internal plumbing, not something to show. Just whether
                calibration succeeded (via the message above) and, on the
                loan card itself, a colour-coded status (see LoanEditPanel). */}
            {result.confidence !== 'confident' && existingLinesCount + rows.length < MAX_CALIBRATION_LINES && (
              <button
                onClick={() => {
                  setResult(null)
                  setRows([{ date: todayIso(), capital: '', interest: '' }])
                }}
                className="text-xs font-medium self-start"
                style={{ color: 'var(--color-coral)' }}
              >
                + Add more lines
              </button>
            )}
            <button onClick={onClose} className="w-full mt-2 py-2.5 rounded-full text-sm font-semibold text-white" style={{ background: 'var(--color-coral)' }}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The loan-specific one-off overpayment flow (D7's follow-up step,
 * loan-amortisation-engine scope §9/§11.3) — a genuinely separate
 * component from the shared OverpaymentForm below rather than an
 * optional prop on it, since OverpaymentForm is also used for credit
 * card lump payments, which have no recast concept at all. After
 * amount/date/note are entered, this shows a follow-up step (not an
 * inline choice) with both recast options as buttons, each carrying its
 * own real preview computed via previewOverpaymentRecast — "keep the
 * same length" shows the new monthly payment that choice would produce,
 * "keep monthly payment the same" shows the new finish date and
 * estimated final repayment.
 */
function LoanOverpaymentForm({
  loan,
  initialAmount,
  initialDate,
  onLog,
}: {
  loan: Loan
  initialAmount?: number
  initialDate?: string
  onLog: (amount: number, date: string, note: string | undefined, recastMode: 'reduce_term' | 'reduce_payment') => void
}) {
  const [amount, setAmount] = useState(initialAmount != null ? String(initialAmount) : '')
  const [date, setDate] = useState(initialDate ?? todayIso())
  const [note, setNote] = useState('')
  const [step, setStep] = useState<'entry' | 'choose'>('entry')
  const amountNumber = Number(amount)
  const canContinue = amountNumber > 0 && date

  function commit(recastMode: 'reduce_term' | 'reduce_payment') {
    onLog(amountNumber, date, note || undefined, recastMode)
    setAmount('')
    setNote('')
    setStep('entry')
  }

  if (step === 'choose') {
    const preview = previewOverpaymentRecast(loan, amountNumber, date)
    return (
      <div className="rounded-xl p-3 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <span className="text-xs font-medium text-[var(--color-ink)]">How should this overpayment be applied?</span>
        <button onClick={() => commit('reduce_payment')} className="rounded-lg p-3 text-left" style={{ background: 'var(--color-surface)' }}>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep the same length</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            New monthly payment: £{preview.reducePayment.newMonthlyPayment != null ? formatCurrency(preview.reducePayment.newMonthlyPayment) : '—'}
          </p>
        </button>
        <button onClick={() => commit('reduce_term')} className="rounded-lg p-3 text-left" style={{ background: 'var(--color-surface)' }}>
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep monthly payment the same</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            Ends {preview.reduceTerm.payoffDate ? formatMonthYear(preview.reduceTerm.payoffDate) : '—'} · estimated final repayment £
            {preview.reduceTerm.finalPayment != null ? formatCurrency(preview.reduceTerm.finalPayment) : '—'}
          </p>
        </button>
        <button onClick={() => setStep('entry')} className="text-xs self-start" style={{ color: 'var(--color-ink-muted)' }}>
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
      <span className="text-xs font-medium text-[var(--color-ink)]">Log an overpayment</span>
      <div className="grid grid-cols-2 gap-2">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" value={note} onChange={setNote} />
      <button
        disabled={!canContinue}
        onClick={() => setStep('choose')}
        className="self-end px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Continue
      </button>
    </div>
  )
}

function OverpaymentForm({
  label = 'Log an overpayment',
  initialAmount,
  initialDate,
  onLog,
}: {
  label?: string
  initialAmount?: number
  initialDate?: string
  onLog: (amount: number, date: string, note?: string) => void
}) {
  const [amount, setAmount] = useState(initialAmount != null ? String(initialAmount) : '')
  const [date, setDate] = useState(initialDate ?? todayIso())
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

// ── Logged payments — a one-off overpayment/lump payment listed
// individually with edit/delete, not just a rolled-up summary total.
// Shared between credit card lump payments and loan overpayments — both
// are the same {id, date, amount, note?} shape. Credit card editing is
// reverse-then-relog under the hood (see LedgerContext) so it correctly
// reverses an already-cleared payment's balance effect before reapplying
// the new values; loan overpayments don't need that step since a loan's
// balance is always derived fresh from its schedule, never stored. ──

type LoggedPayment = { id: string; date: string; amount: number; note?: string }

function LoggedPaymentList({
  payments,
  onUpdate,
  onRemove,
}: {
  payments: LoggedPayment[]
  onUpdate: (paymentId: string, amount: number, date: string, note?: string) => void
  onRemove: (paymentId: string) => void
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
            <LoggedPaymentEditForm
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

// Kept as an alias so the credit card call site below reads clearly.
const LumpPaymentList = LoggedPaymentList

function LoggedPaymentEditForm({
  payment,
  onSave,
  onDelete,
  onCancel,
}: {
  payment: LoggedPayment
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

function RecurringOverpaymentEditor({
  loan,
  value,
  onChange,
}: {
  loan: Loan
  value: LoanRecurringOverpayment | undefined
  onChange: (v: LoanRecurringOverpayment | undefined) => void
}) {
  const [showEndDate, setShowEndDate] = useState(!!value?.endDate)
  const [choosingRecast, setChoosingRecast] = useState(false)
  // Held separately from `value` itself: the amount has to be chosen
  // BEFORE a LoanRecurringOverpayment is created at all — confirmed as a
  // real bug that the old flow skipped straight to the recast-choice
  // screen with a silently-defaulted £50 fixed amount the person never
  // actually saw or chose, because clicking "+ Add a recurring
  // overpayment" created `value` (with that £50 default baked in) AND
  // opened the recast screen in the very same click.
  const [draftAmount, setDraftAmount] = useState<LoanRecurringOverpayment['amount'] | null>(null)

  if (!value && !draftAmount) {
    return (
      <button onClick={() => setDraftAmount({ type: 'fixed', amount: 50 })} className="text-xs font-medium self-start" style={{ color: 'var(--color-coral)' }}>
        + Add a recurring overpayment
      </button>
    )
  }

  // The amount step now genuinely comes first — nothing is created or
  // saved yet at this point, it's purely local draft state until
  // "Continue" commits it and moves on to the recast choice.
  if (!value && draftAmount) {
    return (
      <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: 'var(--color-bg-elevated)' }}>
        <span className="text-xs font-medium text-[var(--color-ink)]">Recurring overpayment amount</span>
        <div className="flex gap-2">
          <button
            onClick={() => setDraftAmount(draftAmount.type === 'fixed' ? draftAmount : { type: 'fixed', amount: 50 })}
            className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{ background: draftAmount.type === 'fixed' ? 'var(--color-coral)' : 'var(--color-surface)', color: draftAmount.type === 'fixed' ? '#fff' : 'var(--color-ink-muted)' }}
          >
            Fixed amount
          </button>
          <button
            onClick={() => setDraftAmount(draftAmount.type === 'percent_of_balance' ? draftAmount : { type: 'percent_of_balance', percent: 5 })}
            className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{
              background: draftAmount.type === 'percent_of_balance' ? 'var(--color-coral)' : 'var(--color-surface)',
              color: draftAmount.type === 'percent_of_balance' ? '#fff' : 'var(--color-ink-muted)',
            }}
          >
            % of balance
          </button>
        </div>
        {draftAmount.type === 'fixed' ? (
          <EditField label="Amount (£)" type="number" value={draftAmount.amount} onChange={(v) => setDraftAmount({ type: 'fixed', amount: Number(v) || 0 })} />
        ) : (
          <EditField label="Percent" type="number" value={draftAmount.percent} onChange={(v) => setDraftAmount({ type: 'percent_of_balance', percent: Number(v) || 0 })} />
        )}
        <div className="flex justify-end gap-3 mt-1">
          <button onClick={() => setDraftAmount(null)} className="text-xs text-[var(--color-ink-muted)]">
            Cancel
          </button>
          <button
            disabled={draftAmount.type === 'fixed' ? !(draftAmount.amount > 0) : !(draftAmount.percent > 0)}
            onClick={() => {
              onChange({ startDate: todayIso(), amount: draftAmount })
              setDraftAmount(null)
              setChoosingRecast(true)
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
            style={{ background: 'var(--color-coral)' }}
          >
            Continue
          </button>
        </div>
      </div>
    )
  }

  if (!value) return null // unreachable — satisfies TS narrowing below

  // D7's follow-up step (scope §9/§11.3 — recurring is in scope for the
  // recast choice too, not one-off only): shown once, right after a
  // recurring overpayment is first set up, with a real preview of each
  // outcome computed via previewRecurringOverpaymentRecast. Reachable
  // again later via the "Change" link below the live editor, so picking
  // wrong at creation isn't a dead end.
  if (choosingRecast) {
    const preview = previewRecurringOverpaymentRecast(loan, value)
    return (
      <div className="rounded-xl p-3 flex flex-col gap-3" style={{ background: 'var(--color-bg-elevated)' }}>
        <span className="text-xs font-medium text-[var(--color-ink)]">How should this recurring overpayment be applied?</span>
        <button
          onClick={() => {
            onChange({ ...value, recastMode: 'reduce_payment' })
            setChoosingRecast(false)
          }}
          className="rounded-lg p-3 text-left"
          style={{ background: 'var(--color-surface)' }}
        >
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep the same length</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            New monthly payment: £{preview.reducePayment.newMonthlyPayment != null ? formatCurrency(preview.reducePayment.newMonthlyPayment) : '—'}
          </p>
        </button>
        <button
          onClick={() => {
            onChange({ ...value, recastMode: 'reduce_term' })
            setChoosingRecast(false)
          }}
          className="rounded-lg p-3 text-left"
          style={{ background: 'var(--color-surface)' }}
        >
          <p className="text-sm font-semibold text-[var(--color-ink)]">Keep monthly payment the same</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
            Ends {preview.reduceTerm.payoffDate ? formatMonthYear(preview.reduceTerm.payoffDate) : '—'} · estimated final repayment £
            {preview.reduceTerm.finalPayment != null ? formatCurrency(preview.reduceTerm.finalPayment) : '—'}
          </p>
        </button>
      </div>
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
        Added on top of the regular monthly payment, every month it's active — shown as its own separate line in your ledger, alongside that month's regular payment.
      </p>
      <div className="flex items-center justify-between -mt-1">
        <p className="text-[11px] text-[var(--color-ink-faint)]">{value.recastMode === 'reduce_payment' ? 'Keeping the same length' : 'Keeping the monthly payment the same'}</p>
        <button onClick={() => setChoosingRecast(true)} className="text-[11px] font-medium" style={{ color: 'var(--color-coral)' }}>
          Change
        </button>
      </div>

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
  canBeJoint,
  existingLoans,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultOwnerId: string
  initial?: LoanPrefill
  hasJointBills: boolean
  canBeJoint: boolean
  existingLoans: Loan[]
  onAddCategory: (name: string) => { id: string }
  onSave: (loan: Omit<Loan, 'id' | 'overpayments'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [principal, setPrincipal] = useState(initial?.principal ? String(initial.principal) : '')
  const [monthlyPayment, setMonthlyPayment] = useState(initial?.monthlyPayment ? String(initial.monthlyPayment) : '')
  // Tracks whether monthlyPayment holds a value the PERSON typed, as
  // distinct from one the auto-suggest effect below wrote on their
  // behalf — confirmed as a real, serious bug without this distinction:
  // `monthlyPayment.trim() !== ''` alone can't tell "the person typed
  // this" apart from "the effect itself already wrote something here a
  // moment ago," so the very first keystroke of a multi-digit APR (e.g.
  // typing "8" of "8.7") would trigger one correct suggestion, then every
  // subsequent keystroke ("8.", "8.7") would see monthlyPayment already
  // non-empty and silently stop updating — leaving a stale, WRONG figure
  // sitting in the field looking exactly as filled-in as a correct one,
  // with nothing suggesting it hadn't kept up with the rest of what was
  // typed. Confirmed live: typing "8.7" character-by-character left the
  // suggestion frozen at the value for "8" alone, £3+ short of correct.
  const [monthlyPaymentTouched, setMonthlyPaymentTouched] = useState(!!initial?.monthlyPayment)
  const [termMonths, setTermMonths] = useState(initial?.termMonths ? String(initial.termMonths) : '')
  const [apr, setApr] = useState('')
  const [startDate, setStartDate] = useState(initial?.startDate ?? todayIso())
  const [advanceDate, setAdvanceDate] = useState(initial?.advanceDate ?? '')
  const [lender, setLender] = useState('')
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? (categories.some((c) => c.id === DEFAULT_LOAN_CATEGORY_ID) ? DEFAULT_LOAN_CATEGORY_ID : categories[0]?.id ?? ''))
  const [location, setLocation] = useState<BillLocation>(initial?.location ?? 'personal')
  const [ownerId, setOwnerId] = useState(initial?.ownerId || defaultOwnerId)
  const [payee, setPayee] = useState(initial?.payee || (people[0]?.id ?? ''))
  const [payeeSharePercent, setPayeeSharePercent] = useState(initial?.payeeSharePercent ?? 50)

  // APR is purely a suggestion source here (Loan.apr's own doc comment
  // explains why the engine itself never reads it back) — as soon as
  // principal/term/APR are all present, suggest a starting monthly
  // payment via the standard formula, but ONLY while the person hasn't
  // typed their own real figure in yet. Once they have, their number
  // wins outright and this stops touching the field at all — nudging a
  // value they've already deliberately overridden would be the wrong
  // kind of "helpful."
  useEffect(() => {
    if (monthlyPaymentTouched) return
    const p = Number(principal)
    const n = Number(termMonths)
    const a = Number(apr)
    if (!(p > 0) || !(n > 0) || !(a > 0)) return
    setMonthlyPayment(standardPayment(p, aprToMonthlyRate(a / 100), n).toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [principal, termMonths, apr, monthlyPaymentTouched])

  // Scope §5.3 step 5: a new loan from a lender that's already been
  // calibrated (or confidently back-solved) on a previous loan offers to
  // reuse that same profile straight away, instead of starting from
  // scratch — applied automatically on save when a match is found, no
  // extra confirmation step needed beyond the note below being visible.
  const matchedProfile = lender.trim() ? findLenderCalibrationProfile(existingLoans, lender) : null

  const canSave = name.trim() && Number(principal) > 0 && Number(monthlyPayment) > 0 && Number(termMonths) > 0 && startDate && categoryId

  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <EditField label="Name" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount borrowed (£)" type="number" value={principal} onChange={setPrincipal} />
        <EditField label="Interest rate (% APR, optional)" type="number" value={apr} onChange={setApr} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Term (months)" type="number" value={termMonths} onChange={setTermMonths} />
        <EditField
          label="Monthly payment (£)"
          type="number"
          value={monthlyPayment}
          onChange={(v) => {
            setMonthlyPayment(v)
            setMonthlyPaymentTouched(true)
          }}
        />
      </div>
      <p className="text-xs text-[var(--color-ink-faint)] -mt-1">
        {apr && Number(apr) > 0
          ? "Monthly payment is suggested from the APR above — type your real contractual figure over it if it's different."
          : 'Monthly payment is the one figure everything else is built from — your real contractual amount, from the loan agreement.'}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <EditField label="First payment date" type="date" value={startDate} onChange={setStartDate} />
        {/* Optional — falls back to First payment date if never set (ledgerLoans.ts's resolveLoanRateAndConvention). Routinely 3-8 weeks earlier than the first payment; only matters once a day-weighted interest convention is calibrated against this loan, but worth capturing up front since it's rarely known later. */}
        <EditField label="Advance date (optional)" type="date" value={advanceDate} onChange={setAdvanceDate} />
      </div>
      <EditField label="Lender (optional)" value={lender} onChange={setLender} />
      {matchedProfile && (
        <p className="text-xs" style={{ color: 'var(--color-coral)' }}>
          Using the interest calibration already saved for {lender.trim()}.
        </p>
      )}
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
      {(hasJointBills || location === 'joint') && (
        <LocationEditor
          people={people}
          canBeJoint={canBeJoint}
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
              principal: Number(principal),
              monthlyPayment: Number(monthlyPayment),
              termMonths: Number(termMonths),
              apr: apr.trim() ? Number(apr) : undefined,
              startDate,
              advanceDate: advanceDate || undefined,
              lender: lender.trim() || undefined,
              categoryId,
              location,
              ownerId: location === 'personal' ? ownerId : '',
              payee: location === 'joint' ? payee : '',
              payeeSharePercent: location === 'joint' ? payeeSharePercent : 100,
              active: true,
              ...(matchedProfile ?? {}),
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
// categoryId defaults to the built-in Credit Card category but is freely
// user-chosen from here, same as a loan's — only changes the card's own
// icon/colour identity, never which bucket its transactions fold into on
// the Home page's "group by category" view (see groupingCategoryId in
// Home.tsx, and the long comment on CREDIT_CARD_CATEGORY_ID in
// types/ledger.ts). Colour is auto-assigned round-robin, same idea as
// Category auto-colour, from the separate CREDIT_CARD_COLORS palette.

function CreditCardForm({
  people,
  categories,
  defaultOwnerId,
  nextColor,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultOwnerId: string
  nextColor: string
  onAddCategory: (name: string) => { id: string }
  onSave: (card: Omit<CreditCard, 'id' | 'lumpPayments' | 'active'>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [interestRatePercent, setInterestRatePercent] = useState('')
  const [currentBalance, setCurrentBalance] = useState('')
  const [paymentDayOfMonth, setPaymentDayOfMonth] = useState('1')
  const [minimumPayment, setMinimumPayment] = useState<CreditCardMinimumPayment>({ type: 'percent_of_balance', percent: 5 })
  const [ownerId, setOwnerId] = useState(defaultOwnerId)
  const [categoryId, setCategoryId] = useState(CREDIT_CARD_CATEGORY_ID)

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
      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
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
              categoryId,
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
