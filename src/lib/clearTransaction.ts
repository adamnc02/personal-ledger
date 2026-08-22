// Marking a pending transaction as cleared didn't exist anywhere in the
// app until now — this is that mechanism, built generically (a per-type
// effect, not a one-off `if` for savings) since credit card minimum
// payments have the exact same unfinished gap: clearing one should
// reduce the card's balance, and nothing does that yet either.
//
// Two things happen when a transaction clears:
//  1. It's materialized into a real, persisted Transaction with
//     status: 'cleared' — most transactions shown in the UI are
//     synthetic (generated fresh on every render by projection.ts, id
//     prefixed "generated:"), so "clearing" one usually means creating
//     it for real, not updating something that doesn't exist yet.
//  2. Its type-specific side effect applies. Only savings_contribution
//     has one now — it quietly increases the linked goal's currentAmount.
//     Credit card payments used to have one too; they don't any more,
//     because a card's balance is derived from its transactions rather
//     than kept as a running total (see below).

import type { AppDataV2, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

export function isSyntheticTransactionId(id: string): boolean {
  return id.startsWith('generated:')
}

/** Applies a transaction's clear-time side effect to the rest of the data — savings/credit-card balance updates. Pure: returns a new AppDataV2, doesn't mutate. No-op for transaction types with no side effect (most of them). */
export function applyClearSideEffects(data: AppDataV2, transaction: Transaction): AppDataV2 {
  if (transaction.type === 'savings_contribution' && transaction.sourceType === 'savings_entry' && transaction.sourceId) {
    return {
      ...data,
      people: data.people.map((p) =>
        p.id === transaction.ownerId
          ? {
              ...p,
              savingsEntries: p.savingsEntries.map((e) =>
                // Only 'goal' entries track progress toward a target —
                // a 'plan' is just a flat recurring commitment with no
                // currentAmount concept, so bumping it here would just
                // accumulate an unused, confusing number.
                e.id === transaction.sourceId && e.type === 'goal' ? { ...e, currentAmount: round2((e.currentAmount ?? 0) + transaction.amount) } : e,
              ),
            }
          : p,
      ),
    }
  }

  // NOTE: credit_card_payment deliberately has NO side effect here any
  // more. It used to reduce (and post interest to) the card's
  // currentBalance, which is what made that field a mutable running
  // total — see the comment on CreditCard in types/ledger.ts. The
  // balance is now derived from the transactions themselves by
  // cardBalanceAsOf, so the transaction existing IS the effect; applying
  // one here as well would double-count it.

  return data
}
