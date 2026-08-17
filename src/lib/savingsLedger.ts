// Savings as a recurring negative transaction, generated on the exact
// same payday dates as salary (doc addendum: "it automatically gets
// saved when salary arrives") — not its own independent schedule. Only
// entries with includeInSummary: true generate anything; the rest are
// tracked but don't touch the ledger, same as today.
//
// pausedFrom (see SavingsEntry in types/ledger.ts) covers both "cancel"
// and "suspend from a future date" with one field: generate normally for
// paydays strictly before it, stop from it onward. Unset = generate
// indefinitely.

import { resolvePayday } from './payCycle'
import { toLocalIsoDate } from './date'
import { monthlyAmountForEntry } from './savings'
import { SAVINGS_CATEGORY_ID } from '../types/ledger'
import type { PayCycleConfig, Person, Transaction } from '../types/ledger'

/** Generates pending savings_contribution transactions for every payday in the range where this entry is active (included in summary, and not yet paused as of that date). */
export function generateSavingsContributions(person: Person, payCycle: PayCycleConfig, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  const results: Omit<Transaction, 'id'>[] = []

  const activeEntries = person.savingsEntries.filter((e) => e.includeInSummary && monthlyAmountForEntry(e) > 0)
  if (activeEntries.length === 0) return results

  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
  while (cursor <= rangeEnd) {
    const payday = resolvePayday(cursor.getFullYear(), cursor.getMonth(), payCycle.paydayDayOfMonth, payCycle.paydayAdjustForNonWorkingDay)
    if (payday >= rangeStart && payday <= rangeEnd) {
      const dateIso = toLocalIsoDate(payday)
      for (const entry of activeEntries) {
        if (entry.pausedFrom && dateIso >= entry.pausedFrom) continue
        const amount = monthlyAmountForEntry(entry)
        results.push({
          date: dateIso,
          amount,
          direction: 'out',
          categoryId: SAVINGS_CATEGORY_ID,
          paymentMethod: 'bank_transfer',
          status: 'pending',
          type: 'savings_contribution',
          location: 'personal',
          ownerId: person.id,
          sourceType: 'savings_entry',
          sourceId: entry.id,
          note: entry.name || undefined,
        })
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return results
}
