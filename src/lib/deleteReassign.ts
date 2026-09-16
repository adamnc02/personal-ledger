// Delete transforms for Person / Pot / SavingsPot, as pure functions over
// AppDataV2 so verify scripts can exercise exactly what LedgerContext runs.
// Extracted verbatim from LedgerContext.removePerson/removePot/
// removeSavingsPot (PROMPT-05, 2026-09-16) — see those callers.

import type { AppDataV2 } from '../types/ledger'
import { reconcilePersonReferences } from './household'
import { priorLocationEntry } from './locationChange'
import { sweepPendingForPot, sweepPendingForSavingsPot } from './pendingSweep'
import { toLocalIsoDate as toIso } from './date'

const todayIso = () => toIso(new Date())

export function removePersonFromData(prev: AppDataV2, id: string): AppDataV2 {
  if (prev.people.length <= 1) return prev // always at least one person
  const remaining = prev.people.filter((p) => p.id !== id)
  // Removing a person can orphan bills/loans/cards that reference
  // them (ownerId on personal items, payee on joint ones) and can
  // make an existing 'joint' item stop being meaningful if fewer
  // than 2 people are left — reconcilePersonReferences handles both,
  // and is also run on every load/restore so data already saved
  // before this existed self-heals too. See lib/household.ts.
  return reconcilePersonReferences({
    ...prev,
    people: remaining,
    payCycles: prev.payCycles.filter((pc) => pc.personId !== id),
  })
}

export function removeSavingsPotFromData(prev: AppDataV2, id: string, asOfIso: string = todayIso()): AppDataV2 {
  return {
    ...prev,
    savingsPots: prev.savingsPots.filter((p) => p.id !== id),
    // A pot's own CLEARED transactions (deposits/withdrawals/interest
    // already materialized) are historical fact and stay untouched —
    // same reasoning removePension uses for a person's past
    // pension_income transactions. PENDING ones are different: they
    // haven't happened yet and never will now, so they're swept
    // (2026-09 session — see sweepPendingForSavingsPot).
    transactions: sweepPendingForSavingsPot(prev.transactions, id, asOfIso),
  }
}

export function removePotFromData(prev: AppDataV2, id: string, asOfIso: string = todayIso()): AppDataV2 {
  return {
    ...prev,
    pots: prev.pots.filter((p) => p.id !== id),
    // A pot's own CLEARED transactions (deposits/withdrawals, and any
    // pot-funded bill/loan payment that already happened) are
    // historical fact and stay untouched — same reasoning
    // removeSavingsPot uses. PENDING ones are swept — they haven't
    // happened and never will now.
    transactions: sweepPendingForPot(prev.transactions, id, asOfIso),
    // Any bill/loan whose REGULAR payment pointed at this now-deleted
    // pot falls back to 'personal' rather than being left with a
    // dangling potId that nothing generates against — same
    // reconciliation instinct as removePension's followsIncomeSource
    // fallback, and household.ts's reconcilePersonReferences
    // backstop for the same case on data that predates this in-app
    // path. Recorded into locationHistory like any other location
    // change, so the Wallet page's audit trail shows WHY it moved.
    recurringTemplates: prev.recurringTemplates.map((t) =>
      t.location === 'pot' && t.potId === id
        ? {
            ...t,
            location: 'personal',
            potId: undefined,
            locationEffectiveFrom: asOfIso,
            locationHistory: [...(t.locationHistory ?? []), priorLocationEntry(t, t.anchorDate)],
          }
        : t,
    ),
    loans: prev.loans.map((l) => {
      let next = l
      if (l.location === 'pot' && l.potId === id) {
        next = {
          ...next,
          location: 'personal',
          potId: undefined,
          locationEffectiveFrom: asOfIso,
          locationHistory: [...(next.locationHistory ?? []), priorLocationEntry(next, next.startDate)],
        }
      }
      // A recurring overpayment independently funded from this pot
      // loses that explicit choice too — reverts to "follows the
      // loan's own location" (the field's own absent-default), not
      // forced to 'personal', since the loan itself might still be
      // pot-funded via a DIFFERENT pot, or genuinely personal/joint.
      if (next.recurringOverpayment?.location === 'pot' && next.recurringOverpayment.potId === id) {
        next = { ...next, recurringOverpayment: { ...next.recurringOverpayment, location: undefined, potId: undefined } }
      }
      return next
    }),
  }
}
