import { useState } from 'react'
import { formatCurrency } from '../lib/format'
import { Plus, Trash2, X } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { EditField } from '../components/EditField'
import { CategoryIcon } from '../components/CategoryIcon'
import { CategoryPicker } from '../components/CategoryPicker'
import { visibleCategoriesFor } from '../lib/categories'
import type { PaymentMethod, Transaction } from '../types/ledger'

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

import { todayIso } from '../lib/date'

export function Expenses() {
  const { data, addAdHocTransaction, updateTransaction, logCreditCardSpend, removeTransaction, addCategory } = useLedgerData()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  // Entries this page owns: things logged directly here, as opposed to
  // generated bill/loan/credit-card-payment instances (doc Section 4.1 —
  // recurring templates/loans/cards are generators, not logged by hand).
  const adHocTransactions = data.transactions
    .filter((t) => t.type === 'expense' || t.type === 'income' || t.type === 'bonus' || (t.type === 'credit_card_spend' && !t.sourceType))
    .slice()
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))

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
