// Loan calculations for the rebuilt model (doc Section 3.2, "Tweak"):
// monthlyPayment + termMonths + startDate are the primary inputs now,
// with totalPayable as a derived/display figure, instead of the old
// app's totalAmount + monthlyPayment -> derived term. Overpayments are
// recorded here for real (LoanOverpayment[] on the Loan itself) and
// actually shrink the remaining schedule — unlike the What-if page's
// hypothetical "loan_overpayment" scenario action, which this file has
// no relationship to at all.

import { addMonths } from 'date-fns'
import { nanoid } from 'nanoid'
import type { Loan, LoanOverpayment, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso } from './date'
const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()

/** The nominal total payable as originally agreed — monthlyPayment × termMonths, before any overpayments. Purely a display figure; the actual schedule below is what determines the real payoff date. */
export function nominalTotalPayable(loan: Pick<Loan, 'monthlyPayment' | 'termMonths'>): number {
  return round2(loan.monthlyPayment * loan.termMonths)
}

export interface LoanScheduleEntry {
  date: string // ISO date
  scheduledPayment: number // the regular monthly amount applied this period (may be less than monthlyPayment on the final entry)
  overpaymentApplied: number // sum of any one-off LoanOverpayment amounts dated in this period, applied on top
  recurringOverpaymentApplied: number // this period's standing/recurring overpayment, if the loan has one active for this date
  balanceAfter: number
}

const MAX_SCHEDULE_ENTRIES = 720 // 60 years — generous safety cap, not a real limit

/** The recurring overpayment amount for this exact payment date, given the balance remaining AFTER the scheduled payment and any one-off overpayment for that month — 0 if the loan has no recurring overpayment configured, or this date falls outside its start/end window. Percent-of-balance is deliberately computed fresh each period, never cached, same reasoning as a credit card's minimum payment: a fixed % of a shrinking balance shrinks in turn. */
function recurringOverpaymentForDate(loan: Loan, dateIso: string, balanceAfterScheduledAndOneOff: number): number {
  const r = loan.recurringOverpayment
  if (!r || balanceAfterScheduledAndOneOff <= 0) return 0
  if (dateIso < r.startDate) return 0
  if (r.endDate && dateIso > r.endDate) return 0
  if (r.amount.type === 'fixed') return round2(Math.min(r.amount.amount, balanceAfterScheduledAndOneOff))
  return round2((balanceAfterScheduledAndOneOff * r.amount.percent) / 100)
}

/**
 * Builds the full month-by-month schedule from startDate, applying
 * recorded overpayments as they fall due and walking until the balance
 * reaches zero — same idea as the old app's loan engine, just against
 * the new inputs. The final scheduled payment absorbs any rounding.
 */
export function buildLoanSchedule(loan: Loan): LoanScheduleEntry[] {
  if (loan.monthlyPayment <= 0 || loan.termMonths <= 0) return []

  const schedule: LoanScheduleEntry[] = []
  let balance = nominalTotalPayable(loan)
  const start = new Date(loan.startDate)
  // Overpayments dated before the loan's first scheduled payment month, or
  // after the loan would otherwise be fully paid off, are silently never
  // applied — both are nonsensical inputs (backdated before the loan
  // existed, or logged against an already-cleared loan) rather than cases
  // worth complicating this loop to handle.
  const overpayments = loan.overpayments.slice().sort((a, b) => a.date.localeCompare(b.date))
  let overpaymentIndex = 0

  for (let i = 0; i < MAX_SCHEDULE_ENTRIES && balance > 0.005; i++) {
    const paymentDate = addMonths(start, i)
    const paymentDateIso = toIso(paymentDate)
    const scheduledPayment = Math.min(loan.monthlyPayment, balance)
    balance = round2(balance - scheduledPayment)

    // Sum any overpayments dated in this payment's month and apply them
    // on top of the scheduled payment — this is what lets the term
    // shrink instead of drifting away from reality (doc Section 3.2).
    let overpaymentApplied = 0
    while (overpaymentIndex < overpayments.length && sameMonth(new Date(overpayments[overpaymentIndex].date), paymentDate)) {
      overpaymentApplied += overpayments[overpaymentIndex].amount
      overpaymentIndex++
    }
    balance = round2(Math.max(0, balance - overpaymentApplied))

    const recurringOverpaymentApplied = recurringOverpaymentForDate(loan, paymentDateIso, balance)
    balance = round2(Math.max(0, balance - recurringOverpaymentApplied))

    schedule.push({
      date: paymentDateIso,
      scheduledPayment: round2(scheduledPayment),
      overpaymentApplied: round2(overpaymentApplied),
      recurringOverpaymentApplied,
      balanceAfter: balance,
    })
  }

  return schedule
}

