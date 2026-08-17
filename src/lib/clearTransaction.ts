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
//  2. Its type-specific side effect applies: a savings_contribution
//     quietly increases the linked goal's currentAmount; a
//     credit_card_payment (generated minimum OR a logged lump payment —
//     both, uniformly) reduces that card's balance. Neither ever
//     touches the balance before it actually clears — a future-dated
//     logged lump payment stays pending, balance untouched, until its
//     date genuinely arrives, same as everything else in the app.

import { applyMonthlyInterest } from './creditCards'
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

  if (transaction.type === 'credit_card_payment' && transaction.creditCardId) {
    // Both the generated monthly-minimum kind AND a logged lump payment
    // go through this uniformly for the PAYMENT itself — neither adjusts
    // the card's balance at logging/generation time, only once the
    // transaction actually clears. INTEREST, though, is tied specifically
    // to the billing-cycle event (the generated minimum payment), not to
    // an arbitrary logged lump payment — a lump payment can land any time
    // mid-cycle and shouldn't independently trigger a full cycle's
    // interest each time one clears. So: interest posts first, ONLY for
    // the generated-minimum-payment case, THEN the payment (of either
    // kind) is subtracted.
    return {
      ...data,
      creditCards: data.creditCards.map((c) => {
        if (c.id !== transaction.creditCardId) return c
        const isGeneratedMinimumPayment = transaction.sourceType !== 'credit_card_lump_payment'
        const balanceWithInterest = isGeneratedMinimumPayment ? applyMonthlyInterest(c.currentBalance, c.interestRatePercent) : c.currentBalance
        return { ...c, currentBalance: round2(Math.max(0, balanceWithInterest - transaction.amount)) }
      }),
    }
  }

  return data
}
