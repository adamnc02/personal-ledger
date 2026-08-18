import type { Bill, Loan, LoanPayment } from '../types/models'
import type { Loan as LedgerLoan } from '../types/ledger'
import { toLocalIsoDate } from './date'
import { buildLoanSchedule as buildLedgerLoanSchedule, estimateSettlementFigure as estimateLedgerSettlementFigure } from './ledgerLoans'

/**
 * Turns a bridged legacy Loan into the minimal real ledger-shaped Loan
 * ledgerLoans.ts's engine needs to simulate it forward from today. Only
 * called once loan.calibratedMonthlyRate is known to be set (see
 * buildLoanSchedule below) — that's always true for anything that came
 * through legacyBridge.ts in the live app. termMonths is a throwaway
 * safety-guard value only (buildLoanSchedule's own MAX_SCHEDULE_ENTRIES
 * cap is what actually bounds the loop; termMonths never otherwise
 * factors into the maths once calibratedMonthlyRate is already set, since
 * resolveLoanRateAndConvention's back-solve fallback — the only place
 * termMonths would matter — is short-circuited by the rate already being
 * present).
 */
function toSyntheticLedgerLoan(loan: Loan): LedgerLoan {
  return {
    id: loan.id,
    name: loan.name,
    principal: loan.totalAmount,
    monthlyPayment: loan.monthlyPayment,
    termMonths: 600,
    startDate: loan.firstPaymentDate,
    categoryId: '',
    location: loan.location,
    ownerId: loan.ownerId,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    overpayments: [],
    active: true,
    calibratedMonthlyRate: loan.calibratedMonthlyRate,
    interestConventionId: loan.interestConventionId,
    settlementMultiplier: loan.settlementMultiplier,
  }
}

/**
 * Builds the full month-by-month payment schedule for a loan, from its first
 * payment date until the balance reaches zero. The final payment absorbs any
 * rounding so the balance lands exactly on £0.
 *
 * DELEGATES to ledgerLoans.ts's real amortisation engine whenever the loan
 * carries a resolved calibratedMonthlyRate — i.e. whenever it was bridged
 * from a real ledger loan (loan-amortisation-engine scope §1's
 * architecture decision: one real engine, not two parallel
 * implementations that could silently drift apart). Falls back to the
 * original flat, interest-free simulation below, completely unchanged,
 * for any Loan that never carries that field — which keeps every
 * existing test fixture and any hypothetical standalone Loan behaving
 * exactly as before.
 */
export function buildLoanSchedule(loan: Loan): LoanPayment[] {
  if (loan.monthlyPayment <= 0 || loan.totalAmount <= 0) return []

  if (loan.calibratedMonthlyRate != null) {
    return buildLedgerLoanSchedule(toSyntheticLedgerLoan(loan)).map((e) => ({
      date: e.date,
      amount: e.scheduledPayment,
      balanceAfter: e.balanceAfter,
    }))
  }

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

  // Read the true remaining balance straight from the schedule's own
  // balanceAfter — correct for BOTH the flat and delegated cases, since
  // in the delegated (real-interest) case some of repaidToDate covers
  // interest rather than principal, so `totalAmount - repaidToDate`
  // would overstate what's actually still owed.
  const lastPast = schedule.filter((p) => p.date <= today).at(-1)
  const remaining = lastPast ? lastPast.balanceAfter : loan.totalAmount
  const nextPayment = schedule.find((p) => p.date > today) ?? null
  const finalPaymentDate = schedule.length > 0 ? schedule[schedule.length - 1].date : null
  const monthsRemaining = schedule.filter((p) => p.date > today).length
  const percentRepaid = loan.totalAmount > 0 ? Math.min(100, ((loan.totalAmount - remaining) / loan.totalAmount) * 100) : 0

  return { totalAmount: loan.totalAmount, repaidToDate, remaining, nextPayment, finalPaymentDate, monthsRemaining, percentRepaid }
}

/**
 * The real cost of fully closing this loan right now (loan-amortisation-
 * engine scope §6) — always MORE than `summarizeLoan(loan).remaining`
 * once real interest is involved, since early settlement carries a
 * premium. Falls back to the raw remaining balance (today's exact prior
 * behaviour) when there's no rate to estimate a premium from at all.
 * scenarios.ts's pay_off_loan logic uses this, not raw remaining, to
 * decide whether a lump sum genuinely clears a loan (scope §13 / handoff
 * step 6).
 */
export function estimateSettlementFigure(loan: Loan, asOf: Date = new Date()): number {
  if (loan.calibratedMonthlyRate == null) return summarizeLoan(loan, asOf).remaining
  return estimateLedgerSettlementFigure(toSyntheticLedgerLoan(loan), asOf)
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
