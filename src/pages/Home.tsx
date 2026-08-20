import { useMemo, useState } from 'react'
import { formatCurrency } from '../lib/format'
import { toLocalIsoDate } from '../lib/date'
import { ChevronDown, ChevronUp, CreditCard as CreditCardIcon, Layers } from 'lucide-react'
import { useLedgerData } from '../context/LedgerContext'
import { computeProjection, type ProjectionHorizon, type ProjectionResult } from '../lib/projection'
import { summarizeLoanProgress } from '../lib/ledgerLoans'
import { computeJointSummary } from '../lib/jointLedger'
import { computeMinimumPaymentAmount, totalPaidForCard } from '../lib/creditCards'
import { cycleBoundsForDate } from '../lib/payCycle'
import { isLedgerTransaction, signedAmount } from '../lib/runningBalance'
import { SwipeCards } from '../components/SwipeCards'
import { BankCard } from '../components/BankCard'
import { ProgressRing } from '../components/ProgressRing'
import { CategoryIcon } from '../components/CategoryIcon'
import { SAVINGS_CATEGORY_ID, CREDIT_CARD_CATEGORY_ID } from '../types/ledger'
import { seededCategoryIdForIcon } from '../lib/categories'
import type { AppDataV2, CreditCard, Transaction, PayCycleConfig } from '../types/ledger'

// ── Deck construction — doc addendum on Summary card visibility ────────
// 'personal' is always present (it's the primary viewer's own account).
// 'joint'/'household' only make sense once a second person and a joint
// cost both exist. Credit cards are scoped to the primary person's own
// cards only — this app has no "switch active viewer" concept.

type DeckEntry = { kind: 'personal' } | { kind: 'joint' } | { kind: 'household' } | { kind: 'credit_card'; cardId: string } | { kind: 'credit_cards_combined' }

function buildDeck(data: AppDataV2): DeckEntry[] {
  const deck: DeckEntry[] = [{ kind: 'personal' }]

  const hasJointItem = data.recurringTemplates.some((t) => t.location === 'joint') || data.loans.some((l) => l.location === 'joint' && l.active)
  if (data.people.length >= 2 && hasJointItem) deck.push({ kind: 'joint' })
  if (data.people.length >= 2) deck.push({ kind: 'household' })

  const myCards = data.creditCards.filter((c) => c.ownerId === data.primaryPersonId && c.active)
  for (const c of myCards) deck.push({ kind: 'credit_card', cardId: c.id })
  if (myCards.length > 1) deck.push({ kind: 'credit_cards_combined' })

  return deck
}

const HORIZON_LABELS: Record<ProjectionHorizon, string> = { current_cycle: 'This cycle', three_cycles: 'Next 3 cycles' }
type Grouping = 'list' | 'category'
type Order = 'date' | 'amount'

// The seeded "Loan" category (see lib/categories.ts's DEFAULT_LOAN_CATEGORY_ID
// equivalent in Loans.tsx) doubles as the fixed group header for every
// loan_payment transaction in the "group by category" view below — a
// stable id to fold into, not the category any individual loan actually
// carries (that stays freely assignable and still shows on each row).
const LOANS_GROUP_CATEGORY_ID = seededCategoryIdForIcon('loan')

/**
 * The category a transaction's amount counts toward in the "group by
 * category" summary view — distinct from `t.categoryId`, which is the
 * transaction's own real, freely-assignable category and is what still
 * shows on its individual row (via TransactionRow, unaffected by this).
 * Loan payments and everything credit-card-related always fold into
 * their own fixed bucket regardless of what category the underlying
 * loan/card/bill is actually tagged with — so "how much went to loans"
 * or "how much went on the card" stays answerable in one place, while
 * each loan/card/bill is still free to carry its own category for its
 * own icon everywhere else. Savings intentionally isn't handled here:
 * savings_contribution transactions already always carry
 * SAVINGS_CATEGORY_ID directly (no separate real category to preserve),
 * so grouping by `categoryId` already does the right thing for them.
 */
function groupingCategoryId(t: Transaction): string {
  if (t.type === 'loan_payment') return LOANS_GROUP_CATEGORY_ID
  if (t.type === 'credit_card_payment' || t.type === 'credit_card_spend') return CREDIT_CARD_CATEGORY_ID
  // Anything else paid by card — a bill on a "Card" payment method, an
  // ad-hoc expense, etc. — folds into the same Credit Card bucket even
  // though it isn't tied to a specific CreditCard entity at all.
  if (t.paymentMethod === 'card') return CREDIT_CARD_CATEGORY_ID
  return t.categoryId
}

/**
 * Sum of pending OUTGOING items only — loans, bills, future ad-hoc
 * expenses — shown as a negative figure. Deliberately excludes pending
 * incoming items (salary above all): salary landing inside the horizon
 * is already fully reflected in the Projected figure, so netting it into
 * Pending too double-counts it there and makes "Pending" read as "net
 * cash flow" rather than what it's meant to show, "money due to go out
 * that hasn't yet."
 */
function pendingOutgoingTotal(transactions: Transaction[]): number {
  return -transactions.filter((t) => t.status === 'pending' && isLedgerTransaction(t) && t.direction === 'out').reduce((sum, t) => sum + t.amount, 0)
}

