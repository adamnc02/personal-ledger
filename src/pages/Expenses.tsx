import { useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatFullDate, formatMonthYear } from '../lib/format'
import { Plus, Trash2, X, ChevronDown, ChevronUp, ArrowRight } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { PausedOccurrencesControl } from '../components/PausedOccurrencesControl'
import { schedulePreviewWindow, scheduledDepositDates, depositOccurrencePreviews, setPausedDeposits } from '../lib/savingsPotLedger'
import { schedulePotPreviewWindow, scheduledPotDepositDates, potDepositOccurrencePreviews, setPausedPotDeposits } from '../lib/potLedger'
import { FormButtonRow, CancelButton, SaveButton } from '../components/FormButtons'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { visibleCategoriesFor } from '../lib/categories'
import { recentAndUpcomingOccurrences, applyTemplateAmountChange, templateOccurrencePreviews, setPausedTemplateOccurrences, scheduledTemplateDates, generateTransactionsForTemplate, type RawOccurrence } from '../lib/schedule'
import { transferLocationLabel, buildTransferLocationOptions, type TransferLocationOption } from '../lib/transferLedger'
import { LocationStep, FrequencyStep, DateStep, type TransferFrequencyChoice, resolveTransferFrequencyChoice } from '../components/TransferSteps'
import { findSalarySortConflicts } from '../lib/salarySortLedger'
import { ConfirmModal } from '../components/ConfirmModal'
import { addYears } from 'date-fns'
import type { PaymentMethod, RecurrenceFrequency, RecurringTemplate, SavingsPot, Pot, Transaction, TransferLocation, AppDataV2 } from '../types/ledger'

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank Transfer',
  direct_debit: 'Direct Debit',
  standing_order: 'Standing Order',
}

// Direct Debit and Standing Order are for RECURRING things (bills, loans)
// — they don't make sense as a one-off ad-hoc payment method, so they're
// deliberately not offered here even though they're valid PaymentMethod
// values elsewhere in the app.
const EXPENSE_PAYMENT_METHODS: PaymentMethod[] = ['cash', 'card', 'bank_transfer']

const ENTRY_TYPES = [
  { value: 'expense', label: 'Expense' },
  { value: 'income', label: 'Income' },
] as const
type EntryType = (typeof ENTRY_TYPES)[number]['value']

// Recurring transactions offer the same frequency options as Bills,
// EXCEPT annual — only weekly/every-N-weeks/monthly/quarterly were asked
// for here; Bills.tsx's own FREQUENCY_LABELS is the full set including
// annual, kept separate rather than reused so a recurring transaction's
// picker can never silently offer annual.
const RECURRING_FREQUENCY_LABELS: Record<'weekly' | 'every_n_weeks' | 'monthly' | 'quarterly', string> = {
  weekly: 'Weekly',
  every_n_weeks: 'Every N weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
}
type RecurringFrequency = keyof typeof RECURRING_FREQUENCY_LABELS

import { todayIso } from '../lib/date'

type PageMode = 'transactions' | 'recurring' | 'transfer'

