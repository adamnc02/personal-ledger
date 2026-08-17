// Running balance engine — Phase 1 scope only (doc Section 4.4): cleared
// vs pending, current balance, no projection horizon yet. The 3-cycle
// projection using default/recurring salary and bills for unresolved
// future periods is Phase 3 — deliberately not attempted here, so this
// file has no dependency on RecurringTemplate/Loan schedule generation.

import type { Transaction, TransactionType } from '../types/ledger'

// Every TransactionType maps to a fixed ledger sign — see the summary
// comment on Transaction.direction in types/ledger.ts. Centralised here
// as the one place that turns `direction` into an actual +/- number, so
// every calculation in this file (and anything built on top of it) uses
// the same rule.
export function signedAmount(t: Pick<Transaction, 'amount' | 'direction'>): number {
  return t.direction === 'in' ? t.amount : -t.amount
}

// credit_card_spend never reaches the personal ledger (see types/ledger.ts) —
// filtered out up front so callers can't accidentally include it just by
// forgetting to check `type`. Exported so other files computing ledger
// totals (e.g. lib/projection.ts) share this one definition rather than
// re-deriving it.
export function isLedgerTransaction(t: Pick<Transaction, 'type'>): boolean {
  const excluded: TransactionType[] = ['credit_card_spend']
  return !excluded.includes(t.type)
}

export interface RunningBalanceSummary {
  openingBalance: number
  clearedBalance: number // openingBalance + all cleared, ledger-eligible transactions
  pendingTotal: number // signed sum of all pending, ledger-eligible transactions (no date/horizon filter yet — Phase 3)
}

export function computeRunningBalanceSummary(
  openingBalance: number,
  transactions: Transaction[],
): RunningBalanceSummary {
  let clearedDelta = 0
  let pendingTotal = 0

  for (const t of transactions) {
    if (!isLedgerTransaction(t)) continue
    const amount = signedAmount(t)
    if (t.status === 'cleared') clearedDelta += amount
    else pendingTotal += amount
  }

  return {
    openingBalance,
    clearedBalance: openingBalance + clearedDelta,
    pendingTotal,
  }
}

export interface RunningBalanceEntry {
  transaction: Transaction
  runningBalance: number // balance immediately after this transaction is applied
}

/**
 * Walks CLEARED transactions in chronological order and returns each one
 * alongside the running balance after it's applied — the "smaller,
 * greyed-out figure below each amount" the doc describes for the Summary
 * page's list-by-date view. Pending transactions are intentionally
 * excluded from this walk in Phase 1 (they don't have a settled place in
 * the sequence yet without the Phase 3 projection horizon); ties on the
 * same date are ordered by id for a stable, repeatable sort.
 */
export function computeClearedRunningBalanceList(
  openingBalance: number,
  transactions: Transaction[],
): RunningBalanceEntry[] {
  const cleared = transactions
    .filter((t) => isLedgerTransaction(t) && t.status === 'cleared')
    .slice()
    .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))

  let running = openingBalance
  return cleared.map((transaction) => {
    running += signedAmount(transaction)
    return { transaction, runningBalance: running }
  })
}