export function Home() {
  const { data } = useLedgerData()
  const [activeIndex, setActiveIndex] = useState(0)
  const [horizon, setHorizon] = useState<ProjectionHorizon>('current_cycle')
  const [grouping, setGrouping] = useState<Grouping>('list')
  const [order, setOrder] = useState<Order>('date')
  const [showCleared, setShowCleared] = useState(false)

  const deck = useMemo(() => buildDeck(data), [data])
  const safeIndex = Math.min(activeIndex, deck.length - 1)
  const activeEntry = deck[safeIndex]

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">Home</h1>
      </header>

      <SwipeCards activeIndex={safeIndex} onChange={setActiveIndex}>
        {deck.map((entry, i) => (
          <DeckHero key={i} entry={entry} data={data} horizon={horizon} />
        ))}
      </SwipeCards>

      <div className="mt-6">
        <DeckControls entry={activeEntry} horizon={horizon} setHorizon={setHorizon} grouping={grouping} setGrouping={setGrouping} order={order} setOrder={setOrder} />
        <DeckDetail
          entry={activeEntry}
          data={data}
          horizon={horizon}
          setHorizon={setHorizon}
          grouping={grouping}
          setGrouping={setGrouping}
          order={order}
          setOrder={setOrder}
          showCleared={showCleared}
          setShowCleared={setShowCleared}
        />
      </div>
    </div>
  )
}

function CardRow({ label, value, emphasized }: { label: string; value: number; emphasized?: boolean }) {
  const negative = value < 0
  return (
    <div className="flex items-baseline justify-between">
      <span className="font-body text-[13px] uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.85)', opacity: emphasized ? 1 : 0.9 }}>
        {label}
      </span>
      <span className={`font-display tabular-nums ${emphasized ? 'text-xl font-bold' : 'text-base font-semibold'}`} style={{ color: '#fff' }}>
        {negative ? '-' : ''}£{Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </span>
    </div>
  )
}

// ── Hero faces — compact BankCard fronts, swiped between ──────────────

function DeckHero({ entry, data, horizon }: { entry: DeckEntry; data: AppDataV2; horizon: ProjectionHorizon }) {
  const primaryPerson = data.people.find((p) => p.id === data.primaryPersonId)

  switch (entry.kind) {
    case 'personal': {
      const payCycle = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)
      if (!payCycle) {
        return (
          <BankCard variant="coral" bankLabel={primaryPerson?.name ?? 'Me'} accountLabel="Personal">
            <p className="text-sm text-white/80 mt-6">No pay cycle set up yet — head to the Salary page.</p>
          </BankCard>
        )
      }
      const projection = computeProjection(data, data.primaryPersonId, payCycle, horizon)
      return (
        <BankCard variant="coral" bankLabel={primaryPerson?.name ?? 'Me'} accountLabel="Personal">
          <div className="mt-6 space-y-1.5">
            <CardRow label="Current balance" value={projection.clearedBalance} />
            <CardRow label="Pending" value={pendingOutgoingTotal(projection.transactions)} />
            <CardRow label={`Projected · ${HORIZON_LABELS[horizon]}`} value={projection.projectedBalance} emphasized />
          </div>
        </BankCard>
      )
    }
    case 'joint': {
      const cycleStartDay = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)?.cycleStartDayOfMonth ?? 1
      const bounds = cycleBoundsForDate(new Date(), cycleStartDay)
      const summary = computeJointSummary(data, bounds.start, bounds.end)
      return (
        <BankCard variant="light" bankLabel={primaryPerson?.name ?? 'Me'} accountLabel="Joint">
          <div className="mt-6 space-y-1.5">
            <CardRow label="This cycle" value={summary.totalOutgoings} />
            {summary.perPerson.map((p) => (
              <CardRow key={p.personId} label={p.name} value={p.amount} />
            ))}
          </div>
        </BankCard>
      )
    }
    case 'household': {
      const results = data.people
        .map((p) => {
          const payCycle = data.payCycles.find((pc) => pc.personId === p.id)
          return payCycle ? computeProjection(data, p.id, payCycle, horizon) : null
        })
        .filter((r): r is ReturnType<typeof computeProjection> => r !== null)
      const totalCleared = results.reduce((sum, r) => sum + r.clearedBalance, 0)
      const totalProjected = results.reduce((sum, r) => sum + r.projectedBalance, 0)
      const totalPendingOutgoing = results.reduce((sum, r) => sum + pendingOutgoingTotal(r.transactions), 0)
      return (
        <BankCard variant="dark" bankLabel="Household" accountLabel="Combined">
          <div className="mt-6 space-y-1.5">
            <CardRow label="Current balance" value={totalCleared} />
            <CardRow label="Pending" value={totalPendingOutgoing} />
            <CardRow label={`Projected · ${HORIZON_LABELS[horizon]}`} value={totalProjected} emphasized />
          </div>
        </BankCard>
      )
    }
    case 'credit_card': {
      const card = data.creditCards.find((c) => c.id === entry.cardId)
      if (!card) return null
      const minPayment = computeMinimumPaymentAmount(card)
      return (
        <BankCard variant="custom" customColor={card.color} bankLabel={card.name} accountLabel="Credit Card" icon={<CreditCardIcon size={18} strokeWidth={1.5} color="#fff" />}>
          <div className="mt-6 space-y-1.5">
            <CardRow label="Owed" value={card.currentBalance} />
            <CardRow label="Min. due" value={minPayment} emphasized />
          </div>
        </BankCard>
      )
    }
    case 'credit_cards_combined': {
      const myCards = data.creditCards.filter((c) => c.ownerId === data.primaryPersonId && c.active)
      const totalOutstanding = myCards.reduce((s, c) => s + c.currentBalance, 0)
      return (
        <BankCard variant="dark" bankLabel="All Cards" accountLabel={`${myCards.length} cards`} icon={<Layers size={18} strokeWidth={1.5} style={{ color: 'var(--color-coral)' }} />}>
          <div className="mt-6 space-y-1.5">
            <CardRow label="Total owed" value={totalOutstanding} emphasized />
          </div>
        </BankCard>
      )
    }
  }
}