// ── Cleared-month grouping (Adam-specified, 2026-09-03) ────────────────
// Applies to every transaction-list pill (Transactions/Savings/Joint —
// NOT Recurring, which shows RecurringTemplate rows with no cleared/
// pending status at all): pending stays exactly as it already was, a
// flat list; cleared collapses into one card per calendar month,
// collapsed by default, so a long history doesn't dominate the page.
// Generic over the row's own item type so all three pills — three
// genuinely different row shapes — share one grouping/collapse
// implementation rather than three near-identical copies of it.
function MonthCollapsedTransactionList<T>({
  items,
  getDate,
  isCleared,
  renderRow,
  keyOf,
  emptyMessage,
}: {
  items: T[]
  getDate: (item: T) => string
  isCleared: (item: T) => boolean
  renderRow: (item: T) => React.ReactNode
  keyOf: (item: T) => string
  emptyMessage: string
}) {
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(() => new Set())
  const toggleMonth = (key: string) =>
    setExpandedMonths((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const pending = items.filter((i) => !isCleared(i))
  const cleared = items.filter(isCleared)

  // Grouped by calendar month (YYYY-MM) — items arrive already sorted by
  // the caller (each pill's own list is sorted before this component ever
  // sees it), so a month's own row order is preserved, only partitioned.
  const monthGroups = new Map<string, T[]>()
  for (const item of cleared) {
    const key = getDate(item).slice(0, 7)
    const list = monthGroups.get(key) ?? []
    list.push(item)
    monthGroups.set(key, list)
  }
  // Most recent month first — matches every pill's own existing
  // most-recent-first sort.
  const monthKeys = Array.from(monthGroups.keys()).sort((a, b) => b.localeCompare(a))

  return (
    <div className="flex flex-col gap-2">
      {pending.map((item) => (
        <div key={keyOf(item)}>{renderRow(item)}</div>
      ))}

      {monthKeys.map((monthKey) => {
        const monthItems = monthGroups.get(monthKey)!
        const expanded = expandedMonths.has(monthKey)
        return (
          <div key={monthKey} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
            <button onClick={() => toggleMonth(monthKey)} className="w-full flex items-center justify-between px-3 py-2.5">
              <span className="flex items-center gap-1.5">
                {expanded ? <ChevronUp size={14} className="text-[var(--color-ink-muted)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-muted)]" />}
                <span className="text-xs font-semibold text-[var(--color-ink)]">{formatMonthYear(`${monthKey}-01`)}</span>
                <span className="text-xs text-[var(--color-ink-faint)]">· {monthItems.length}</span>
              </span>
            </button>
            {expanded && (
              <div className="px-2 pb-2 flex flex-col gap-2">
                {monthItems.map((item) => (
                  <div key={keyOf(item)}>{renderRow(item)}</div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {pending.length === 0 && cleared.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">{emptyMessage}</p>}
    </div>
  )
}

/**
 * Shared amount/date/note editor for Savings and Joint entries — neither
 * has a category picker or a real payment-method choice (both are always
 * forced onto a fixed category, and always bank_transfer — see
 * logSavingsDeposit/logJointDeposit's own comments in LedgerContext.tsx),
 * so this is deliberately lighter than EditEntryForm below, which handles
 * the full ad-hoc expense/income shape.
 */
function EditSimpleTransactionForm({
  transaction,
  extraFields,
  onSave,
  onCancel,
}: {
  transaction: Transaction
  // Rendered above amount/date — e.g. the pot/person picker
  // SavingsTransactionRowItem/JointTransactionRowItem pass in below.
  // That picker's own selected value lives in the CALLER's state (not
  // here), and gets folded into `onSave`'s closure there — this form
  // stays scoped to amount/date/note either way.
  extraFields?: React.ReactNode
  onSave: (updates: Partial<Pick<Transaction, 'amount' | 'date' | 'note'>>) => void
  onCancel: () => void
}) {
  const [amount, setAmount] = useState(String(transaction.amount))
  const [date, setDate] = useState(transaction.date)
  const [note, setNote] = useState(transaction.note ?? '')

  const amountNumber = Number(amount)
  const canSave = amountNumber > 0 && !!date
  // UAT follow-up (2026-09-05, Adam-reported): dims Save when nothing's
  // actually changed — this form is shared by the Transfer pill's own
  // edit row as well as any other simple amount/date/note entity, so
  // this one fix covers both "transaction" and "transfer" edit rows.
  const dirty = amountNumber !== transaction.amount || date !== transaction.date || note.trim() !== (transaction.note ?? '')

  return (
    <div className="p-3 pt-0 flex flex-col gap-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      {extraFields}
      {transaction.sourceType === 'salary_sort' && (
        <p className="text-xs text-[var(--color-ink-faint)] -mt-1">Changing the amount updates the salary sort too. Changing the date detaches this from the sort.</p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <EditField label="Note (optional)" type="text" value={note} onChange={setNote} />
      <FormButtonRow onCancel={onCancel} onSave={() => onSave({ amount: amountNumber, date, note: note.trim() || undefined })} saveDisabled={!canSave || !dirty} />
    </div>
  )
}

export function Expenses() {
  const {
    data,
    addAdHocTransaction,
    updateTransaction,
    logCreditCardSpend,
    removeTransaction,
    addCategory,
    addRecurringTemplate,
    updateRecurringTemplate,
    removeRecurringTemplate,
    updateSavingsPot,
    updatePot,
    logTransfer,
    addRecurringTransfer,
  } = useLedgerData()
  const [mode, setMode] = useState<PageMode>('transactions')
  const [adding, setAdding] = useState(false)

  // Entries this page owns: things logged directly here, as opposed to
  // generated bill/loan/credit-card-payment/recurring-transaction
  // instances (doc Section 4.1 — recurring templates/loans/cards are
  // generators, not logged by hand). A materialized recurring-transaction
  // occurrence carries type 'expense'/'income' same as a hand-logged one,
  // so `sourceType` is what tells the two apart here — same test
  // credit_card_spend already used for its own generated/logged split.
  const adHocTransactions = data.transactions
    .filter((t) => ((t.type === 'expense' || t.type === 'income') && !t.sourceType) || t.type === 'bonus' || (t.type === 'credit_card_spend' && !t.sourceType))
    .slice()
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))

  const recurringTransactions = data.recurringTemplates
    .filter((t) => t.kind === 'transaction')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  // ── Transfer (2026-09-04 session) — replaces the Savings/Joint/Pots
  // pills entirely (Adam-specified: "remove Savings/Joint/Pots pills
  // entirely"). One-off hand-logged transfers, same !sourceType
  // convention as adHocTransactions above (a generated recurring
  // occurrence carries sourceType: 'recurring_template') — PLUS
  // sourceType: 'salary_sort' rows (UAT Batch 4, 2026-09-04 fix): those
  // are real, independently-editable transfers too (per spec, "I can
  // edit them here and they will update in the salary sort, and vice
  // versa" — LedgerContext.tsx's updateTransaction/removeTransaction
  // already handle the sync), just created by the Salary Sort modal
  // instead of typed in here. Excluding them left TransferRowItem's own
  // sourceType === 'salary_sort' coral-arrow special-casing below
  // permanently unreachable.
  const transferTransactions = data.transactions
    .filter((t) => t.type === 'transfer' && (!t.sourceType || t.sourceType === 'salary_sort'))
    .slice()
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))

  // Recurring transfers — shown INSIDE the Transfer pill (not the generic
  // Recurring pill), regardless of whether they were created here or
  // from an entity's own Wallet-page card ("single clean consistent
  // method to create them throughout", Adam-specified 2026-09-04) —
  // both write the exact same RecurringTemplate.
  const recurringTransfers = data.recurringTemplates
    .filter((t) => t.kind === 'transfer')
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  // The Transfer pill only appears once there's somewhere to transfer TO
  // — a savings pot, the joint account, or a pot — same "invisible until
  // it would do something" rule the old Savings/Joint/Pots pills used
  // individually.
  const pageModes: PageMode[] = ['transactions', 'recurring', ...(data.savingsPots.length > 0 || data.jointAccount || data.pots.length > 0 ? (['transfer'] as const) : [])]
  const modeLabel: Record<PageMode, string> = { transactions: 'Transactions', recurring: 'Recurring', transfer: 'Transfers' }

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Transactions</h1>
        <button
          onClick={() => setAdding(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center"
          style={{ background: 'var(--color-coral)' }}
        >
          <Plus size={18} className="text-white" />
        </button>
      </header>

      <div className="flex gap-2 mb-4">
        {pageModes.map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m)
              setAdding(false)
            }}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{ background: mode === m ? 'var(--color-coral)' : 'var(--color-surface)', color: mode === m ? '#fff' : 'var(--color-ink-muted)' }}
          >
            {modeLabel[m]}
          </button>
        ))}
      </div>

      {mode === 'transactions' ? (
        <>
          {adding && (
            <ExpenseForm
              onCancel={() => setAdding(false)}
              onSave={(entry) => {
                if (entry.type === 'expense' && entry.paymentMethod === 'card' && entry.creditCardId) {
                  logCreditCardSpend(entry.creditCardId, entry.amount, entry.date, entry.note || undefined)
                } else {
                  addAdHocTransaction({
                    type: entry.type,
                    amount: entry.amount,
                    date: entry.date,
                    categoryId: entry.categoryId,
                    paymentMethod: entry.paymentMethod,
                    personId: entry.personId,
                    note: entry.note || undefined,
                  })
                }
                setAdding(false)
              }}
              onAddCategory={addCategory}
              data={data}
            />
          )}

          <MonthCollapsedTransactionList
            items={adHocTransactions}
            getDate={(t) => t.date}
            isCleared={(t) => t.status === 'cleared'}
            keyOf={(t) => t.id}
            emptyMessage="No ad-hoc entries yet. Log an expense or some income to get started."
            renderRow={(t) => (
              <AdHocTransactionRow
                t={t}
                data={data}
                onAddCategory={addCategory}
                onUpdate={(updates) => updateTransaction(t.id, updates)}
                onRemove={() => removeTransaction(t.id)}
              />
            )}
          />
        </>
      ) : mode === 'recurring' ? (
        <>
          {adding && (
            <RecurringTransactionForm
              categories={visibleCategoriesFor(data)}
              defaultPersonId={data.primaryPersonId}
              onAddCategory={addCategory}
              onCancel={() => setAdding(false)}
              onSave={(template) => {
                addRecurringTemplate(template)
                setAdding(false)
              }}
            />
          )}

          <div className="flex flex-col gap-2">
            {recurringTransactions.map((template) => (
              <RecurringTransactionRow
                key={template.id}
                template={template}
                categories={visibleCategoriesFor(data, template.categoryId)}
                onAddCategory={addCategory}
                onUpdate={(u) => updateRecurringTemplate(template.id, u)}
                onRemove={() => removeRecurringTemplate(template.id)}
              />
            ))}
            {/* Phase 5 (2026-09 session) — a pot with a recurring deposit
                configured shows here too, whether it was set up from THIS
                pill or from the Wallet page's own "+ Add a recurring
                deposit" button (same underlying SavingsPot fields either
                way — see RecurringTransactionForm's onSaveSavingsRecurring
                comment). */}
            {data.savingsPots
              .filter((p) => p.recurringDepositAmount)
              .map((pot) => (
                <SavingsRecurringDepositRow
                  key={pot.id}
                  pot={pot}
                  onSave={(updates) => updateSavingsPot(pot.id, updates)}
                />
              ))}
            {/* Pots backlog item (2026-09 session) — same treatment as
                SavingsPot immediately above: a pot's recurring deposit
                shows here regardless of whether it was set up from THIS
                pill or the Wallet page's own "+ Add a recurring deposit"
                button (same underlying Pot fields either way). */}
            {data.pots
              .filter((p) => p.recurringDepositAmount)
              .map((pot) => (
                <PotRecurringDepositRow key={pot.id} pot={pot} onSave={(updates) => updatePot(pot.id, updates)} />
              ))}
            {recurringTransactions.length === 0 && !data.savingsPots.some((p) => p.recurringDepositAmount) && !data.pots.some((p) => p.recurringDepositAmount) && !adding && (
              <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">
                No recurring transactions yet. Add a recurring income or expense to have it show up automatically in the Summary ledger.
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          {adding && (
            <TransferForm
              data={data}
              onCancel={() => setAdding(false)}
              onSaveOneOff={(from, to, amount, date, note) => {
                logTransfer(from, to, amount, date, note)
                setAdding(false)
              }}
              onSaveRecurring={(template) => {
                addRecurringTransfer(template)
                setAdding(false)
              }}
            />
          )}

          <div className="flex flex-col gap-2">
            {recurringTransfers.map((template) => (
              <TransferRecurringRow
                key={template.id}
                template={template}
                savingsPots={data.savingsPots}
                pots={data.pots}
                onUpdate={(u) => updateRecurringTemplate(template.id, u)}
                onRemove={() => removeRecurringTemplate(template.id)}
              />
            ))}

            <MonthCollapsedTransactionList
              items={transferTransactions}
              getDate={(t) => t.date}
              isCleared={(t) => t.status === 'cleared'}
              keyOf={(t) => t.id}
              emptyMessage={recurringTransfers.length === 0 ? 'No transfers logged yet.' : ''}
              renderRow={(t) => (
                <TransferRowItem
                  t={t}
                  savingsPots={data.savingsPots}
                  pots={data.pots}
                  onUpdate={(u) => updateTransaction(t.id, u)}
                  onRemove={() => removeTransaction(t.id)}
                />
              )}
            />
          </div>
        </>
      )}
    </div>
  )
}

// ── Ad-hoc transaction row — swipe to delete, tap to expand/edit (same
// interaction pattern RecurringTransactionRow already uses below, and now
// Savings/Joint too — see SavingsTransactionRowItem/JointTransactionRowItem). ──
function AdHocTransactionRow({
  t,
  data,
  onAddCategory,
  onUpdate,
  onRemove,
}: {
  t: Transaction
  data: ReturnType<typeof useLedgerData>['data']
  onAddCategory: (name: string) => { id: string }
  onUpdate: (updates: Partial<Omit<Transaction, 'id'>>) => void
  onRemove: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const category = data.categories.find((c) => c.id === t.categoryId)
  const card = t.creditCardId ? data.creditCards.find((c) => c.id === t.creditCardId) : undefined
  const isPositive = t.direction === 'in'

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={t.note || category?.name || 'this entry'}>
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
        <button onClick={() => setIsEditing((e) => !e)} className="w-full flex items-center gap-3 p-3 text-left">
          <CategoryIcon category={category} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-ink)] truncate">
              {t.note || category?.name || (t.type === 'bonus' ? 'Bonus' : t.type === 'income' ? 'Income' : 'Expense')}
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {t.date} · {PAYMENT_METHOD_LABELS[t.paymentMethod]}
              {card ? ` · ${card.name}` : ''}
              {t.status === 'pending' ? ' · Pending' : ''}
            </p>
          </div>
          <p className="text-sm font-mono font-semibold shrink-0" style={{ color: isPositive ? 'var(--color-positive)' : 'var(--color-negative)' }}>
            {isPositive ? '+' : '-'}£{formatCurrency(t.amount)}
          </p>
        </button>
        {isEditing && (
          <EditEntryForm
            transaction={t}
            data={data}
            onAddCategory={onAddCategory}
            onCancel={() => setIsEditing(false)}
            onSave={(updates) => {
              onUpdate(updates)
              setIsEditing(false)
            }}
          />
        )}
      </div>
    </SwipeToDelete>
  )
}

// ── Editing an existing entry — amount/date/category/payment method/note. Works for any ad-hoc type, including bonus and card spend entries created elsewhere, since a rename/correction shouldn't require re-deriving where the entry came from. ──

function EditEntryForm({
  transaction,
  data,
  onAddCategory,
  onSave,
  onCancel,
}: {
  transaction: Transaction
  data: ReturnType<typeof useLedgerData>['data']
  onAddCategory: (name: string) => { id: string }
  onSave: (updates: Partial<Omit<Transaction, 'id'>>) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(transaction.note ?? '')
  const [amount, setAmount] = useState(String(transaction.amount))
  const [date, setDate] = useState(transaction.date)
  const [categoryId, setCategoryId] = useState(transaction.categoryId)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(transaction.paymentMethod)

  const amountNumber = Number(amount)
  const canSave = name.trim() && amountNumber > 0 && date && categoryId
  // credit_card_spend is always paid by card, by definition — don't offer
  // to change that here (changing the linked card itself isn't supported
  // from this form; delete and re-log against the right card instead).
  const paymentMethodEditable = transaction.type !== 'credit_card_spend'
  // UAT follow-up (2026-09-05, Adam-reported): dims Save when nothing's
  // actually changed, same rule every other edit panel in the app now
  // follows.
  const dirty =
    name.trim() !== (transaction.note ?? '') ||
    amountNumber !== transaction.amount ||
    date !== transaction.date ||
    categoryId !== transaction.categoryId ||
    (paymentMethodEditable && paymentMethod !== transaction.paymentMethod)

  return (
    <div className="p-3 pt-0 flex flex-col gap-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <EditField label="Name" type="text" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <EditField label="Date" type="date" value={date} onChange={setDate} />
      </div>
      <CategoryPicker categories={visibleCategoriesFor(data, transaction.categoryId)} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />
      {paymentMethodEditable && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Payment method</span>
          <div className="flex flex-wrap gap-1.5">
            {EXPENSE_PAYMENT_METHODS.map((pm) => (
              <button
                key={pm}
                onClick={() => setPaymentMethod(pm)}
                className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
                style={{
                  background: paymentMethod === pm ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                  color: paymentMethod === pm ? '#fff' : 'var(--color-ink-muted)',
                }}
              >
                {PAYMENT_METHOD_LABELS[pm]}
              </button>
            ))}
          </div>
        </label>
      )}
      <FormButtonRow
        onCancel={onCancel}
        onSave={() =>
          onSave({
            amount: amountNumber,
            date,
            categoryId,
            paymentMethod: paymentMethodEditable ? paymentMethod : transaction.paymentMethod,
            note: name.trim(),
          })
        }
        saveDisabled={!canSave || !dirty}
      />
    </div>
  )
}

interface ExpenseFormEntry {
  type: EntryType
  amount: number
  date: string
  categoryId: string
  paymentMethod: PaymentMethod
  creditCardId?: string
  personId: string
  note: string
}

function ExpenseForm({
  onCancel,
  onSave,
  onAddCategory,
  data,
}: {
  onCancel: () => void
  onSave: (entry: ExpenseFormEntry) => void
  onAddCategory: (name: string) => { id: string }
  data: ReturnType<typeof useLedgerData>['data']
}) {
  const [type, setType] = useState<EntryType>('expense')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(todayIso())
  const [categoryId, setCategoryId] = useState(visibleCategoriesFor(data)[0]?.id ?? '')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('card')
  const [chargeToCreditCard, setChargeToCreditCard] = useState(false)
  const [creditCardId, setCreditCardId] = useState<string>('')

  const isChargeableToCard = type === 'expense' && paymentMethod === 'card' && chargeToCreditCard && data.creditCards.length > 0
  const amountNumber = Number(amount)
  const canSave = name.trim() && amountNumber > 0 && date && categoryId && (!isChargeableToCard || creditCardId)

  return (
    <div className="mb-6 p-4 rounded-2xl flex flex-col gap-4" style={{ background: 'var(--color-surface)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">New entry</h2>
        <button onClick={onCancel} className="text-[var(--color-ink-muted)]">
          <X size={18} />
        </button>
      </div>

      <div className="flex gap-2">
        {ENTRY_TYPES.map((et) => (
          <button
            key={et.value}
            onClick={() => setType(et.value)}
            className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{
              background: type === et.value ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
              color: type === et.value ? '#fff' : 'var(--color-ink-muted)',
            }}
          >
            {et.label}
          </button>
        ))}
      </div>
      <EditField label="Name" type="text" value={name} onChange={setName} />
      <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
      <EditField label="Date" type="date" value={date} onChange={setDate} />

      <CategoryPicker categories={visibleCategoriesFor(data)} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />

      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Payment method</span>
        <div className="flex flex-wrap gap-1.5">
          {EXPENSE_PAYMENT_METHODS.map((pm) => (
            <button
              key={pm}
              onClick={() => {
                setPaymentMethod(pm)
                setChargeToCreditCard(false)
              }}
              className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
              style={{
                background: paymentMethod === pm && !chargeToCreditCard ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                color: paymentMethod === pm && !chargeToCreditCard ? '#fff' : 'var(--color-ink-muted)',
              }}
            >
              {PAYMENT_METHOD_LABELS[pm]}
            </button>
          ))}
          {type === 'expense' && data.creditCards.length > 0 && (
            <button
              onClick={() => {
                setPaymentMethod('card')
                setChargeToCreditCard(true)
              }}
              className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
              style={{
                background: chargeToCreditCard ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
                color: chargeToCreditCard ? '#fff' : 'var(--color-ink-muted)',
              }}
            >
              Credit Card
            </button>
          )}
        </div>
      </label>

      {isChargeableToCard && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Which card</span>
          <select
            value={creditCardId}
            onChange={(e) => setCreditCardId(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            <option value="" style={{ color: '#000' }}>
              Select a card…
            </option>
            {data.creditCards.map((c) => (
              <option key={c.id} value={c.id} style={{ color: '#000' }}>
                {c.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-[var(--color-ink-faint)]">
            This adds to the card's balance — it won't reduce your cash balance until you pay the card down.
          </span>
        </label>
      )}

      {/* Picker-First Flows (2026-09 session) — "Whose income" removed
          entirely (Adam-specified: "I cannot log transactions on behalf
          of another person"). Income logged here is always yours —
          data.primaryPersonId, hardcoded below. */}
      <FormButtonRow
        onCancel={onCancel}
        onSave={() =>
          onSave({
            type,
            amount: amountNumber,
            date,
            categoryId,
            paymentMethod,
            creditCardId: creditCardId || undefined,
            personId: data.primaryPersonId,
            note: name.trim(),
          })
        }
        saveDisabled={!canSave}
      />
    </div>
  )
}

// ── Transfer (2026-09-04 session, "Salary Sorter & Transfer Pill") ──────
// Replaces the old Savings/Joint/Pots pills entirely (Adam-specified:
// "remove Savings/Joint/Pots pills entirely"). One form covers every
// combination of Current Account / Savings pot / Joint account / Pot on
// EITHER side (2026-09 UAT session: "Transfer form 'From' location made
// editable" — Current Account is no longer pinned to one fixed side; a
// direct Pot ↔ Pot / Pot ↔ Savings / Savings ↔ Joint transfer with no
// personal leg at all is now reachable too — see locationTypeForTransfer
// in transferLedger.ts and autoClear.ts's own dedicated materialization
// pass for how that's kept correct end-to-end).

const TRANSFER_MODES = [
  { value: 'one_off', label: 'One-Off' },
  { value: 'recurring', label: 'Recurring' },
] as const
type TransferMode = (typeof TRANSFER_MODES)[number]['value']

type TransferFormStep = 'amount' | 'from' | 'to' | 'frequency' | 'date' | 'final'

/**
 * UAT Batch 4 (2026-09-04, items 2/7): rebuilt from one flat card (mode
 * toggle + From/To dropdowns + inline fields all at once) into Adam's
 * picker-wizard spec — Amount → From → To (the "insert a to location
 * after step 2" Adam specifically called out, since neither side is
 * fixed here the way a Wallet-page pot/savings-pot/joint card's own
 * wizard has one side implied) → for Recurring, Frequency (→ weeks, if
 * every-N-weeks) → Date (skipped if the frequency choice was "follow
 * payday"/"follow my budgeting cycle") → a final Name(recurring)/Note/
 * Save screen. All the existing business logic (reverse Salary Sort
 * conflict guard, draft-template occurrence scanning) is unchanged,
 * just re-triggered from the final step instead of one flat form.
 */
function TransferForm({
  data,
  onCancel,
  onSaveOneOff,
  onSaveRecurring,
}: {
  data: AppDataV2
  onCancel: () => void
  onSaveOneOff: (from: TransferLocation, to: TransferLocation, amount: number, date: string, note?: string) => void
  onSaveRecurring: (
    template: Omit<RecurringTemplate, 'id' | 'active' | 'kind' | 'categoryId' | 'paymentMethod' | 'location' | 'ownerId' | 'payee' | 'payeeSharePercent'>,
  ) => void
}) {
  const { savingsPots, pots, jointAccount, primaryPersonId } = data
  const options = buildTransferLocationOptions(savingsPots, pots, !!jointAccount, primaryPersonId)
  const payCycle = data.payCycles.find((pc) => pc.personId === primaryPersonId)

  const [step, setStep] = useState<TransferFormStep>('amount')
  const [mode, setMode] = useState<TransferMode>('one_off')
  const [amount, setAmount] = useState('')
  const [fromOption, setFromOption] = useState<TransferLocationOption | null>(null)
  const [toOption, setToOption] = useState<TransferLocationOption | null>(null)
  const [freqChoice, setFreqChoice] = useState<TransferFrequencyChoice | null>(null)
  const [intervalWeeks, setIntervalWeeks] = useState(4)
  const [date, setDate] = useState(todayIso())
  const [note, setNote] = useState('')
  const [name, setName] = useState('')
  // Reverse Salary Sort guard (2026-09 session) — set when Save finds this
  // new transfer would land on the same destination as one or more
  // already-saved salary sorts. Deferred here rather than acted on
  // immediately so the actual save only happens once the person picks
  // Go ahead / Skip (one-off) or Go ahead / Cancel (recurring, per
  // Adam's "rename to cancel — no recurring transfer gets created at
  // all" call).
  const [pendingConflicts, setPendingConflicts] = useState<{ conflicts: { payDate: string; amount: number }[]; isRecurring: boolean } | null>(null)

  const amountNumber = Number(amount)

  // Current Account + exactly one other destination is the floor — with
  // nothing to transfer to/from beyond personal, there's nowhere to go.
  if (options.length < 2) {
    return (
      <div className="mb-6 p-4 rounded-2xl flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New transfer</h2>
          <button onClick={onCancel} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-[var(--color-ink-faint)]">Add a savings pot, a pot, or a joint account first — there's nowhere to transfer to yet.</p>
      </div>
    )
  }

  function reset() {
    setStep('amount')
    setMode('one_off')
    setAmount('')
    setFromOption(null)
    setToOption(null)
    setFreqChoice(null)
    setIntervalWeeks(4)
    setDate(todayIso())
    setNote('')
    setName('')
    setPendingConflicts(null)
    onCancel()
  }

  function commitSave() {
    if (!fromOption || !toOption || !freqChoice) return
    const from = fromOption.location
    const to = toOption.location
    if (mode === 'one_off') {
      onSaveOneOff(from, to, amountNumber, date, note.trim() || undefined)
    } else {
      const resolved = resolveTransferFrequencyChoice(freqChoice)
      onSaveRecurring({
        name: name.trim(),
        amount: amountNumber,
        frequency: resolved.frequency,
        intervalWeeks: resolved.frequency === 'every_n_weeks' ? intervalWeeks : undefined,
        anchorDate: date,
        transferFrom: from,
        transferTo: to,
        followsPayday: resolved.followsPayday,
        followsCycleStart: resolved.followsCycleStart,
      })
    }
    reset()
  }

  function handleSave() {
    if (!fromOption || !toOption) return
    // The reverse Salary Sort guard only makes sense when Current
    // Account is the SOURCE (a deposit out of it) — a sort only ever
    // moves money that same direction, never the reverse, and never
    // touches a transfer with no personal leg at all. Same
    // exact-location-match rule as the sort's own guard (locationsEqual,
    // no amount check).
    if (fromOption.location.type !== 'personal') {
      commitSave()
      return
    }
    if (mode === 'one_off') {
      const conflicts = findSalarySortConflicts(data, toOption.location, [date])
      if (conflicts.length > 0) {
        setPendingConflicts({ conflicts, isRecurring: false })
        return
      }
    } else {
      if (!freqChoice) return
      const resolved = resolveTransferFrequencyChoice(freqChoice)
      // Scan this payday-like date plus the next 3 resolved occurrences
      // (Adam's explicit 2026-09 call) — resolved via the exact same
      // generation path the recurring template will actually use once
      // saved, so followsPayday/followsCycleStart/frequency are all
      // honoured rather than guessed at.
      const draftTemplate: RecurringTemplate = {
        id: 'draft',
        name: name.trim() || 'Transfer',
        amount: amountNumber,
        categoryId: '',
        paymentMethod: 'bank_transfer',
        frequency: resolved.frequency,
        intervalWeeks: resolved.frequency === 'every_n_weeks' ? intervalWeeks : undefined,
        anchorDate: date,
        location: 'personal',
        ownerId: primaryPersonId,
        payee: '',
        payeeSharePercent: 100,
        active: true,
        kind: 'transfer',
        transferFrom: fromOption.location,
        transferTo: toOption.location,
        followsPayday: resolved.followsPayday,
        followsCycleStart: resolved.followsCycleStart,
      }
      const occurrenceDates = generateTransactionsForTemplate(draftTemplate, new Date(), addYears(new Date(), 2), payCycle)
        .map((o) => o.date)
        .slice(0, 4)
      const conflicts = findSalarySortConflicts(data, toOption.location, occurrenceDates)
      if (conflicts.length > 0) {
        setPendingConflicts({ conflicts, isRecurring: true })
        return
      }
    }
    commitSave()
  }

  if (step === 'amount') {
    return (
      <div className="mb-6 p-4 rounded-2xl flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">New transfer</h2>
          <button onClick={reset} className="text-[var(--color-ink-muted)]">
            <X size={18} />
          </button>
        </div>
        <div className="flex gap-2">
          {TRANSFER_MODES.map((tm) => (
            <button
              key={tm.value}
              onClick={() => setMode(tm.value)}
              className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
              style={{ background: mode === tm.value ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: mode === tm.value ? '#fff' : 'var(--color-ink-muted)' }}
            >
              {tm.label}
            </button>
          ))}
        </div>
        <EditField key="transfer-amount" label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <FormButtonRow onCancel={reset} onSave={() => setStep('from')} saveLabel="Continue" saveDisabled={!(amountNumber > 0)} />
      </div>
    )
  }

  if (step === 'from') {
    return (
      <LocationStep
        title="From"
        options={options}
        excludeKey={toOption?.key}
        onPick={(o) => {
          setFromOption(o)
          setStep('to')
        }}
        onCancel={reset}
      />
    )
  }

  if (step === 'to') {
    return (
      <LocationStep
        title="To"
        options={options}
        excludeKey={fromOption?.key}
        onPick={(o) => {
          setToOption(o)
          setStep(mode === 'recurring' ? 'frequency' : 'final')
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
        onContinue={() => setStep(freqChoice === 'follows_payday' || freqChoice === 'follows_cycle_start' ? 'final' : 'date')}
      />
    )
  }

  if (step === 'date') {
    return <DateStep value={date} onChange={setDate} onCancel={reset} onContinue={() => setStep('final')} />
  }

  // final — Name (recurring only) + Note + Save, same trailing fields/
  // helper text/conflict-guard the old flat form always had.
  return (
    <div className="mb-6 p-4 rounded-2xl flex flex-col gap-4" style={{ background: 'var(--color-surface)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">New transfer</h2>
        <button onClick={reset} className="text-[var(--color-ink-muted)]">
          <X size={18} />
        </button>
      </div>

      {mode === 'recurring' && <EditField key="transfer-name" label="Name" type="text" value={name} onChange={setName} />}
      <EditField key="transfer-note" label="Note (optional)" type="text" value={note} onChange={setNote} />

      <p className="text-xs text-[var(--color-ink-faint)]">
        Moves money OUT of {fromOption?.label ?? 'the source'} and INTO {toOption?.label ?? 'the destination'}
        {toOption?.location.type === 'personal' ? ', shown as income' : ''}.
      </p>

      <FormButtonRow onCancel={reset} onSave={handleSave} saveDisabled={mode === 'recurring' && !name.trim()} />

      {pendingConflicts && (
        <ConfirmModal
          title="Already sorted"
          description={
            `${toOption?.label ?? 'This destination'} already has a salary sort covering ` +
            pendingConflicts.conflicts.map((c) => `${c.payDate} (£${c.amount.toFixed(2)})`).join(', ') +
            (pendingConflicts.isRecurring
              ? '. Go ahead and create this recurring transfer alongside it, or cancel — no transfer will be created.'
              : '. Go ahead and create this transfer alongside it, or skip — nothing will be created.')
          }
          confirmLabel="Go ahead"
          cancelLabel={pendingConflicts.isRecurring ? 'Cancel' : 'Skip'}
          onConfirm={() => {
            setPendingConflicts(null)
            commitSave()
          }}
          onCancel={() => setPendingConflicts(null)}
        />
      )}
    </div>
  )
}

/** Transfer row — swipe to delete, tap to expand/edit. Mirrors the old SavingsTransactionRowItem/JointTransactionRowItem/PotTransactionRowItem shape, generalised across all three "other side" kinds. */
function TransferRowItem({
  t,
  savingsPots,
  pots,
  onUpdate,
  onRemove,
}: {
  t: Transaction
  savingsPots: SavingsPot[]
  pots: Pot[]
  onUpdate: (updates: Partial<Pick<Transaction, 'amount' | 'date' | 'note'>>) => void
  onRemove: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const touchesPersonal = t.fromLocation?.type === 'personal' || t.toLocation?.type === 'personal'
  const isWithdrawal = t.toLocation?.type === 'personal'
  const otherLocation = isWithdrawal ? t.fromLocation : t.toLocation
  const otherLabel = transferLocationLabel(otherLocation, savingsPots, pots)
  // A direct transfer with no personal leg at all (Pot ↔ Pot, etc., 2026-09
  // UAT session) doesn't fit "Deposit"/"Withdrawal" — neither side is MY
  // personal balance — so it shows both endpoints instead, and its amount
  // is shown plain (not +/- green/red) since it doesn't affect personal
  // cash either way.
  const fromLabel = transferLocationLabel(t.fromLocation, savingsPots, pots)
  const toLabel = transferLocationLabel(t.toLocation, savingsPots, pots)

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={touchesPersonal ? otherLabel : `${fromLabel} → ${toLabel}`}>
      <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
        <button onClick={() => setIsEditing((e) => !e)} className="w-full flex items-center justify-between p-3 text-left">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--color-ink)] truncate flex items-center gap-1">
              {t.sourceType === 'salary_sort' ? (
                <>
                  <ArrowRight size={13} className="text-[var(--color-coral)] shrink-0" />
                  Salary Sort · {otherLabel}
                </>
              ) : touchesPersonal ? (
                <>
                  {isWithdrawal ? 'Withdrawal' : 'Deposit'} · {otherLabel}
                </>
              ) : (
                <>
                  {fromLabel} → {toLabel}
                </>
              )}
            </p>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {t.date}
              {t.status === 'pending' ? ' · Pending' : ''}
            </p>
          </div>
          <p className="text-sm font-mono font-semibold shrink-0" style={{ color: touchesPersonal ? (isWithdrawal ? 'var(--color-positive)' : 'var(--color-ink)') : 'var(--color-ink)' }}>
            {touchesPersonal ? (isWithdrawal ? '+' : '-') : ''}£{formatCurrency(t.amount)}
          </p>
        </button>
        {isEditing && (
          <EditSimpleTransactionForm
            transaction={t}
            onCancel={() => setIsEditing(false)}
            onSave={(updates) => {
              onUpdate(updates)
              setIsEditing(false)
            }}
          />
        )}
      </div>
    </SwipeToDelete>
  )
}

/**
 * A recurring transfer's row in the Transfer pill — same tap-to-expand/
 * pause pattern as SavingsRecurringDepositRow below, simplified since a
 * transfer has no category/payee/split fields to edit, just amount,
 * frequency, follows-payday, and the pause checklist (reusing schedule.ts's
 * setPausedTemplateOccurrences/scheduledTemplateDates/templateOccurrencePreviews
 * — the exact same mechanism a bill/recurring-transaction template
 * already uses, via the shared PausedOccurrencesControl widget).
 */
function TransferRecurringRow({
  template,
  savingsPots,
  pots,
  onUpdate,
  onRemove,
}: {
  template: RecurringTemplate
  savingsPots: SavingsPot[]
  pots: Pot[]
  onUpdate: (updates: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(String(template.amount))

  const touchesPersonal = template.transferFrom?.type === 'personal' || template.transferTo?.type === 'personal'
  const isWithdrawal = template.transferTo?.type === 'personal'
  const fromLabel = transferLocationLabel(template.transferFrom, savingsPots, pots)
  const toLabel = transferLocationLabel(template.transferTo, savingsPots, pots)

  const windowDates = scheduledTemplateDates(template, new Date(), addYearsLocal(new Date(), 1))
  const currentlyPaused = new Set((template.occurrenceOverrides ?? []).filter((o) => o.deleted && windowDates.includes(o.originalDate)).map((o) => o.originalDate))
  const nextOccurrence = templateOccurrencePreviews(template, new Date(), 1)[0]

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={template.name}>
      <div className="relative rounded-2xl px-4 py-3" style={{ background: 'var(--color-surface)' }}>
        <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
          <div className="min-w-0">
            <p className="font-body text-sm text-[var(--color-ink)] truncate">
              {touchesPersonal ? `${fromLabel} · ${isWithdrawal ? 'Withdrawal' : 'Deposit'} · ${toLabel}` : `${fromLabel} → ${toLabel}`}
            </p>
            <p className="text-xs text-[var(--color-ink-faint)]">
              {RECURRING_FREQUENCY_LABELS[template.frequency as RecurringFrequency] ?? template.frequency}
              {template.followsPayday ? ' · Follows payday' : ''}
              {template.followsCycleStart ? ' · Follows cycle start' : ''}
              {nextOccurrence ? ` · Next ${nextOccurrence.date}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <span className="font-mono text-sm text-[var(--color-ink)]">{touchesPersonal ? (isWithdrawal ? '+' : '-') : ''}£{formatCurrency(template.amount)}</span>
            {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
          </div>
        </button>
        {open && (
          <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--color-track)' }}>
            <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
            <button
              onClick={() => {
                const amountNumber = Number(amount)
                if (amountNumber > 0) onUpdate({ amount: amountNumber })
              }}
              className="text-xs self-start disabled:opacity-40"
              style={{ color: 'var(--color-coral)' }}
              disabled={!(Number(amount) > 0) || Number(amount) === template.amount}
            >
              Save amount
            </button>
            <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
              <input
                type="checkbox"
                checked={!!template.followsPayday}
                onChange={(e) => onUpdate({ followsPayday: e.target.checked, followsCycleStart: e.target.checked ? false : template.followsCycleStart })}
              />
              Land on payday, even if it moves
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
              <input
                type="checkbox"
                checked={!!template.followsCycleStart}
                onChange={(e) => onUpdate({ followsCycleStart: e.target.checked, followsPayday: e.target.checked ? false : template.followsPayday })}
              />
              Land on the start of my budgeting cycle instead
            </label>
            <PausedOccurrencesControl
              windowDates={windowDates}
              currentlyPaused={currentlyPaused}
              amountForDate={() => template.amount}
              itemLabel="transfers"
              nextPaymentPreview={(tentative) => {
                const previewTemplate: RecurringTemplate = { ...template, ...setPausedTemplateOccurrences(template, windowDates, tentative) }
                return templateOccurrencePreviews(previewTemplate, new Date(), 1)[0]?.date ?? null
              }}
              onSave={(pausedDates) => onUpdate(setPausedTemplateOccurrences(template, windowDates, pausedDates))}
            />
          </div>
        )}
      </div>
    </SwipeToDelete>
  )
}

function addYearsLocal(date: Date, years: number): Date {
  const d = new Date(date)
  d.setFullYear(d.getFullYear() + years)
  return d
}


// ── Recurring transactions — same schedule engine as Bills (RecurringTemplate with kind: 'transaction'), but generating plain expense/income occurrences, personal-only, with per-occurrence edit/delete on top of the standing "apply from" amount-change flow Bills already has. ──

function RecurringPaymentMethodEditor({ value, onChange }: { value: PaymentMethod; onChange: (v: PaymentMethod) => void }) {
  return (
    <label className="flex flex-col gap-1 col-span-2">
      <span className="text-xs text-[var(--color-ink-muted)]">Payment method</span>
      <div className="flex flex-wrap gap-1.5">
        {EXPENSE_PAYMENT_METHODS.map((pm) => (
          <button
            key={pm}
            onClick={() => onChange(pm)}
            className="px-2.5 py-1 rounded-full text-xs font-medium transition-colors"
            style={{ background: value === pm ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: value === pm ? '#fff' : 'var(--color-ink-muted)' }}
          >
            {PAYMENT_METHOD_LABELS[pm]}
          </button>
        ))}
      </div>
    </label>
  )
}

function RecurringFrequencyEditor({
  frequency,
  intervalWeeks,
  anchorDate,
  onChange,
}: {
  frequency: RecurringFrequency
  intervalWeeks: number | undefined
  anchorDate: string
  onChange: (patch: { frequency?: RecurrenceFrequency; intervalWeeks?: number; anchorDate?: string }) => void
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--color-ink-muted)]">Frequency</span>
        <select
          value={frequency}
          onChange={(e) => onChange({ frequency: e.target.value as RecurrenceFrequency })}
          className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
        >
          {(Object.keys(RECURRING_FREQUENCY_LABELS) as RecurringFrequency[]).map((f) => (
            <option key={f} value={f} style={{ color: '#000' }}>
              {RECURRING_FREQUENCY_LABELS[f]}
            </option>
          ))}
        </select>
      </label>
      {frequency === 'every_n_weeks' ? (
        <EditField label="Every N weeks" type="number" value={intervalWeeks ?? 2} onChange={(v) => onChange({ intervalWeeks: Math.max(1, Number(v)) })} />
      ) : (
        <EditField
          label={frequency === 'weekly' ? 'First date' : 'Due date (sets the day/month)'}
          type="date"
          value={anchorDate}
          onChange={(v) => onChange({ anchorDate: v })}
        />
      )}
      {frequency === 'every_n_weeks' && <EditField label="First date" type="date" value={anchorDate} onChange={(v) => onChange({ anchorDate: v })} />}
    </>
  )
}

function RecurringTransactionForm({
  categories,
  defaultPersonId,
  onAddCategory,
  onSave,
  onCancel,
}: {
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  defaultPersonId: string
  onAddCategory: (name: string) => { id: string }
  onSave: (template: Omit<RecurringTemplate, 'id' | 'active'>) => void
  onCancel: () => void
}) {
  const [type, setType] = useState<EntryType>('expense')
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [frequency, setFrequency] = useState<RecurringFrequency>('monthly')
  const [intervalWeeks, setIntervalWeeks] = useState(2)
  const [anchorDate, setAnchorDate] = useState(todayIso())
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('card')

  const canSave = name.trim() && Number(amount) > 0 && anchorDate && categoryId

  return (
    <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: 'var(--color-surface)' }}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">New recurring transaction</h2>
        <button onClick={onCancel} className="text-[var(--color-ink-muted)]">
          <X size={18} />
        </button>
      </div>

      <div className="flex gap-2">
        {ENTRY_TYPES.map((et) => (
          <button
            key={et.value}
            onClick={() => setType(et.value)}
            className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{ background: type === et.value ? 'var(--color-coral)' : 'var(--color-bg-elevated)', color: type === et.value ? '#fff' : 'var(--color-ink-muted)' }}
          >
            {et.label}
          </button>
        ))}
      </div>

      <EditField label="Name" type="text" value={name} onChange={setName} />
      <div className="grid grid-cols-2 gap-3">
        <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Frequency</span>
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {(Object.keys(RECURRING_FREQUENCY_LABELS) as RecurringFrequency[]).map((f) => (
              <option key={f} value={f} style={{ color: '#000' }}>
                {RECURRING_FREQUENCY_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
        {frequency === 'every_n_weeks' && <EditField label="Every N weeks" type="number" value={intervalWeeks} onChange={(v) => setIntervalWeeks(Math.max(1, Number(v)))} />}
        <EditField label={frequency === 'weekly' || frequency === 'every_n_weeks' ? 'First date' : 'Due date'} type="date" value={anchorDate} onChange={setAnchorDate} />
      </div>

      <CategoryPicker categories={categories} value={categoryId} onChange={setCategoryId} onAddCategory={onAddCategory} />

      <RecurringPaymentMethodEditor value={paymentMethod} onChange={setPaymentMethod} />

      {/* Picker-First Flows (2026-09 session) — "Whose income"
          removed entirely; ownerId/personId below are always
          defaultPersonId (your primary person), never chosen here. */}

      <div className="flex gap-2 mt-1">
        <CancelButton onClick={onCancel} />
        <SaveButton
          disabled={!canSave}
          onClick={() =>
            onSave({
              name: name.trim(),
              amount: Number(amount),
              categoryId,
              paymentMethod,
              frequency,
              intervalWeeks: frequency === 'every_n_weeks' ? intervalWeeks : undefined,
              anchorDate,
              location: 'personal',
              payee: '',
              payeeSharePercent: 100,
              ownerId: defaultPersonId,
              kind: 'transaction',
              recurringTransactionType: type,
              personId: type === 'income' ? defaultPersonId : undefined,
            })
          }
          label="Add recurring"
        />
      </div>
    </div>
  )
}

/**
 * "Which payment should this apply from?" — the recurring-transaction
 * counterpart to Bills.tsx's BillEffectiveDateModal, shown only when the
 * STANDING amount has genuinely changed and there's at least one real
 * occurrence (past or upcoming) to anchor the choice to. Deliberately the
 * same portal/nav-padding pattern for the same reason (see that
 * component's own comment) — this modal sits inside a swipeable row's
 * tree too.
 */
function RecurringEffectiveDateModal({
  template,
  newAmount,
  onCancel,
  onChoose,
}: {
  template: RecurringTemplate
  newAmount: number
  onCancel: () => void
  onChoose: (effectiveFrom: string) => void
}) {
  const occurrences = recentAndUpcomingOccurrences(template, new Date())

  return createPortal(
    <div className="fixed inset-0 z-[500] flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-t-3xl p-5"
        style={{ background: 'var(--color-surface)', paddingBottom: 'calc(var(--nav-h) + var(--safe-bottom) + 20px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-base font-semibold text-[var(--color-ink)] mb-1">Apply this change from…</h3>
        <p className="text-sm text-[var(--color-ink-muted)] mb-4">
          {template.name} is changing from £{formatCurrency(template.amount)} to £{formatCurrency(newAmount)}. Which payment should the new amount start from? Everything before it
          keeps the old amount.
        </p>
        <div className="flex flex-col gap-2">
          {occurrences.map((o) => (
            <button
              key={o.date}
              onClick={() => onChoose(o.date)}
              className="w-full py-2.5 rounded-full text-sm font-semibold flex items-center justify-center gap-2"
              style={{ background: 'var(--color-bg-elevated)', color: 'var(--color-ink)' }}
            >
              {formatFullDate(o.date)}
              {o.isPast && <span className="text-xs font-normal text-[var(--color-ink-muted)]">(most recent)</span>}
            </button>
          ))}
        </div>
        <button onClick={onCancel} className="w-full py-2 mt-2 text-xs text-[var(--color-ink-muted)]">
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  )
}

type RecurringTxDraft = Omit<RecurringTemplate, 'id'>

function draftFromRecurringTemplate(template: RecurringTemplate): RecurringTxDraft {
  const { id: _id, ...rest } = template
  return rest
}

function RecurringTransactionEditPanel({
  template,
  categories,
  onAddCategory,
  onSave,
  onDelete,
}: {
  template: RecurringTemplate
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<RecurringTxDraft>(() => draftFromRecurringTemplate(template))
  const [choosingEffectiveDate, setChoosingEffectiveDate] = useState(false)
  // UAT follow-up (2026-09-04, Adam-requested app-wide sweep): dims Save
  // when nothing's changed, same as BillEditPanel's own dirty check.
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromRecurringTemplate(template))

  function update(patch: Partial<RecurringTxDraft>) {
    setDraft((d) => ({ ...d, ...patch }))
  }

  function handleSaveClick() {
    // Same gate as Bills.tsx: a genuine STANDING amount change is routed
    // through "which payment should this apply from" — every other field
    // (name, category, frequency, active, etc.) saves immediately.
    if (draft.amount !== template.amount && recentAndUpcomingOccurrences(template, new Date()).length > 0) {
      setChoosingEffectiveDate(true)
      return
    }
    onSave(draft)
  }

  if (choosingEffectiveDate) {
    return (
      <RecurringEffectiveDateModal
        template={template}
        newAmount={draft.amount}
        onCancel={() => setChoosingEffectiveDate(false)}
        onChoose={(effectiveFrom) => {
          onSave({ ...draft, ...applyTemplateAmountChange(template, draft.amount, effectiveFrom) })
          setChoosingEffectiveDate(false)
        }}
      />
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
      <div className="col-span-2 flex gap-2">
        {(['expense', 'income'] as const).map((rt) => (
          <button
            key={rt}
            onClick={() => update({ recurringTransactionType: rt })}
            className="flex-1 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{
              background: draft.recurringTransactionType === rt ? 'var(--color-coral)' : 'var(--color-bg-elevated)',
              color: draft.recurringTransactionType === rt ? '#fff' : 'var(--color-ink-muted)',
            }}
          >
            {rt === 'expense' ? 'Expense' : 'Income'}
          </button>
        ))}
      </div>

      <EditField label="Name" type="text" value={draft.name} onChange={(v) => update({ name: v })} />
      <EditField label="Amount (£)" type="number" value={draft.amount} onChange={(v) => update({ amount: Number(v) })} />
      <RecurringFrequencyEditor frequency={draft.frequency as RecurringFrequency} intervalWeeks={draft.intervalWeeks} anchorDate={draft.anchorDate} onChange={update} />
      <div className="col-span-2">
        <CategoryPicker categories={categories} value={draft.categoryId} onChange={(categoryId) => update({ categoryId })} onAddCategory={onAddCategory} />
      </div>
      <RecurringPaymentMethodEditor value={draft.paymentMethod} onChange={(paymentMethod) => update({ paymentMethod })} />

      {/* Picker-First Flows (2026-09 session) — "Whose income" removed entirely; personId/ownerId stay whatever draftFromRecurringTemplate already carried (always your primary person, set once at creation and never re-chosen here). */}

      <label className="flex items-center gap-2 col-span-2 mt-1">
        <input type="checkbox" checked={draft.active} onChange={(e) => update({ active: e.target.checked })} />
        <span className="text-xs text-[var(--color-ink-muted)]">Active (paused recurring transactions stop generating new entries)</span>
      </label>

      <button onClick={onDelete} className="col-span-2 flex items-center gap-1 text-xs justify-self-start mt-1" style={{ color: 'var(--color-negative)' }}>
        <Trash2 size={13} /> Delete recurring transaction
      </button>

      <button disabled={!dirty} onClick={handleSaveClick} className="col-span-2 w-full py-2.5 rounded-full text-sm font-semibold text-white mt-1 disabled:opacity-40" style={{ background: 'var(--color-coral)' }}>
        Save
      </button>
    </div>
  )
}

/**
 * One row inside the "next 12 upcoming" panel — tap to reveal an
 * amount/date editor for THIS occurrence only (writes an
 * occurrenceOverrides entry keyed by originalDate, overriding the
 * template's frequency-derived date/amount for that single slot), or hit
 * the trash icon to delete/skip it outright. Mirrors Salary.tsx's
 * PayPeriodRow — same "tappable pill, editor revealed below" shape.
 */
function OccurrenceRow({
  occurrence,
  onSaveOverride,
  onDeleteOccurrence,
}: {
  occurrence: RawOccurrence
  onSaveOverride: (amount: number, date: string) => void
  onDeleteOccurrence: () => void
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState(String(occurrence.amount))
  const [date, setDate] = useState(occurrence.date)
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()
  const isAdjusted = occurrence.date !== occurrence.originalDate

  return (
    <div className="relative rounded-xl overflow-hidden" style={{ background: 'var(--color-bg-elevated)' }}>
      <div className="w-full flex items-center gap-2 px-3 py-2.5">
        <button onClick={() => setOpen(!open)} className="flex-1 flex items-center justify-between text-left min-w-0">
          <span className="text-sm text-[var(--color-ink)]">
            {occurrence.date}
            {isAdjusted && <span className="text-xs text-[var(--color-coral)]"> · Adjusted</span>}
          </span>
          <span className="font-mono text-sm text-[var(--color-ink)]">£{formatCurrency(occurrence.amount)}</span>
        </button>
        <span role="button" onClick={onDeleteOccurrence} className="text-[var(--color-ink-faint)] shrink-0">
          <Trash2 size={15} />
        </span>
      </div>
      {open && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
          <div className="grid grid-cols-2 gap-3">
            <EditField label="Amount (£)" type="number" value={amount} onChange={setAmount} />
            <EditField label="Date" type="date" value={date} onChange={setDate} />
          </div>
          <button
            onClick={() => {
              onSaveOverride(Number(amount), date)
              triggerFlash()
              setOpen(false)
            }}
            className="w-full py-2 rounded-full text-xs font-semibold text-white"
            style={{ background: 'var(--color-coral)' }}
          >
            Save this payment
          </button>
        </div>
      )}
      <SavedFlashOverlay active={flashActive} />
    </div>
  )
}

function RecurringTransactionRow({
  template,
  categories,
  onAddCategory,
  onUpdate,
  onRemove,
}: {
  template: RecurringTemplate
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onUpdate: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const category = categories.find((c) => c.id === template.categoryId)
  const { active: flashActive, trigger: triggerFlash } = useSavedFlash()
  const isIncome = template.recurringTransactionType === 'income'

  // Next 12 upcoming occurrences, freshly recomputed on every render so a
  // per-occurrence edit/delete just made is immediately reflected here —
  // there's no separate materialized list to keep in sync with.
  const upcoming = open ? templateOccurrencePreviews(template, new Date(), 12) : []

  function saveOccurrenceOverride(originalDate: string, amount: number, date: string) {
    const next = [...(template.occurrenceOverrides ?? []).filter((o) => o.originalDate !== originalDate), { originalDate, amount, date }]
    onUpdate({ occurrenceOverrides: next })
  }

  function deleteOccurrence(originalDate: string) {
    const next = [...(template.occurrenceOverrides ?? []).filter((o) => o.originalDate !== originalDate), { originalDate, deleted: true }]
    onUpdate({ occurrenceOverrides: next })
  }

  return (
    <SwipeToDelete onDelete={onRemove} confirmLabel={template.name}>
      <div className="relative rounded-xl px-4 py-3" style={{ background: template.active ? 'var(--color-surface)' : 'var(--color-bg-elevated)' }}>
        <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <CategoryIcon category={category} />
            <div className="min-w-0">
              <p className="font-body text-sm" style={{ color: template.active ? 'var(--color-ink)' : 'var(--color-ink-muted)', textDecoration: template.active ? 'none' : 'line-through' }}>
                {template.name}
                {!template.active && <span className="text-[10px] font-normal no-underline"> · Paused</span>}
              </p>
              <p className="text-xs text-[var(--color-ink-faint)]">
                {isIncome ? 'Income' : 'Expense'} · {RECURRING_FREQUENCY_LABELS[(template.frequency as RecurringFrequency) ?? 'monthly']} · {PAYMENT_METHOD_LABELS[template.paymentMethod]}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-0.5">
            <span
              className="font-mono text-sm whitespace-nowrap"
              style={{ color: !template.active ? 'var(--color-ink-muted)' : isIncome ? 'var(--color-positive)' : 'var(--color-ink)', textDecoration: template.active ? 'none' : 'line-through' }}
            >
              {isIncome ? '+' : '-'}£{formatCurrency(template.amount)}
            </span>
            {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
          </div>
        </button>

        {open && (
          <>
            <RecurringTransactionEditPanel
              template={template}
              categories={categories}
              onAddCategory={onAddCategory}
              onSave={(patch) => {
                onUpdate(patch)
                triggerFlash()
              }}
              onDelete={onRemove}
            />

            <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-track)' }}>
              <h4 className="text-xs font-semibold text-[var(--color-ink)] mb-2">Next 12 upcoming</h4>
              <div className="flex flex-col gap-2">
                {upcoming.map((occ) => (
                  <OccurrenceRow
                    key={occ.originalDate}
                    occurrence={occ}
                    onSaveOverride={(amount, date) => saveOccurrenceOverride(occ.originalDate, amount, date)}
                    onDeleteOccurrence={() => deleteOccurrence(occ.originalDate)}
                  />
                ))}
                {upcoming.length === 0 && (
                  <p className="text-xs text-[var(--color-ink-faint)] text-center py-3">
                    No upcoming payments — check the frequency and due date, or whether this recurring transaction is paused.
                  </p>
                )}
              </div>
            </div>
          </>
        )}

        <SavedFlashOverlay active={flashActive} />
      </div>
    </SwipeToDelete>
  )
}

/**
 * Phase 5 (2026-09 session) — the SavingsPot counterpart to
 * RecurringTransactionRow above, shown in the same Recurring pill list.
 * Edits/removes/pauses write straight to SavingsPot.recurringDepositAmount/
 * DayOfMonth/recurringDepositOverrides — the same fields the Wallet
 * page's own RecurringDepositEditor/PausedDepositsControl write to, so a
 * pot set up from either page is fully editable from the other. This row
 * only ever REMOVES the recurring deposit config, never the pot itself —
 * deleting the whole pot stays a Wallet-page-only action, matching how a
 * loan itself can't be deleted from Transactions either.
 */
function SavingsRecurringDepositRow({ pot, onSave }: { pot: SavingsPot; onSave: (updates: Partial<Omit<SavingsPot, 'id' | 'personId'>>) => void }) {
  const [open, setOpen] = useState(false)
  const { start, end } = schedulePreviewWindow(pot, new Date())
  const windowDates = scheduledDepositDates(pot, start, end)
  const currentlyPaused = new Set((pot.recurringDepositOverrides ?? []).filter((o) => o.deleted && windowDates.includes(o.originalDate)).map((o) => o.originalDate))
  const nextDeposit = depositOccurrencePreviews(pot, new Date(), 1)[0]

  return (
    <div className="relative rounded-xl px-4 py-3" style={{ background: 'var(--color-surface)' }}>
      <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <p className="font-body text-sm text-[var(--color-ink)]">{pot.name}</p>
          <p className="text-xs text-[var(--color-ink-faint)]">Savings deposit · monthly, on the {pot.recurringDepositDayOfMonth}{ordinalSuffixLocal(pot.recurringDepositDayOfMonth ?? 1)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <span className="font-mono text-sm text-[var(--color-ink)]">-£{formatCurrency(pot.recurringDepositAmount ?? 0)}</span>
          {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
        </div>
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--color-track)' }}>
          <p className="text-xs text-[var(--color-ink-muted)]">{nextDeposit ? `Next deposit ${nextDeposit.date}` : 'No upcoming deposit'}</p>
          <div className="grid grid-cols-2 gap-2">
            <EditField label="Amount (£)" type="number" value={pot.recurringDepositAmount ?? 0} onChange={(v) => onSave({ recurringDepositAmount: Number(v) || 0 })} />
            <EditField
              label="On day of month"
              type="number"
              value={pot.recurringDepositDayOfMonth ?? 28}
              onChange={(v) => onSave({ recurringDepositDayOfMonth: Math.min(31, Math.max(1, Number(v) || 1)) })}
            />
          </div>
          <button
            onClick={() => onSave({ recurringDepositAmount: undefined, recurringDepositDayOfMonth: undefined, recurringDepositStartDate: undefined })}
            className="text-xs self-start"
            style={{ color: 'var(--color-negative)' }}
          >
            Remove recurring deposit
          </button>
          <PausedOccurrencesControl
            windowDates={windowDates}
            currentlyPaused={currentlyPaused}
            amountForDate={() => pot.recurringDepositAmount ?? 0}
            itemLabel="deposits"
            nextPaymentPreview={(tentative) => {
              const previewPot: SavingsPot = { ...pot, ...setPausedDeposits(pot, windowDates, tentative) }
              return depositOccurrencePreviews(previewPot, new Date(), 1)[0]?.date ?? null
            }}
            onSave={(pausedDates) => onSave(setPausedDeposits(pot, windowDates, pausedDates))}
          />
        </div>
      )}
    </div>
  )
}

function ordinalSuffixLocal(day: number): string {
  if (day % 10 === 1 && day !== 11) return 'st'
  if (day % 10 === 2 && day !== 12) return 'nd'
  if (day % 10 === 3 && day !== 13) return 'rd'
  return 'th'
}

/** Pots backlog item (2026-09 session) — identical shape to SavingsRecurringDepositRow above, against potLedger.ts's equivalents. */
function PotRecurringDepositRow({ pot, onSave }: { pot: Pot; onSave: (updates: Partial<Omit<Pot, 'id' | 'personId'>>) => void }) {
  const [open, setOpen] = useState(false)
  const { start, end } = schedulePotPreviewWindow(pot, new Date())
  const windowDates = scheduledPotDepositDates(pot, start, end)
  const currentlyPaused = new Set((pot.recurringDepositOverrides ?? []).filter((o) => o.deleted && windowDates.includes(o.originalDate)).map((o) => o.originalDate))
  const nextDeposit = potDepositOccurrencePreviews(pot, new Date(), 1)[0]

  return (
    <div className="relative rounded-xl px-4 py-3" style={{ background: 'var(--color-surface)' }}>
      <button className="w-full flex items-start justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <p className="font-body text-sm text-[var(--color-ink)]">{pot.name}</p>
          <p className="text-xs text-[var(--color-ink-faint)]">Pot deposit · monthly, on the {pot.recurringDepositDayOfMonth}{ordinalSuffixLocal(pot.recurringDepositDayOfMonth ?? 1)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 pt-0.5">
          <span className="font-mono text-sm text-[var(--color-ink)]">-£{formatCurrency(pot.recurringDepositAmount ?? 0)}</span>
          {open ? <ChevronUp size={14} className="text-[var(--color-ink-faint)]" /> : <ChevronDown size={14} className="text-[var(--color-ink-faint)]" />}
        </div>
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t flex flex-col gap-2" style={{ borderColor: 'var(--color-track)' }}>
          <p className="text-xs text-[var(--color-ink-muted)]">{nextDeposit ? `Next deposit ${nextDeposit.date}` : 'No upcoming deposit'}</p>
          <div className="grid grid-cols-2 gap-2">
            <EditField label="Amount (£)" type="number" value={pot.recurringDepositAmount ?? 0} onChange={(v) => onSave({ recurringDepositAmount: Number(v) || 0 })} />
            <EditField
              label="On day of month"
              type="number"
              value={pot.recurringDepositDayOfMonth ?? 28}
              onChange={(v) => onSave({ recurringDepositDayOfMonth: Math.min(31, Math.max(1, Number(v) || 1)) })}
            />
          </div>
          <button
            onClick={() => onSave({ recurringDepositAmount: undefined, recurringDepositDayOfMonth: undefined, recurringDepositStartDate: undefined })}
            className="text-xs self-start"
            style={{ color: 'var(--color-negative)' }}
          >
            Remove recurring deposit
          </button>
          <PausedOccurrencesControl
            windowDates={windowDates}
            currentlyPaused={currentlyPaused}
            amountForDate={() => pot.recurringDepositAmount ?? 0}
            itemLabel="deposits"
            nextPaymentPreview={(tentative) => {
              const previewPot: Pot = { ...pot, ...setPausedPotDeposits(pot, windowDates, tentative) }
              return potDepositOccurrencePreviews(previewPot, new Date(), 1)[0]?.date ?? null
            }}
            onSave={(pausedDates) => onSave(setPausedPotDeposits(pot, windowDates, pausedDates))}
          />
        </div>
      )}
    </div>
  )
}
