// The pop-down "breakdown" card that lives behind the Summary page's
// salary (Personal) hero — income vs outgoings vs what's actually left,
// for whichever horizon the hero itself is showing.
//
// Kept out of Home.tsx deliberately: it's arithmetic over the projection's
// transaction list, so it's exactly the kind of thing that should be
// verifiable by a scripts/verify-*.ts run rather than only by eye.

import { isLedgerTransaction, signedAmount } from './runningBalance'
import type { Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface CycleSummary {
  income: {
    /** Regular payday salary plus any bonuses attached to it. */
    salary: number
    /** Ad-hoc incoming logged on the Expenses page. */
    other: number
    total: number
  }
  outgoings: {
    standingOrder: number
    /** Direct debits, plus every loan payment regardless of its own payment method. */
    directDebit: number
    /** Everything else — cash, card, bank transfer. */
    other: number
    total: number
  }
  /** Cleared balance as things stand right now. */
  currentBalance: number
  /**
   * What's genuinely left once the rest of the window plays out.
   *
   * NOT `currentBalance + income.total - outgoings.total`, even though
   * that's the shape the figures suggest: the income/outgoings totals
   * above cover the WHOLE window, including items that have already
   * cleared and are therefore already baked into `currentBalance`. Adding
   * them again would count this month's salary twice the moment it lands.
   * So only STILL-PENDING items move this figure — which makes it exactly
   * equal to the projected balance the hero card already headlines, and
   * that equality is asserted in scripts/verify-cycle-summary.ts.
   */
  available: number
}

/**
 * Which bucket a transaction's outgoing amount counts toward. Loans are
 * folded into the direct-debit bucket by explicit request, whatever
 * payment method the individual loan actually carries — a loan leaving
 * the account monthly reads as a DD to the person budgeting against it,
 * and scheduled loan payments are already generated as direct_debit
 * anyway (lib/ledgerLoans.ts); this only additionally catches loan
 * overpayments/settlements, which generate as bank_transfer.
 */
function outgoingBucket(t: Transaction): 'standingOrder' | 'directDebit' | 'other' {
  if (t.type === 'loan_payment') return 'directDebit'
  if (t.paymentMethod === 'standing_order') return 'standingOrder'
  if (t.paymentMethod === 'direct_debit') return 'directDebit'
  return 'other'
}

export function computeCycleSummary(transactions: Transaction[], clearedBalance: number): CycleSummary {
  const ledger = transactions.filter(isLedgerTransaction)

  let salary = 0
  let otherIncome = 0
  let standingOrder = 0
  let directDebit = 0
  let otherOut = 0
  let pendingDelta = 0

  for (const t of ledger) {
    if (t.status === 'pending') pendingDelta += signedAmount(t)

    if (t.direction === 'in') {
      if (t.type === 'salary' || t.type === 'bonus') salary += t.amount
      else otherIncome += t.amount
      continue
    }

    const bucket = outgoingBucket(t)
    if (bucket === 'standingOrder') standingOrder += t.amount
    else if (bucket === 'directDebit') directDebit += t.amount
    else otherOut += t.amount
  }

  return {
    income: { salary: round2(salary), other: round2(otherIncome), total: round2(salary + otherIncome) },
    outgoings: {
      standingOrder: round2(standingOrder),
      directDebit: round2(directDebit),
      other: round2(otherOut),
      total: round2(standingOrder + directDebit + otherOut),
    },
    currentBalance: round2(clearedBalance),
    available: round2(clearedBalance + pendingDelta),
  }
}

/**
 * Ordering rank within a single date for the Summary ledger's
 * group-by-list / order-by-date view: salary (and a bonus paid alongside
 * it) always lands FIRST on its date, before any bill or loan due the
 * same day. This isn't cosmetic — the rolling balance figure shown beside
 * each row is a running fold in list order, so a bill sorted above the
 * salary that funds it shows a dip that never actually happens.
 */
export function sameDateRank(t: Pick<Transaction, 'type'>): number {
  return t.type === 'salary' || t.type === 'bonus' ? 0 : 1
}

/** Chronological, with salary first within any given date. */
export function compareByDateSalaryFirst(a: Transaction, b: Transaction): number {
  if (a.date !== b.date) return a.date.localeCompare(b.date)
  return sameDateRank(a) - sameDateRank(b)
}

/** Reverse-chronological, still with salary first within any given date. */
export function compareByDateDescSalaryFirst(a: Transaction, b: Transaction): number {
  if (a.date !== b.date) return b.date.localeCompare(a.date)
  return sameDateRank(a) - sameDateRank(b)
}
