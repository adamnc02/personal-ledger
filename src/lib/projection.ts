// Phase 3 scope (doc Section 4.4): "Projected balance = cleared balance +
// all pending/scheduled transactions up to a configurable horizon,
// defaulting to the end of the current pay cycle, extendable to 3
// cycles." This file generates the not-yet-materialized future
// occurrences (bills, loans, credit card minimums, salary, and — via
// jointLedger.ts — this person's share of joint bills/loans) that fill
// in that horizon, dedupes them against anything that already exists as
// a real Transaction, and combines the two into one figure + one list.

import { addDays } from 'date-fns'
import { nanoid } from 'nanoid'
import { generateTransactionsForTemplate } from './schedule'
import { generateLoanPaymentTransactions } from './ledgerLoans'
import { generateMinimumPaymentTransactions } from './creditCards'
import { generateSalaryTransactions } from './salaryLedger'
import { generateSavingsContributions } from './savingsLedger'
import { generateJointContributionTransactions } from './jointLedger'
import { cycleBoundsForDate } from './payCycle'
import { isLedgerTransaction, signedAmount } from './runningBalance'
import type { AppDataV2, PayCycleConfig, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso } from './date'

export type ProjectionHorizon = 'current_cycle' | 'three_cycles'

/** The end of the projection window: the current cycle's end, or the end of the cycle two ahead of it (i.e. 3 cycles total, current + 2 more). */
export function horizonRangeEnd(payCycle: PayCycleConfig, horizon: ProjectionHorizon, asOfDate: Date): Date {
  const current = cycleBoundsForDate(asOfDate, payCycle.cycleStartDayOfMonth)
  if (horizon === 'current_cycle') return current.end

  const next1 = cycleBoundsForDate(addDays(current.end, 1), payCycle.cycleStartDayOfMonth)
  const next2 = cycleBoundsForDate(addDays(next1.end, 1), payCycle.cycleStartDayOfMonth)
  return next2.end
}

/**
 * A stable key for matching a generated occurrence against an already-
 * materialized real Transaction, so the same bill/loan/card-payment/
 * salary date never gets counted twice. Returns null for transaction
 * types this file doesn't generate (ad-hoc expense/income/bonus/spend),
 * which are never deduped against anything — they only ever exist once,
 * logged by hand.
 */
export function dedupeKey(t: Pick<Transaction, 'type' | 'date' | 'sourceType' | 'sourceId' | 'personId' | 'creditCardId'>): string | null {
  if (t.sourceType && t.sourceId) return `${t.sourceType}:${t.sourceId}:${t.date}`
  if (t.type === 'salary' && t.personId) return `salary:${t.personId}:${t.date}`
  if (t.type === 'credit_card_payment' && t.creditCardId) return `credit_card_min:${t.creditCardId}:${t.date}`
  return null
}

export interface ProjectionResult {
  horizon: ProjectionHorizon
  horizonEnd: string // ISO date
  openingBalance: number
  clearedBalance: number // from real, stored, cleared transactions only
  projectedBalance: number // clearedBalance + all pending (real + generated) dated on/before horizonEnd
  transactions: Transaction[] // stored + generated (synthetic ids on the generated ones), sorted by date, for display
}