export interface LoanSummary {
  totalPayable: number
  remainingBalance: number
  payoffDate: string | null // ISO date of the final schedule entry, or null if there's no schedule
  monthsRemaining: number
}

export function summarizeLoan(loan: Loan, asOfDate: Date = new Date()): LoanSummary {
  const schedule = buildLoanSchedule(loan)
  const totalPayable = nominalTotalPayable(loan)

  if (schedule.length === 0) {
    return { totalPayable, remainingBalance: totalPayable, payoffDate: null, monthsRemaining: 0 }
  }

  const asOfIso = toIso(asOfDate)
  const lastPast = schedule.filter((e) => e.date <= asOfIso).at(-1)
  const remainingBalance = lastPast ? lastPast.balanceAfter : schedule[0].balanceAfter + schedule[0].scheduledPayment + schedule[0].overpaymentApplied + schedule[0].recurringOverpaymentApplied
  const monthsRemaining = schedule.filter((e) => e.date > asOfIso).length

  return {
    totalPayable,
    remainingBalance: round2(remainingBalance),
    payoffDate: schedule.at(-1)!.date,
    monthsRemaining,
  }
}

/** Generates pending loan_payment transactions for scheduled entries within a date range — same "compute what should exist, caller dedupes" contract as schedule.ts's generateTransactionsForTemplate. The amount folds in that period's recurring overpayment (if any) — a one-off logged overpayment stays its own separate transaction (see applyLoanOverpayment), but a standing recurring one is just a bigger regular payment each month, not a second ledger line. */
export function generateLoanPaymentTransactions(loan: Loan, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  const startIso = toIso(rangeStart)
  const endIso = toIso(rangeEnd)
  return buildLoanSchedule(loan)
    .filter((e) => e.date >= startIso && e.date <= endIso)
    .map((e) => ({
      date: e.date,
      amount: round2(e.scheduledPayment + e.recurringOverpaymentApplied),
      direction: 'out',
      categoryId: loan.categoryId,
      paymentMethod: 'direct_debit',
      status: 'pending',
      type: 'loan_payment',
      location: loan.location,
      ownerId: loan.ownerId,
      payee: loan.payee,
      payeeSharePercent: loan.payeeSharePercent,
      sourceType: 'loan',
      sourceId: loan.id,
      // The loan's own name comes first — without it, a row falls back
      // to its category's name, duplicating the category group header
      // when viewed grouped by category. The recurring-overpayment note
      // (if any) appends onto that, not replaces it.
      note: e.recurringOverpaymentApplied > 0 ? `${loan.name} (includes £${e.recurringOverpaymentApplied.toFixed(2)} recurring overpayment)` : loan.name,
    }))
}

/**
 * Records a real, immediate overpayment against a loan — pushes a new
 * LoanOverpayment onto the loan (so buildLoanSchedule picks it up on the
 * next call, no separate "regenerate" step needed) and returns the
 * matching cleared loan_payment Transaction to insert into the ledger.
 */
export function applyLoanOverpayment(
  loan: Loan,
  amount: number,
  date: string,
  note?: string,
): { updatedLoan: Loan; transaction: Omit<Transaction, 'id'>; overpayment: LoanOverpayment } {
  const overpayment: LoanOverpayment = { id: nanoid(8), date, amount, note }
  const updatedLoan: Loan = { ...loan, overpayments: [...loan.overpayments, overpayment] }
  const transaction: Omit<Transaction, 'id'> = {
    date,
    amount,
    direction: 'out',
    categoryId: loan.categoryId,
    paymentMethod: 'bank_transfer',
    status: 'cleared',
    type: 'loan_payment',
    location: loan.location,
    ownerId: loan.ownerId,
    payee: loan.payee,
    payeeSharePercent: loan.payeeSharePercent,
    sourceType: 'loan_overpayment',
    sourceId: overpayment.id,
    note,
  }
  return { updatedLoan, transaction, overpayment }
}