// ── Detail section — full list/toggles/pie, rendered below the deck for whichever card is active ──

function DeckDetail(props: {
  entry: DeckEntry
  data: AppDataV2
  horizon: ProjectionHorizon
  setHorizon: (v: ProjectionHorizon) => void
  grouping: Grouping
  setGrouping: (v: Grouping) => void
  order: Order
  setOrder: (v: Order) => void
  showCleared: boolean
  setShowCleared: (v: boolean) => void
}) {
  const { entry, data } = props
  switch (entry.kind) {
    case 'personal':
      return <PersonalDetail {...props} />
    case 'joint':
      return <JointDetail data={data} />
    case 'household':
      return <HouseholdDetail data={data} horizon={props.horizon} />
    case 'credit_card': {
      const card = data.creditCards.find((c) => c.id === entry.cardId)
      return card ? <CreditCardDetail card={card} data={data} /> : null
    }
    case 'credit_cards_combined':
      return <CreditCardsCombinedDetail data={data} />
  }
}

// ── Deck controls — cycle toggle + Group by/Order by, living BETWEEN the
// hero deck and the detail card (not inside either one). Cycle toggle on
// the left; Group by/Order by stacked on the right, as inline dropdown
// text buttons rather than segmented pills, per the redesign. ──

function DeckControls({
  entry,
  horizon,
  setHorizon,
  grouping,
  setGrouping,
  order,
  setOrder,
}: {
  entry: DeckEntry
  horizon: ProjectionHorizon
  setHorizon: (v: ProjectionHorizon) => void
  grouping: Grouping
  setGrouping: (v: Grouping) => void
  order: Order
  setOrder: (v: Order) => void
}) {
  const showHorizon = entry.kind === 'personal' || entry.kind === 'household'
  const showGroupOrder = entry.kind === 'personal'
  if (!showHorizon && !showGroupOrder) return null

  return (
    <div className="flex items-start justify-between mb-5 px-1">
      <div>{showHorizon && <CycleToggle value={horizon} onChange={setHorizon} />}</div>
      {showGroupOrder && (
        <div className="flex flex-col items-end gap-1.5">
          <InlineDropdown
            label="Group by"
            value={grouping}
            options={[
              { value: 'list', label: 'List' },
              { value: 'category', label: 'Category' },
            ]}
            onChange={setGrouping}
          />
          <InlineDropdown
            label="Order by"
            value={order}
            options={[
              { value: 'date', label: 'Date' },
              { value: 'amount', label: 'Amount' },
            ]}
            onChange={setOrder}
            disabled={grouping === 'category'}
          />
        </div>
      )}
    </div>
  )
}

function CycleToggle({ value, onChange }: { value: ProjectionHorizon; onChange: (v: ProjectionHorizon) => void }) {
  return (
    <div className="flex gap-1.5">
      {(['current_cycle', 'three_cycles'] as ProjectionHorizon[]).map((h) => (
        <button
          key={h}
          onClick={() => onChange(h)}
          className="px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors"
          style={{ background: value === h ? 'var(--color-coral)' : 'var(--color-surface)', color: value === h ? '#fff' : 'var(--color-ink-muted)' }}
        >
          {HORIZON_LABELS[h]}
        </button>
      ))}
    </div>
  )
}

function InlineDropdown<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const currentLabel = options.find((o) => o.value === value)?.label ?? value

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="flex items-center gap-1 text-xs font-medium"
        style={{ color: disabled ? 'var(--color-ink-faint)' : 'var(--color-ink-muted)', cursor: disabled ? 'default' : 'pointer' }}
      >
        {label}: {currentLabel}
        <ChevronDown size={12} />
      </button>
      {open && !disabled && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 rounded-xl overflow-hidden z-20 shadow-lg" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-track)' }}>
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className="block w-full text-left px-3 py-2 text-xs whitespace-nowrap"
                style={{ color: value === opt.value ? 'var(--color-coral)' : 'var(--color-ink)' }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function TransactionRow({ t, data, runningBalance }: { t: Transaction; data: AppDataV2; runningBalance?: number }) {
  const category = data.categories.find((c) => c.id === t.categoryId)
  const isPositive = t.direction === 'in'
  return (
    <div className="flex items-center gap-3 py-2">
      <CategoryIcon category={category} size={14} />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--color-ink)] truncate">{t.note || category?.name || t.type}</p>
        <p className="text-[11px] text-[var(--color-ink-muted)]">
          {t.date}
          {t.status === 'pending' ? ' · Pending' : ''}
        </p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-sm font-mono font-semibold" style={{ color: isPositive ? 'var(--color-positive)' : 'var(--color-ink)' }}>
          {isPositive ? '+' : '-'}£{formatCurrency(t.amount)}
        </p>
        {runningBalance !== undefined && <p className="text-[10px] text-[var(--color-ink-faint)] tabular-nums">£{formatCurrency(runningBalance)}</p>}
      </div>
    </div>
  )
}

