import { useState } from 'react'
import { useAppData } from '../context/AppContext'
import { SwipeCards } from '../components/SwipeCards'
import { BankCard } from '../components/BankCard'
import { BillsTable } from '../components/BillsTable'
import { BillsCategoryView } from '../components/BillsCategoryView'
import { ProgressRing } from '../components/ProgressRing'
import { calculateNetSalary } from '../lib/tax'
import { billsByLocation, personalBillsTotal, jointContributionForPerson, standingOrderTotalForPerson, totalOutgoingsForPerson, jointAccountTotal } from '../lib/bills'
import { summarizeLoan, combineBillsWithLoans } from '../lib/loans'
import { totalMonthlySavingsForPerson } from '../lib/savings'
import { calculateHouseholdFigures } from '../lib/household'
import { CollapsibleSection } from '../components/CollapsibleSection'
import { Landmark } from 'lucide-react'
import { BILL_ICONS, DEFAULT_ICON_COLOR } from '../lib/billIcons'
import type { Bill } from '../types/models'

export function Dashboard() {
  const { data } = useAppData()
  const [cardIndex, setCardIndex] = useState(0)
  const [billsView, setBillsView] = useState<'list' | 'category'>('list')

  const me = data.people.find((p) => p.id === data.primaryPersonId) ?? data.people[0]
  const otherPeople = data.people.filter((p) => p.id !== me?.id)

  if (!me) {
    return <EmptyState />
  }

  // Loans behave like automatic recurring bills — their current monthly
  // payment flows through the same totals as everything else, without
  // needing a separate duplicate bill entry.
  const allBills = combineBillsWithLoans(data.bills, data.loans)

  const netSalary = calculateNetSalary(me.salary)
  const personalBills = billsByLocation(allBills, 'personal', me.id).filter((b) => b.cost > 0)
  const jointBills = billsByLocation(allBills, 'joint').filter((b) => b.cost > 0)

  const personalTotal = personalBillsTotal(allBills, me.id)
  const jointContribution = jointContributionForPerson(allBills, me.id, data.people)
  const monthlySavings = totalMonthlySavingsForPerson(me)
  const availableAfterBills = netSalary.netPerPeriod - personalTotal - jointContribution - monthlySavings

  const standingOrderTotal = standingOrderTotalForPerson(allBills, me.id)
  const fullOutgoings = totalOutgoingsForPerson(allBills, me.id, data.people)
  const jointTotal = jointAccountTotal(allBills)

  // Household combined figures for the 3rd card: every person's income
  // normalized to a monthly-equivalent (so a monthly earner and a 4-weekly
  // earner combine meaningfully), against every bill and loan's full cost —
  // not per-person splits, since this view is the whole household's numbers.
  const household = calculateHouseholdFigures(data)
  const totalHouseholdIncome = household.totalIncome
  const totalHouseholdOutgoings = household.totalOutgoings
  const totalHouseholdAvailable = household.totalAvailable
  const allBillsCombined = allBills.filter((b) => b.cost > 0)

  // Same scoping as Bills: personal card shows only loans you own, joint
  // card shows joint loans, household card shows everything. Without this,
  // switching "Me" left every loan visible regardless of whose it was.
  const loansForActiveCard =
    cardIndex === 0
      ? data.loans.filter((l) => l.location === 'personal' && l.ownerId === me.id)
      : cardIndex === 1
        ? data.loans.filter((l) => l.location === 'joint')
        : data.loans

  // Aggregate across the active card's loans for the "Total Debt" ring —
  // summed from each loan's own repaid-to-date and original amount, not
  // an average of their individual percentages, so a large loan properly
  // outweighs a small one in the combined figure.
  const loanSummaries = loansForActiveCard.map((loan) => summarizeLoan(loan))
  const totalDebtRemaining = round2(loanSummaries.reduce((sum, s) => sum + s.remaining, 0))
  const totalDebtOriginal = round2(loansForActiveCard.reduce((sum, l) => sum + l.totalAmount, 0))
  const totalDebtRepaid = round2(loanSummaries.reduce((sum, s) => sum + s.repaidToDate, 0))
  const totalDebtPercentRepaid = totalDebtOriginal > 0 ? Math.min(100, (totalDebtRepaid / totalDebtOriginal) * 100) : 0

  // A synthetic row representing this person's total stake in the joint account,
  // shown alongside their personal bills so the table total matches their
  // real monthly outgoings (personal bills + joint share).
  const jointAccountRow: Bill = {
    id: '__joint_account_stake__',
    name: 'Joint Account',
    cost: jointContribution,
    dueDay: 0,
    location: 'personal',
    payee: me.id,
    payeeSharePercent: 100,
    category: 'Joint Account',
    ownerId: me.id,
    isStandingOrder: false,
    // This row is synthesized, not a real bill, so there's nothing to open
    // an icon picker on — give it a sensible fixed default instead.
    icon: 'joint',
    iconColor: DEFAULT_ICON_COLOR,
  }
  const personalTableRows = jointContribution > 0 ? [...personalBills, jointAccountRow] : personalBills

  return (
    <div className="max-w-md mx-auto px-4 pt-6">
      <header className="mb-6">
        <p className="font-body text-sm text-[var(--color-ink-muted)]">Welcome back</p>
        <h1 className="font-display text-2xl font-semibold text-[var(--color-ink)]">{me.name}'s Overview</h1>
      </header>

      <SwipeCards activeIndex={cardIndex} onChange={setCardIndex}>
        <BankCard variant="coral" bankLabel={me.name} accountLabel="Personal">
          <div className="mt-6 space-y-1.5">
            <CardRow label={me.salary.payFrequency === 'four_weekly' ? 'Net Pay (4wk)' : 'Net Salary'} value={netSalary.netPerPeriod} light />
            <CardRow label="Bills" value={personalTotal + jointContribution} light />
            {monthlySavings > 0 && <CardRow label="Savings" value={monthlySavings} light />}
            <CardRow label="Available" value={availableAfterBills} light emphasized />
          </div>
        </BankCard>

        <BankCard variant="light" bankLabel={me.name} accountLabel="Joint">
          <div className="mt-6 space-y-1.5">
            <CardRow label="Bills" value={jointTotal} />
            {[me, ...otherPeople].map((p) => (
              <CardRow key={p.id} label={p.name} value={jointContributionForPerson(allBills, p.id, data.people)} />
            ))}
          </div>
        </BankCard>

        <BankCard variant="dark" bankLabel="Household" accountLabel="Combined">
          <div className="mt-6 space-y-1.5">
            <CardRow label="Income" value={totalHouseholdIncome} light />
            <CardRow label="Bills & Loans" value={totalHouseholdOutgoings} light />
            <CardRow label="Available" value={totalHouseholdAvailable} light emphasized />
          </div>
        </BankCard>
      </SwipeCards>

      <CollapsibleSection
        title={cardIndex === 0 ? 'Bills' : cardIndex === 1 ? 'Joint Bills' : 'All Bills & Loans'}
        className="mt-8"
        headerExtra={
          <div className="flex gap-1 rounded-full p-0.5" style={{ background: 'var(--color-surface)' }}>
            {(['list', 'category'] as const).map((view) => (
              <button
                key={view}
                onClick={() => setBillsView(view)}
                className="px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide capitalize transition-colors"
                style={{
                  background: billsView === view ? 'var(--color-coral)' : 'transparent',
                  color: billsView === view ? '#fff' : 'var(--color-ink-muted)',
                }}
              >
                {view}
              </button>
            ))}
          </div>
        }
      >
        {cardIndex === 0 ? (
          billsView === 'list' ? (
            <BillsTable bills={personalTableRows} people={data.people} total={fullOutgoings} />
          ) : (
            <BillsCategoryView bills={personalTableRows} total={fullOutgoings} />
          )
        ) : cardIndex === 1 ? (
          billsView === 'list' ? (
            <BillsTable bills={jointBills} people={data.people} showSplit viewerId={me.id} total={jointTotal} />
          ) : (
            <BillsCategoryView bills={jointBills} total={jointTotal} />
          )
        ) : billsView === 'list' ? (
          <BillsTable bills={allBillsCombined} people={data.people} total={totalHouseholdOutgoings} />
        ) : (
          <BillsCategoryView bills={allBillsCombined} total={totalHouseholdOutgoings} />
        )}
      </CollapsibleSection>

      {cardIndex === 0 && (
        <div className="mt-4 rounded-2xl p-5" style={{ background: 'var(--color-surface)' }}>
          <SummaryRow label="Standing orders only" value={standingOrderTotal} />
          <SummaryRow label="Including joint bill split" value={fullOutgoings} emphasized />
        </div>
      )}

      {loansForActiveCard.length > 0 && (
        <CollapsibleSection title={cardIndex === 0 ? 'Loans' : cardIndex === 1 ? 'Joint Loans' : 'All Loans'} className="mt-10">
          <div className="flex flex-col items-center gap-10">
            {loansForActiveCard.map((loan) => {
              const summary = summarizeLoan(loan)
              const RingIcon = (loan.icon && BILL_ICONS[loan.icon]) || Landmark
              const ringIconColor = loan.icon ? loan.iconColor || DEFAULT_ICON_COLOR : undefined
              return (
                <ProgressRing
                  key={loan.id}
                  percent={summary.percentRepaid}
                  value={`£${summary.remaining.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  label={`${loan.name} Remaining`}
                  icon={<RingIcon size={56} strokeWidth={1.25} color={ringIconColor} />}
                />
              )
            })}
          </div>
        </CollapsibleSection>
      )}

      {loansForActiveCard.length > 1 && (
        <div className="mt-10 flex flex-col items-center">
          <ProgressRing
            percent={totalDebtPercentRepaid}
            value={`£${totalDebtRemaining.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            label={cardIndex === 0 ? 'Your Total Debt Remaining' : cardIndex === 1 ? 'Joint Total Debt Remaining' : 'Household Total Debt Remaining'}
            icon={<Landmark size={56} strokeWidth={1.25} />}
          />
        </div>
      )}
    </div>
  )
}

function CardRow({ label, value, light, emphasized }: { label: string; value: number; light?: boolean; emphasized?: boolean }) {
  const negative = value < 0
  return (
    <div className="flex items-baseline justify-between">
      <span
        className="font-body text-[13px] uppercase tracking-wider"
        style={{ color: light ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.55)', opacity: emphasized ? 1 : 0.9 }}
      >
        {label}
      </span>
      <span
        className={`font-display tabular-nums ${emphasized ? 'text-xl font-bold' : 'text-base font-semibold'}`}
        style={{ color: light ? '#fff' : '#1a1a1a' }}
      >
        {negative ? '-' : ''}£{Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
      </span>
    </div>
  )
}

function SummaryRow({ label, value, emphasized }: { label: string; value: number; emphasized?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="font-body text-sm text-[var(--color-ink-muted)]">{label}</span>
      <span className={`font-mono tabular-nums ${emphasized ? 'text-lg font-semibold text-[var(--color-ink)]' : 'text-sm text-[var(--color-ink)]'}`}>
        £{value.toFixed(2)}
      </span>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6 text-center">
      <h1 className="font-display text-xl font-semibold text-[var(--color-ink)] mb-2">Let's get set up</h1>
      <p className="font-body text-sm text-[var(--color-ink-muted)]">
        Head to the Salary tab to add your details and start tracking.
      </p>
    </div>
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