export function computeProjection(
  data: AppDataV2,
  personId: string,
  payCycle: PayCycleConfig,
  horizon: ProjectionHorizon,
  asOfDate: Date = new Date(),
): ProjectionResult {
  const horizonEndDate = horizonRangeEnd(payCycle, horizon, asOfDate)
  const horizonEndIso = toIso(horizonEndDate)

  const person = data.people.find((p) => p.id === personId)
  // Opening balance is a visibility FLOOR, not just a starting number
  // (doc addendum): nothing dated before it should appear anywhere in
  // this person's ledger — there's no use seeing a payment that predates
  // the point the balance was actually reconciled from. Applied here, at
  // the one place `stored` gets assembled, so both the balance maths and
  // the displayed list stay consistent with each other automatically.
  //
  // EXCEPT a logged overpayment (loan or credit card lump payment) —
  // confirmed as a real bug, not just an edge case: a person retroactively
  // logging a real overpayment that happened to predate their opening
  // balance reconciliation point (routine when backfilling a loan's
  // history, or logging something from before they started using the
  // app) had it silently vanish from both the displayed ledger AND the
  // balance maths entirely — reproduced directly, confirmed by moving the
  // same transaction's date to either side of openingBalanceDate. Unlike
  // an old routine bill payment (genuinely fine to hide — it's already
  // baked into whatever opening balance was reconciled), an overpayment
  // is the person explicitly telling the app about a real, deliberate
  // cash event; silently dropping it means the app's own numbers stop
  // matching reality in exactly the way this whole engine exists to
  // prevent. So it's exempted from the floor specifically, not the floor
  // loosened generally — routine historical clutter should still hide.
  const stored = data.transactions.filter(
    (t) =>
      t.location === 'personal' &&
      t.ownerId === personId &&
      (t.date >= payCycle.openingBalanceDate || t.sourceType === 'loan_overpayment' || t.sourceType === 'loan_recurring_overpayment' || t.sourceType === 'credit_card_lump_payment'),
  )
  const existingKeys = new Set(stored.map(dedupeKey).filter((k): k is string => k !== null))

  // Generation starts from the CURRENT cycle's start, not from asOfDate —
  // otherwise a bill/loan/card payment whose nominal date already fell
  // earlier in the current cycle, but hasn't been separately materialized
  // into a real Transaction yet, would silently never appear anywhere.
  // Never generate anything before the opening balance date either, for
  // the same visibility-floor reason `stored` is filtered above.
  const cycleStart = cycleBoundsForDate(asOfDate, payCycle.cycleStartDayOfMonth).start
  const rangeStart = cycleStart > new Date(payCycle.openingBalanceDate) ? cycleStart : new Date(payCycle.openingBalanceDate)

  const generated: Omit<Transaction, 'id'>[] = []
  for (const template of data.recurringTemplates.filter((t) => t.location === 'personal' && t.ownerId === personId)) {
    generated.push(...generateTransactionsForTemplate(template, rangeStart, horizonEndDate))
  }
  for (const loan of data.loans.filter((l) => l.location === 'personal' && l.ownerId === personId && l.active)) {
    generated.push(...generateLoanPaymentTransactions(loan, rangeStart, horizonEndDate))
  }
  for (const card of data.creditCards.filter((c) => c.ownerId === personId)) {
    generated.push(...generateMinimumPaymentTransactions(card, rangeStart, horizonEndDate))
  }
  if (person) {
    generated.push(...generateSalaryTransactions(person, payCycle, rangeStart, horizonEndDate))
    generated.push(...generateSavingsContributions(person, payCycle, rangeStart, horizonEndDate))
  }
  // This person's share of every joint bill/loan — the piece that used to
  // be missing entirely (doc's flagged Joint/Household gap). Not scoped
  // by ownerId since joint items don't have a meaningful one; every joint
  // template/loan is split for whichever personId this projection is for.
  generated.push(...generateJointContributionTransactions(data, personId, rangeStart, horizonEndDate))

  const dedupedGenerated: Transaction[] = generated
    .filter((t) => {
      const key = dedupeKey(t)
      return key === null || !existingKeys.has(key)
    })
    .map((t) => ({ ...t, id: `generated:${nanoid(8)}` }))

  const combined = [...stored, ...dedupedGenerated]

  // clearedBalance reflects ALL cleared history, unbounded by the horizon
  // (a payment that already cleared last month still counts). The
  // horizon only bounds what counts toward pending, and what's included
  // in the returned display list below.
  const clearedBalance = round2(
    payCycle.openingBalance + combined.filter((t) => t.status === 'cleared' && isLedgerTransaction(t)).reduce((sum, t) => sum + signedAmount(t), 0),
  )

  const pendingWithinHorizon = combined.filter((t) => t.status === 'pending' && isLedgerTransaction(t) && t.date <= horizonEndIso)
  const projectedBalance = round2(clearedBalance + pendingWithinHorizon.reduce((sum, t) => sum + signedAmount(t), 0))

  return {
    horizon,
    horizonEnd: horizonEndIso,
    openingBalance: payCycle.openingBalance,
    clearedBalance,
    projectedBalance,
    // Bounded to the horizon window, same as the balance figures above —
    // a stored transaction dated beyond the current horizon (e.g. next
    // month's rent, already materialized ahead of time) is real data but
    // isn't part of THIS projection's view.
    transactions: combined
      .filter((t) => t.date <= horizonEndIso)
      .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1)),
  }
}

/** Month/cycle filtering (doc Section 4.1) — which of the given transactions fall inside [start, end] inclusive. */
export function transactionsInRange(transactions: Transaction[], start: Date, end: Date): Transaction[] {
  const s = toIso(start)
  const e = toIso(end)
  return transactions.filter((t) => t.date >= s && t.date <= e)
}
