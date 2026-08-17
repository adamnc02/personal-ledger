import type { Bill, Loan, LoanPayment } from '../types/models'
import { toLocalIsoDate } from './date'

/**
 * Builds the full month-by-month payment schedule for a loan, from its first
 * payment date until the balance reaches zero. The final payment absorbs any
 * rounding so the balance lands exactly on £0.
 */
export function buildLoanSchedule(loan: Loan): LoanPayment[] {
  if (loan.monthlyPayment <= 0 || loan.totalAmount <= 0) return []

  const schedule: LoanPayment[] = []
  let balance = loan.totalAmount
  const start = new Date(loan.firstPaymentDate)

  // Safety cap: never generate more than 600 months (50 years) of payments
  const MAX_PAYMENTS = 600
  let i = 0

  while (balance > 0 && i < MAX_PAYMENTS) {
    const paymentDate = addMonths(start, i)
    const payment = Math.min(loan.monthlyPayment, balance)
    balance = Math.round((balance - payment) * 100) / 100

    schedule.push({
      date: toLocalIsoDate(paymentDate),
      amount: Math.round(payment * 100) / 100,
      balanceAfter: balance,
    })
    i++
  }

  return schedule
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  // clamp to the last day of the target month if the original day doesn't exist
  // (e.g. 31st on a first-payment-date rolling into February)
  const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, lastDayOfMonth))
  return d
}

export interface LoanSummary {
  totalAmount: number
  repaidToDate: number
  remaining: number
  nextPayment: LoanPayment | null
  finalPaymentDate: string | null
  monthsRemaining: number
  percentRepaid: number
}

export function summarizeLoan(loan: Loan, asOf: Date = new Date()): LoanSummary {
  const schedule = buildLoanSchedule(loan)
  const today = toLocalIsoDate(asOf)

  const repaidToDate = schedule
    .filter((p) => p.date <= today)
    .reduce((sum, p) => sum + p.amount, 0)

  const remaining = Math.max(0, Math.round((loan.totalAmount - repaidToDate) * 100) / 100)
  const nextPayment = schedule.find((p) => p.date > today) ?? null
  const finalPaymentDate = schedule.length > 0 ? schedule[schedule.length - 1].date : null
  const monthsRemaining = schedule.filter((p) => p.date > today).length
  const percentRepaid = loan.totalAmount > 0 ? Math.min(100, (repaidToDate / loan.totalAmount) * 100) : 0

  return { totalAmount: loan.totalAmount, repaidToDate, remaining, nextPayment, finalPaymentDate, monthsRemaining, percentRepaid }
}

/** What this loan actually costs per month right now — £0 once it's paid off, and the reduced final payment near the end. */
export function currentLoanMonthlyCost(loan: Loan, asOf: Date = new Date()): number {
  const summary = summarizeLoan(loan, asOf)
  if (summary.remaining <= 0) return 0
  return Math.round(Math.min(loan.monthlyPayment, summary.remaining) * 100) / 100
}

/**
 * Represents a loan's current monthly payment as a virtual Bill, so it can
 * flow through the same personal/joint split totals as everything else
 * without needing a separate, manually-linked bill entry.
 */
export function loanAsBill(loan: Loan, asOf: Date = new Date()): Bill {
  const dueDay = new Date(loan.firstPaymentDate).getDate()
  return {
    id: `loan:${loan.id}`,
    name: loan.name,
    cost: currentLoanMonthlyCost(loan, asOf),
    dueDay,
    location: loan.location,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    category: 'Loan',
    ownerId: loan.ownerId,
    isStandingOrder: true,
    icon: loan.icon,
    iconColor: loan.iconColor,
  }
}

/**
 * Merges real bills with each loan's current monthly payment (as a virtual
 * bill), so totals and summary lists automatically include loan repayments
 * without needing them duplicated as separate bill entries.
 */
export function combineBillsWithLoans(bills: Bill[], loans: Loan[], asOf: Date = new Date()): Bill[] {
  return [...bills, ...loans.map((loan) => loanAsBill(loan, asOf))]
}
