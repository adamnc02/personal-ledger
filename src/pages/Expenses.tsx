import { useState } from 'react'
import { createPortal } from 'react-dom'
import { formatCurrency, formatFullDate } from '../lib/format'
import { Plus, Trash2, X, ChevronDown, ChevronUp } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { SwipeToDelete } from '../components/SwipeToDelete'
import { useSavedFlash, SavedFlashOverlay } from '../components/SavedFlash'
import { visibleCategoriesFor } from '../lib/categories'
import { recentAndUpcomingOccurrences, applyTemplateAmountChange, templateOccurrencePreviews, type RawOccurrence } from '../lib/schedule'
import type { PaymentMethod, RecurrenceFrequency, RecurringTemplate, Transaction } from '../types/ledger'

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

type PageMode = 'transactions' | 'recurring'

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
  } = useLedgerData()
  const [mode, setMode] = useState<PageMode>('transactions')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

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
        {(['transactions', 'recurring'] as PageMode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              setMode(m)
              setAdding(false)
            }}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors"
            style={{ background: mode === m ? 'var(--color-coral)' : 'var(--color-surface)', color: mode === m ? '#fff' : 'var(--color-ink-muted)' }}
          >
            {m === 'transactions' ? 'Transactions' : 'Recurring'}
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

          <div className="flex flex-col gap-2">
            {adHocTransactions.map((t) => {
              const category = data.categories.find((c) => c.id === t.categoryId)
              const card = t.creditCardId ? data.creditCards.find((c) => c.id === t.creditCardId) : undefined
              const isPositive = t.direction === 'in'
              const isEditing = editingId === t.id
              return (
                <div key={t.id} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)' }}>
                  <button onClick={() => setEditingId(isEditing ? null : t.id)} className="w-full flex items-center gap-3 p-3 text-left">
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
                    <span
                      role="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeTransaction(t.id)
                      }}
                      className="text-[var(--color-ink-faint)] shrink-0"
                    >
                      <Trash2 size={15} />
                    </span>
                  </button>
                  {isEditing && (
                    <EditEntryForm
                      transaction={t}
                      data={data}
                      onAddCategory={addCategory}
                      onCancel={() => setEditingId(null)}
                      onSave={(updates) => {
                        updateTransaction(t.id, updates)
                        setEditingId(null)
                      }}
                    />
                  )}
                </div>
              )
            })}
            {adHocTransactions.length === 0 && !adding && (
              <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">
                No ad-hoc entries yet. Log an expense or some income to get started.
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          {adding && (
            <RecurringTransactionForm
              people={data.people}
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
                people={data.people}
                categories={visibleCategoriesFor(data, template.categoryId)}
                onAddCategory={addCategory}
                onUpdate={(u) => updateRecurringTemplate(template.id, u)}
                onRemove={() => removeRecurringTemplate(template.id)}
              />
            ))}
            {recurringTransactions.length === 0 && !adding && (
              <p className="text-sm text-[var(--color-ink-muted)] text-center py-10">
                No recurring transactions yet. Add a recurring income or expense to have it show up automatically in the Summary ledger.
              </p>
            )}
          </div>
        </>
      )}
    </div>
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
      <div className="flex items-center justify-end">
        <button onClick={onCancel} className="text-xs text-[var(--color-ink-muted)] px-2">
          Cancel
        </button>
      </div>
      <button
        disabled={!canSave}
        onClick={() =>
          onSave({
            amount: amountNumber,
            date,
            categoryId,
            paymentMethod: paymentMethodEditable ? paymentMethod : transaction.paymentMethod,
            note: name.trim(),
          })
        }
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
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
  const [personId, setPersonId] = useState(data.primaryPersonId)

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

      {data.people.length > 1 && type === 'income' && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Whose income</span>
          <select
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            className="w-full bg-transparent border-b border-[var(--color-track)] py-1 text-[var(--color-ink)] outline-none"
          >
            {data.people.map((p) => (
              <option key={p.id} value={p.id} style={{ color: '#000' }}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <button
        disabled={!canSave}
        onClick={() =>
          onSave({
            type,
            amount: amountNumber,
            date,
            categoryId,
            paymentMethod,
            creditCardId: creditCardId || undefined,
            personId,
            note: name.trim(),
          })
        }
        className="w-full py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: 'var(--color-coral)' }}
      >
        Save
      </button>
    </div>
  )
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
  people,
  categories,
  defaultPersonId,
  onAddCategory,
  onSave,
  onCancel,
}: {
  people: { id: string; name: string }[]
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
  const [personId, setPersonId] = useState(defaultPersonId)

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

      {people.length > 1 && type === 'income' && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-ink-muted)]">Whose income</span>
          <select
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
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

      <div className="flex gap-2 justify-end mt-1">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm text-[var(--color-ink-muted)]">
          Cancel
        </button>
        <button
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
              ownerId: personId,
              kind: 'transaction',
              recurringTransactionType: type,
              personId: type === 'income' ? personId : undefined,
            })
          }
          className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-40"
          style={{ background: 'var(--color-coral)' }}
        >
          Add recurring
        </button>
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
  people,
  categories,
  onAddCategory,
  onSave,
  onDelete,
}: {
  template: RecurringTemplate
  people: { id: string; name: string }[]
  categories: { id: string; name: string; icon: string; iconColor: string }[]
  onAddCategory: (name: string) => { id: string }
  onSave: (u: Partial<Omit<RecurringTemplate, 'id'>>) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState<RecurringTxDraft>(() => draftFromRecurringTemplate(template))
  const [choosingEffectiveDate, setChoosingEffectiveDate] = useState(false)

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

  const isIncome = draft.recurringTransactionType === 'income'

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

      {isIncome && people.length > 1 && (
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-xs text-[var(--color-ink-muted)]">Whose income</span>
          <select
            value={draft.personId ?? people[0]?.id ?? ''}
            onChange={(e) => update({ personId: e.target.value, ownerId: e.target.value })}
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

      <label className="flex items-center gap-2 col-span-2 mt-1">
        <input type="checkbox" checked={draft.active} onChange={(e) => update({ active: e.target.checked })} />
        <span className="text-xs text-[var(--color-ink-muted)]">Active (paused recurring transactions stop generating new entries)</span>
      </label>

      <button onClick={onDelete} className="col-span-2 flex items-center gap-1 text-xs justify-self-start mt-1" style={{ color: 'var(--color-negative)' }}>
        <Trash2 size={13} /> Delete recurring transaction
      </button>

      <button onClick={handleSaveClick} className="col-span-2 w-full py-2.5 rounded-full text-sm font-semibold text-white mt-1" style={{ background: 'var(--color-coral)' }}>
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
  people,
  categories,
  onAddCategory,
  onUpdate,
  onRemove,
}: {
  template: RecurringTemplate
  people: { id: string; name: string }[]
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
              people={people}
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
