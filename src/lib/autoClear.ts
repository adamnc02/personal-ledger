// Automatic clearing — there is NO tap-to-clear anywhere in the app.
// The moment "today" reaches or passes a scheduled bill/loan/credit-
// card-minimum/salary/savings-contribution/joint-share date, it settles
// on its own: this function materializes it into a real, persisted,
// cleared Transaction and applies whatever side effect its type carries
// (savings goal progress, credit card balance).
//
// Two separate things come due and need settling, and both are covered:
//  1. Anything GENERATED (a scheduled bill/loan/salary/etc. occurrence
//     that only ever existed as a preview, never persisted) — this gets
//     materialized into a real transaction for the first time.
//  2. Anything ALREADY STORED but still pending whose date has now
//     arrived — e.g. a credit card lump payment or ad-hoc expense
//     logged for a future date. Nothing else in the app ever revisits
//     an already-persisted pending transaction, so without this step a
//     future-dated logged payment would stay 'pending' forever even
//     once its date passed — no side effect (like reducing a card's
//     balance) would ever apply, and it would never move into the
//     Cleared section on its own. This is exactly what step 2 fixes.
//
// Pure and idempotent: returns the SAME `data` reference, unchanged,
// when there's nothing new to settle. That's what lets the caller run
// this on every data load/change via a plain reference-equality check
// without risking an infinite update loop — once everything due has been
// settled, a second pass finds nothing left to do and is a no-op.

import { nanoid } from 'nanoid'
import { generateTransactionsForTemplate } from './schedule'
import { generateLoanPaymentTransactions } from './ledgerLoans'
import { generateMinimumPaymentTransactions } from './creditCards'
import { generateSalaryTransactions } from './salaryLedger'
import { generateSavingsContributions } from './savingsLedger'
import { generateJointContributionTransactions } from './jointLedger'
import { dedupeKey } from './projection'
import { applyClearSideEffects } from './clearTransaction'
import { toLocalIsoDate } from './date'
import type { AppDataV2, Transaction } from '../types/ledger'

export function autoClearDuePayments(data: AppDataV2, asOf: Date = new Date()): AppDataV2 {
  const asOfIso = toLocalIsoDate(asOf)
  let result = data
  let changed = false

  // Step 1 — settle anything already stored that's still pending but due.
  // Applies to every pending transaction regardless of type or owner;
  // applyClearSideEffects itself is the thing that decides whether a
  // given type actually has a side effect to run (most don't, and this
  // is just a status flip for those).
  for (const t of data.transactions) {
    if (t.status !== 'pending' || t.date > asOfIso) continue
    const cleared: Transaction = { ...t, status: 'cleared' }
    result = applyClearSideEffects({ ...result, transactions: result.transactions.map((tx) => (tx.id === t.id ? cleared : tx)) }, cleared)
    changed = true
  }

  // Step 2 — materialize newly-due GENERATED occurrences that have never existed as a real transaction at all.
  for (const person of data.people) {
    const payCycle = data.payCycles.find((pc) => pc.personId === person.id)
    if (!payCycle) continue

    const rangeStart = new Date(payCycle.openingBalanceDate)
    if (rangeStart > asOf) continue // nothing before the visibility floor is ever due

    const stored = result.transactions.filter((t) => t.location === 'personal' && t.ownerId === person.id)
    const existingKeys = new Set(stored.map(dedupeKey).filter((k): k is string => k !== null))

    const candidates: Omit<Transaction, 'id'>[] = []
    for (const template of result.recurringTemplates.filter((t) => t.location === 'personal' && t.ownerId === person.id)) {
      candidates.push(...generateTransactionsForTemplate(template, rangeStart, asOf))
    }
    for (const loan of result.loans.filter((l) => l.location === 'personal' && l.ownerId === person.id)) {
      candidates.push(...generateLoanPaymentTransactions(loan, rangeStart, asOf))
    }
    for (const card of result.creditCards.filter((c) => c.ownerId === person.id)) {
      candidates.push(...generateMinimumPaymentTransactions(card, rangeStart, asOf))
    }
    candidates.push(...generateSalaryTransactions(person, payCycle, rangeStart, asOf))
    candidates.push(...generateSavingsContributions(person, payCycle, rangeStart, asOf))
    candidates.push(...generateJointContributionTransactions(result, person.id, rangeStart, asOf))

    for (const candidate of candidates) {
      if (candidate.date > asOfIso) continue // safety net — generators are already range-bounded to asOf, but never settle a future-dated one
      const key = dedupeKey(candidate)
      if (key && existingKeys.has(key)) continue // already materialized (or logged by hand) — don't duplicate

      const real: Transaction = { ...candidate, id: nanoid(8), status: 'cleared' }
      result = applyClearSideEffects({ ...result, transactions: [...result.transactions, real] }, real)
      if (key) existingKeys.add(key)
      changed = true
    }
  }

  return changed ? result : data
}