function DateOrderedList({
  transactions,
  data,
  openingRunningBalance,
  showCleared,
  onToggleCleared,
}: {
  transactions: Transaction[]
  data: AppDataV2
  openingRunningBalance: number
  showCleared: boolean
  onToggleCleared: () => void
}) {
  const pending = transactions.filter((t) => t.status === 'pending').sort((a, b) => a.date.localeCompare(b.date))
  const cleared = transactions.filter((t) => t.status === 'cleared').sort((a, b) => b.date.localeCompare(a.date))

  let running = openingRunningBalance
  const pendingWithRunning = pending.map((t) => {
    running += signedAmount(t)
    return { t, running }
  })

  return (
    <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
      {pendingWithRunning.map(({ t, running }) => (
        <TransactionRow key={t.id} t={t} data={data} runningBalance={running} />
      ))}
      {pending.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">Nothing pending in this window.</p>}

      <button onClick={onToggleCleared} className="flex items-center justify-between py-2.5 text-xs font-medium text-[var(--color-ink-muted)]">
        <span>Cleared ({cleared.length})</span>
        {showCleared ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {showCleared && cleared.map((t) => <TransactionRow key={t.id} t={t} data={data} />)}
    </div>
  )
}

function AmountOrderedList({ transactions, data }: { transactions: Transaction[]; data: AppDataV2 }) {
  const sorted = transactions.slice().sort((a, b) => b.amount - a.amount)
  return (
    <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
      {sorted.map((t) => (
        <TransactionRow key={t.id} t={t} data={data} />
      ))}
      {sorted.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">Nothing in this window.</p>}
    </div>
  )
}

function CategoryGroupedList({ transactions, data }: { transactions: Transaction[]; data: AppDataV2 }) {
  const groups = new Map<string, Transaction[]>()
  for (const t of transactions) {
    const key = groupingCategoryId(t)
    const list = groups.get(key) ?? []
    list.push(t)
    groups.set(key, list)
  }
  const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
    const totalA = a[1].reduce((s, t) => s + t.amount, 0)
    const totalB = b[1].reduce((s, t) => s + t.amount, 0)
    return totalB - totalA
  })

  return (
    <div className="flex flex-col gap-3">
      {sortedGroups.map(([groupKey, items]) => {
        const category = data.categories.find((c) => c.id === groupKey)
        // The Loans/Credit Card buckets fall back to their own name even
        // if the underlying category record has been renamed away from
        // it, or (for the Borrowing bucket, which is an ordinary deletable
        // seeded category rather than a protected built-in) deleted
        // outright — the bucket itself is still meaningful either way.
        const fallbackName = groupKey === LOANS_GROUP_CATEGORY_ID ? 'Loans' : groupKey === CREDIT_CARD_CATEGORY_ID ? 'Credit Card' : 'Uncategorised'
        const total = items.reduce((s, t) => s + (t.direction === 'in' ? t.amount : -t.amount), 0)
        return (
          <div key={groupKey}>
            <div className="flex items-center gap-2 mb-1">
              <CategoryIcon category={category} size={13} />
              <span className="text-xs font-semibold text-[var(--color-ink)] flex-1">{category?.name ?? fallbackName}</span>
              <span className="text-xs font-mono" style={{ color: total >= 0 ? 'var(--color-positive)' : 'var(--color-negative)' }}>
                {total >= 0 ? '+' : '-'}£{formatCurrency(Math.abs(total))}
              </span>
            </div>
            <div className="flex flex-col divide-y pl-6" style={{ borderColor: 'var(--color-track)' }}>
              {items.map((t) => (
                <TransactionRow key={t.id} t={t} data={data} />
              ))}
            </div>
          </div>
        )
      })}
      {sortedGroups.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">Nothing in this window.</p>}
    </div>
  )
}

function PersonalDetail({
  data,
  horizon,
  grouping,
  order,
  showCleared,
  setShowCleared,
}: {
  data: AppDataV2
  horizon: ProjectionHorizon
  grouping: Grouping
  order: Order
  showCleared: boolean
  setShowCleared: (v: boolean) => void
}) {
  const payCycle = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)
  if (!payCycle) return null

  const projection = computeProjection(data, data.primaryPersonId, payCycle, horizon)
  const ledgerTxns = projection.transactions.filter(isLedgerTransaction)

  return (
    <div className="rounded-3xl p-5" style={{ background: 'var(--color-surface)' }}>
      <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-4">Personal</h2>

      {grouping === 'category' ? (
        <CategoryGroupedList transactions={ledgerTxns} data={data} />
      ) : order === 'amount' ? (
        <AmountOrderedList transactions={ledgerTxns} data={data} />
      ) : (
        <DateOrderedList transactions={ledgerTxns} data={data} openingRunningBalance={projection.clearedBalance} showCleared={showCleared} onToggleCleared={() => setShowCleared(!showCleared)} />
      )}

      <ProgressRingsSection data={data} horizon={horizon} projection={projection} />
      <OverpaymentVisibilityDebug data={data} payCycle={payCycle} horizon={horizon} projection={projection} />
    </div>
  )
}

/**
 * TEMPORARY diagnostic — not a permanent feature. Reported bug: a
 * newly-logged overpayment (both a future-dated one and a today-dated
 * one) wasn't showing up in "This cycle," only in "Next 3 cycles," and a
 * today-dated one wasn't appearing under "Cleared" the way other
 * same-day transactions do. Reproducing with fresh test data showed
 * CORRECT behaviour — the "Cleared" section was just collapsed by
 * default (existing behaviour, not a bug), and expanding it revealed the
 * transaction was genuinely there. That means whatever's actually wrong
 * depends on this person's own real, accumulated data (their real pay
 * cycle configuration, in a way a fresh scenario can't reproduce) — so
 * rather than keep guessing, this prints the real numbers directly so
 * they can be reported back. Remove this component and its call site
 * entirely once the real cause is found and fixed.
 */
function OverpaymentVisibilityDebug({ data, payCycle, horizon, projection }: { data: AppDataV2; payCycle: PayCycleConfig; horizon: ProjectionHorizon; projection: ProjectionResult }) {
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const otherHorizon: ProjectionHorizon = horizon === 'current_cycle' ? 'three_cycles' : 'current_cycle'
  const otherProjection = computeProjection(data, data.primaryPersonId, payCycle, otherHorizon)

  const overpaymentTxns = data.transactions.filter((t) => t.sourceType === 'loan_overpayment' || t.sourceType === 'loan_recurring_overpayment')

  const lines: string[] = [
    `Debug — measured at ${new Date().toISOString()}`,
    `Today (real device date): ${todayIso}`,
    `Currently viewing: ${horizon}`,
    '',
    `payCycle: openingBalance=${payCycle.openingBalance} openingBalanceDate=${payCycle.openingBalanceDate} paydayDayOfMonth=${payCycle.paydayDayOfMonth} cycleStartDayOfMonth=${payCycle.cycleStartDayOfMonth}`,
    `This view's horizonEnd: ${projection.horizonEnd}`,
    `The OTHER view (${otherHorizon})'s horizonEnd: ${otherProjection.horizonEnd}`,
    '',
    `All loan_overpayment / loan_recurring_overpayment transactions in storage (${overpaymentTxns.length} found):`,
  ]
  for (const t of overpaymentTxns) {
    const withinFloor = t.date >= payCycle.openingBalanceDate || t.sourceType === 'loan_overpayment' || t.sourceType === 'loan_recurring_overpayment'
    const withinThisHorizon = t.date <= projection.horizonEnd
    const withinOtherHorizon = t.date <= otherProjection.horizonEnd
    const inThisViewsList = projection.transactions.some((pt) => pt.id === t.id || (pt.date === t.date && pt.amount === t.amount && pt.sourceType === t.sourceType))
    const matchesLocation = t.location === 'personal'
    const matchesOwner = t.ownerId === data.primaryPersonId
    const passesLedgerFilter = isLedgerTransaction(t)
    const relatedLoan = data.loans.find((l) => l.id === t.sourceId || l.overpayments.some((op) => op.id === t.sourceId))
    lines.push(
      `  id=${t.id} date=${t.date} amount=${t.amount} status=${t.status} sourceType=${t.sourceType} sourceId=${t.sourceId}`,
      `    location=${t.location} (matches personal=${matchesLocation})  ownerId=${t.ownerId} (matches primaryPerson=${matchesOwner})  isLedgerTransaction=${passesLedgerFilter}`,
      `    related loan: ${relatedLoan ? `"${relatedLoan.name}" active=${relatedLoan.active} location=${relatedLoan.location} ownerId=${relatedLoan.ownerId}` : 'NOT FOUND — sourceId does not match any loan'}`,
      `    passes-opening-floor=${withinFloor}  within-THIS-horizon=${withinThisHorizon}  within-OTHER-horizon=${withinOtherHorizon}  actually-in-this-view's-list=${inThisViewsList}`,
    )
  }

  return (
    <div className="rounded-lg p-2 mt-4" style={{ background: '#000', border: '1px solid #f00' }}>
      <p className="text-[10px] font-semibold mb-1" style={{ color: '#f66' }}>
        DEBUG — screenshot this box and send it back
      </p>
      <pre className="text-[9px] whitespace-pre-wrap" style={{ color: '#9f9', fontFamily: 'monospace' }}>
        {lines.join('\n')}
      </pre>
    </div>
  )
}

function ProgressRingsSection({ data, horizon, projection }: { data: AppDataV2; horizon: ProjectionHorizon; projection: ProjectionResult }) {
  const person = data.people.find((p) => p.id === data.primaryPersonId)
  const loans = data.loans.filter((l) => l.location === 'personal' && l.ownerId === data.primaryPersonId && l.active)
  const goals = (person?.savingsEntries ?? []).filter((e) => e.type === 'goal' && e.includeInSummary)
  if (loans.length === 0 && goals.length === 0) return null

  // Only the "Next 3 cycles" view shows a projected segment at all — "This
  // cycle" stays exactly the plain paid-so-far/saved-so-far ring it always
  // was. `projection` is already the projection for whichever horizon is
  // currently selected (computed once by the parent), so its horizonEnd
  // is the right future point to project against without recomputing
  // anything here.
  const showProjection = horizon === 'three_cycles'
  const horizonEndDate = new Date(projection.horizonEnd)

  // Two genuinely different, both-legitimate loan figures (see
  // summarizeLoanProgress's own comment): `totalPaid`/`nominalRemaining`
  // is "how much cash will I ever hand over on this loan, including
  // interest not yet accrued" — the headline figure here, by explicit
  // request, since it's what a person budgeting against their real
  // monthly outgoings wants to see first. `capitalRemaining` (true
  // amortised principal — what a bank app's own "balance" figure shows)
  // is still shown, just demoted to a smaller, clearly-separate line, so
  // neither figure is lost or silently conflated with the other. The
  // ring itself fills by CASH progress (percentPaid), matching whichever
  // number is headlined, not by principal progress.
  const loanProgress = loans.map((loan) => summarizeLoanProgress(loan))
  const totalLoansBalance = loanProgress.reduce((sum, p) => sum + p.totalBalance, 0)
  const totalLoansPaid = loanProgress.reduce((sum, p) => sum + p.totalPaid, 0)
  const totalLoansNominalRemaining = loanProgress.reduce((sum, p) => sum + p.nominalRemaining, 0)
  const totalLoansCapitalRemaining = loanProgress.reduce((sum, p) => sum + p.capitalRemaining, 0)
  const totalLoansPercentPaid = totalLoansBalance > 0 ? Math.min(100, (totalLoansPaid / totalLoansBalance) * 100) : 0

  // Projected progress as of the horizon's end date — reusing
  // summarizeLoanProgress with a future asOfDate rather than re-deriving
  // anything from the projection's generated transactions:
  // buildLoanSchedule already bakes in every scheduled payment, one-off
  // overpayment, AND standing recurring overpayment between now and
  // then, regardless of "today", so this is exactly "where the loan will
  // genuinely be."
  const projectedLoanProgress = showProjection ? loans.map((loan) => summarizeLoanProgress(loan, horizonEndDate)) : null
  const totalLoansProjectedPaid = projectedLoanProgress?.reduce((sum, p) => sum + p.totalPaid, 0) ?? totalLoansPaid
  const totalLoansProjectedPercent = totalLoansBalance > 0 ? Math.min(100, (totalLoansProjectedPaid / totalLoansBalance) * 100) : 0
  const totalLoansProjectedNominalRemaining = projectedLoanProgress?.reduce((sum, p) => sum + p.nominalRemaining, 0) ?? totalLoansNominalRemaining
  const totalLoansProjectedCapitalRemaining = projectedLoanProgress?.reduce((sum, p) => sum + p.capitalRemaining, 0) ?? totalLoansCapitalRemaining

  const savingsCategory = data.categories.find((c) => c.id === SAVINGS_CATEGORY_ID)

  return (
    <div className="mt-5 pt-5 border-t flex flex-col gap-5" style={{ borderColor: 'var(--color-track)' }}>
      {loans.length > 0 && (
        <div>
          <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-3">Loans</h3>
          <div className="flex flex-col items-center gap-5">
            {loans.map((loan, i) => {
              const progress = loanProgress[i]
              const projected = projectedLoanProgress?.[i]
              const category = data.categories.find((c) => c.id === loan.categoryId)
              return (
                <div key={loan.id} className="flex flex-col items-center gap-1">
                  <ProgressRing
                    percent={progress.percentPaid}
                    projectedPercent={projected?.percentPaid}
                    value={`£${formatCurrency(progress.totalPaid)}`}
                    label={loan.name}
                    size={110}
                    strokeWidth={10}
                    icon={<CategoryIcon category={category} size={22} />}
                  />
                  <p className="text-[11px] text-[var(--color-ink-faint)]">
                    of £{formatCurrency(progress.totalBalance)} · {progress.percentPaid.toFixed(0)}
                    {showProjection && projected ? `→${projected.percentPaid.toFixed(0)}` : ''}% paid
                  </p>
                  {/* Next 3 cycles: every figure shown alongside its
                      projected counterpart (arrow notation, actual→projected)
                      rather than replacing the actual figure outright —
                      This Cycle view is untouched, showing only today's
                      real numbers, same as before. */}
                  <p className="text-[11px] text-[var(--color-ink-muted)]">
                    £{formatCurrency(progress.nominalRemaining)}
                    {showProjection && projected && (
                      <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(projected.nominalRemaining)}</span>
                    )}{' '}
                    remaining
                  </p>
                  <p className="text-[10px] text-[var(--color-ink-faint)]">
                    £{formatCurrency(progress.capitalRemaining)}
                    {showProjection && projected && (
                      <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(projected.capitalRemaining)}</span>
                    )}{' '}
                    capital owed
                  </p>
                  {showProjection && projected && (
                    <p className="text-[10px]" style={{ color: 'var(--color-coral)' }}>
                      by {HORIZON_LABELS[horizon].toLowerCase()}
                    </p>
                  )}
                </div>
              )
            })}

            {loans.length > 1 && (
              <div
                className="flex flex-col items-center gap-1 pt-5 mt-1 border-t w-full"
                style={{ borderColor: 'var(--color-track)' }}
              >
                <ProgressRing
                  percent={totalLoansPercentPaid}
                  projectedPercent={showProjection ? totalLoansProjectedPercent : undefined}
                  value={`£${formatCurrency(totalLoansPaid)}`}
                  label="Total Loans"
                  size={160}
                  strokeWidth={14}
                  icon={<Layers size={28} strokeWidth={1.75} />}
                />
                <p className="text-[11px] text-[var(--color-ink-faint)]">
                  of £{formatCurrency(totalLoansBalance)} · {totalLoansPercentPaid.toFixed(0)}
                  {showProjection ? `→${totalLoansProjectedPercent.toFixed(0)}` : ''}% paid
                </p>
                <p className="text-[11px] text-[var(--color-ink-muted)]">
                  £{formatCurrency(totalLoansNominalRemaining)}
                  {showProjection && <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(totalLoansProjectedNominalRemaining)}</span>} remaining
                </p>
                <p className="text-[10px] text-[var(--color-ink-faint)]">
                  £{formatCurrency(totalLoansCapitalRemaining)}
                  {showProjection && <span style={{ color: 'var(--color-coral)' }}> → £{formatCurrency(totalLoansProjectedCapitalRemaining)}</span>} capital owed
                </p>
                {showProjection && (
                  <p className="text-[10px]" style={{ color: 'var(--color-coral)' }}>
                    by {HORIZON_LABELS[horizon].toLowerCase()}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {goals.length > 0 && (
        <div>
          <h3 className="font-body text-sm font-semibold text-[var(--color-ink)] mb-3">Savings</h3>
          <div className="flex flex-wrap gap-4 justify-center">
            {goals.map((goal) => {
              const target = goal.targetAmount ?? 0
              const current = goal.currentAmount ?? 0
              const percent = target > 0 ? Math.min(100, (current / target) * 100) : 0
              // Cleared contributions already live in `current` (see
              // clearTransaction.ts). Only STILL-PENDING contributions
              // within the horizon add anything on top — otherwise a
              // contribution that already cleared this cycle would count
              // twice, once in `current` and once again here.
              const projectedContribution = showProjection
                ? projection.transactions
                    .filter((t) => t.type === 'savings_contribution' && t.sourceId === goal.id && t.status === 'pending')
                    .reduce((sum, t) => sum + t.amount, 0)
                : 0
              const projectedCurrent = current + projectedContribution
              const projectedPercent = showProjection && target > 0 ? Math.min(100, (projectedCurrent / target) * 100) : undefined
              return (
                <div key={goal.id} className="flex flex-col items-center gap-1">
                  <ProgressRing
                    percent={percent}
                    projectedPercent={projectedPercent}
                    value={`£${formatCurrency(current)}`}
                    label={goal.name || 'Goal'}
                    size={110}
                    strokeWidth={10}
                    icon={<CategoryIcon category={savingsCategory} size={22} />}
                  />
                  <p className="text-[11px] text-[var(--color-ink-faint)]">of £{formatCurrency(target)}</p>
                  {showProjection && projectedContribution > 0 && (
                    <p className="text-[11px]" style={{ color: 'var(--color-coral)' }}>
                      projected £{formatCurrency(projectedCurrent)} by {HORIZON_LABELS[horizon].toLowerCase()}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function JointDetail({ data }: { data: AppDataV2 }) {
  const cycleStartDay = data.payCycles.find((pc) => pc.personId === data.primaryPersonId)?.cycleStartDayOfMonth ?? 1
  const bounds = cycleBoundsForDate(new Date(), cycleStartDay)
  const summary = computeJointSummary(data, bounds.start, bounds.end)
  const fmt = (d: Date) => toLocalIsoDate(d)

  return (
    <div className="rounded-3xl p-5" style={{ background: 'var(--color-surface)' }}>
      <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">Joint</h2>
      <p className="text-xs text-[var(--color-ink-muted)] mb-4">
        This cycle ({fmt(bounds.start)} – {fmt(bounds.end)})
      </p>
      <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
        {summary.items.map((item, i) => (
          <div key={i} className="flex items-center justify-between py-2">
            <div>
              <p className="text-sm text-[var(--color-ink)]">{item.name}</p>
              <p className="text-[11px] text-[var(--color-ink-muted)]">{item.date}</p>
            </div>
            <p className="text-sm font-mono text-[var(--color-ink)]">£{formatCurrency(item.amount)}</p>
          </div>
        ))}
        {summary.items.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">No joint items this cycle.</p>}
      </div>
    </div>
  )
}

function HouseholdDetail({ data, horizon }: { data: AppDataV2; horizon: ProjectionHorizon }) {
  const results = data.people
    .map((p) => {
      const payCycle = data.payCycles.find((pc) => pc.personId === p.id)
      return payCycle ? { person: p, projection: computeProjection(data, p.id, payCycle, horizon) } : null
    })
    .filter((r): r is { person: (typeof data.people)[number]; projection: ReturnType<typeof computeProjection> } => r !== null)
  const missingCount = data.people.length - results.length

  return (
    <div className="rounded-3xl p-5" style={{ background: 'var(--color-surface)' }}>
      <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-4">Household</h2>
      <div className="flex flex-col gap-1.5">
        {results.map((r) => (
          <div key={r.person.id} className="flex items-center justify-between text-sm py-1">
            <span className="text-[var(--color-ink-muted)]">{r.person.name}</span>
            <span className="font-mono text-[var(--color-ink)]">£{formatCurrency(r.projection.clearedBalance)}</span>
          </div>
        ))}
      </div>
      {missingCount > 0 && (
        <p className="text-xs text-[var(--color-ink-faint)] mt-3">
          {missingCount} {missingCount === 1 ? "person doesn't" : "people don't"} have a pay cycle set up yet, so they're left out of this total.
        </p>
      )}
      <p className="text-xs text-[var(--color-ink-faint)] mt-2">
        Each person's own total already includes their share of joint bills/loans — this is simply both personal
        pictures added together, not a separate calculation on top.
      </p>
    </div>
  )
}

function ordinalSuffix(day: number): string {
  if (day % 10 === 1 && day !== 11) return 'st'
  if (day % 10 === 2 && day !== 12) return 'nd'
  if (day % 10 === 3 && day !== 13) return 'rd'
  return 'th'
}

function CardActivityRow({ t }: { t: Transaction }) {
  const isSpend = t.type === 'credit_card_spend'
  return (
    <div className="flex items-center justify-between py-2">
      <div>
        <p className="text-sm text-[var(--color-ink)]">{t.note || (isSpend ? 'Spend' : 'Payment')}</p>
        <p className="text-[11px] text-[var(--color-ink-muted)]">
          {t.date}
          {t.status === 'pending' ? ' · Pending' : ''}
        </p>
      </div>
      <p className="text-sm font-mono font-semibold" style={{ color: isSpend ? 'var(--color-negative)' : 'var(--color-positive)' }}>
        {isSpend ? '+' : '-'}£{formatCurrency(t.amount)}
      </p>
    </div>
  )
}

function CreditCardDetail({ card, data }: { card: CreditCard; data: AppDataV2 }) {
  const paid = totalPaidForCard(card.id, data.transactions)
  const percentPaid = paid + card.currentBalance > 0 ? (paid / (paid + card.currentBalance)) * 100 : 0
  const activity = data.transactions
    .filter((t) => t.creditCardId === card.id && (t.type === 'credit_card_spend' || t.type === 'credit_card_payment'))
    .sort((a, b) => b.date.localeCompare(a.date))
  // The card's own colour overrides the category's colour for display
  // (types/ledger.ts: "categoryId: for icon; colour below overrides the
  // category's colour") — so the icon SHAPE comes from the category, but
  // is tinted with the card's own colour, not the category's.
  const category = data.categories.find((c) => c.id === card.categoryId)

  return (
    <div className="rounded-3xl p-5" style={{ background: 'var(--color-surface)' }}>
      <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">
        {card.name} <span className="text-xs font-normal text-[var(--color-ink-muted)]">due on the {card.paymentDayOfMonth}{ordinalSuffix(card.paymentDayOfMonth)}</span>
      </h2>

      <div className="flex justify-center my-4">
        <ProgressRing
          percent={percentPaid}
          value={`£${formatCurrency(card.currentBalance)}`}
          label="Outstanding"
          size={160}
          strokeWidth={14}
          color={card.color}
          icon={<CategoryIcon category={category ? { ...category, iconColor: card.color } : undefined} size={26} />}
        />
      </div>
      <p className="text-xs text-[var(--color-ink-muted)] text-center mb-4">£{formatCurrency(paid)} paid to date</p>

      <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
        {activity.map((t) => (
          <CardActivityRow key={t.id} t={t} />
        ))}
        {activity.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">No activity yet.</p>}
      </div>
    </div>
  )
}

function CreditCardsCombinedDetail({ data }: { data: AppDataV2 }) {
  const myCards = data.creditCards.filter((c) => c.ownerId === data.primaryPersonId && c.active)
  const totalOutstanding = myCards.reduce((s, c) => s + c.currentBalance, 0)
  const totalPaid = myCards.reduce((s, c) => s + totalPaidForCard(c.id, data.transactions), 0)
  const percentPaid = totalPaid + totalOutstanding > 0 ? (totalPaid / (totalPaid + totalOutstanding)) * 100 : 0
  const activity = data.transactions
    .filter((t) => t.creditCardId && myCards.some((c) => c.id === t.creditCardId) && (t.type === 'credit_card_spend' || t.type === 'credit_card_payment'))
    .sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="rounded-3xl p-5" style={{ background: 'var(--color-surface)' }}>
      <h2 className="font-display text-lg font-semibold text-[var(--color-ink)] mb-1">All Credit Cards</h2>

      <div className="flex justify-center my-4">
        <ProgressRing
          percent={percentPaid}
          value={`£${formatCurrency(totalOutstanding)}`}
          label="Total outstanding"
          size={160}
          strokeWidth={14}
          icon={<Layers size={28} strokeWidth={1.75} />}
        />
      </div>
      <p className="text-xs text-[var(--color-ink-muted)] text-center mb-4">
        £{formatCurrency(totalPaid)} paid to date, across {myCards.length} cards
      </p>

      <div className="flex flex-col divide-y" style={{ borderColor: 'var(--color-track)' }}>
        {activity.map((t) => (
          <CardActivityRow key={t.id} t={t} />
        ))}
        {activity.length === 0 && <p className="text-sm text-[var(--color-ink-muted)] text-center py-6">No activity yet.</p>}
      </div>
    </div>
  )
}
