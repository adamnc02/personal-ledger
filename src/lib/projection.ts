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

/**
 * How many cycles AHEAD of the current one the `three_cycles` horizon
 * covers. The window is the current cycle plus this many more, so the
 * label "Next 3 cycles" names the three genuinely-upcoming ones rather
 * than counting the part-elapsed current cycle among them.
 */
export const THREE_CYCLES_AHEAD = 3

/** Every cycle window inside the horizon, in order, starting with the one containing `asOfDate`. The Summary page's cycle-end grouping folds its rows against exactly these bounds, so grouping and totals can't disagree with the horizon they're drawn from. */
export function horizonCycles(payCycle: PayCycleConfig, horizon: ProjectionHorizon, asOfDate: Date): { start: Date; end: Date }[] {
  const cycles = [cycleBoundsForDate(asOfDate, payCycle)]
  if (horizon === 'current_cycle') return cycles

  for (let i = 0; i < THREE_CYCLES_AHEAD; i++) {
    cycles.push(cycleBoundsForDate(addDays(cycles[cycles.length - 1].end, 1), payCycle))
  }
  return cycles
}

/** The end of the projection window: the current cycle's end, or the end of the last cycle in the horizon (current + THREE_CYCLES_AHEAD). */
export function horizonRangeEnd(payCycle: PayCycleConfig, horizon: ProjectionHorizon, asOfDate: Date): Date {
  const cycles = horizonCycles(payCycle, horizon, asOfDate)
  return cycles[cycles.length - 1].end
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
  return {
    horizon,
    ...computeProjectionToDate(data, personId, payCycle, horizonRangeEnd(payCycle, horizon, asOfDate), asOfDate),
  }
}

/**
 * The same projection, but bounded by an EXPLICIT end date rather than
 * one of the two named horizons.
 *
 * Exists for the What-if "buy something" action, which needs the balance
 * on an arbitrary chosen date (and at the end of whichever cycle that
 * date falls in) — a date that can easily sit beyond `three_cycles`, and
 * which almost never coincides with a cycle end. Extracted rather than
 * reimplemented specifically so a purchase is measured against the exact
 * same generated occurrences, dedupe rules, and visibility floor as every
 * figure on the Summary page; a parallel implementation would be free to
 * drift from the real one, which is the failure mode this whole engine
 * exists to prevent.
 *
 * computeProjection is now a thin wrapper over this, so the two can't
 * disagree by construction.
 */
export function computeProjectionToDate(
  data: AppDataV2,
  personId: string,
  payCycle: PayCycleConfig,
  horizonEndDate: Date,
  asOfDate: Date = new Date(),
): Omit<ProjectionResult, 'horizon'> {
  const horizonEndIso = toIso(horizonEndDate)

  const person = data.people.find((p) => p.id === personId)
  // Opening balance is a visibility FLOOR, not just a starting number
  // (doc addendum): nothing dated before it should appear anywhere in
  // this person's ledger — there's no use seeing a payment that predates
  // the point the balance was actually reconciled from. Applied here, at
  // the one place `stored` gets assembled, so both the balance maths and
  // the displayed list stay consistent with each other automatically.
  //
  // This floor applies to EVERYTHING, overpayments included. An earlier
  // revision exempted loan overpayments and credit card lump payments
  // from it, to stop a retroactively-logged overpayment "vanishing" —
  // but that exemption was both unbounded and aimed at the wrong target,
  // and produced a worse bug than the one it fixed. Reproduced directly:
  // a £40 overpayment dated 2025-02-22 against an opening balance
  // reconciled at 2026-08-22 moved clearedBalance from £570.95 to
  // £530.95 — cash counted as leaving the account eighteen months AFTER
  // it actually did, and already inside the reconciled opening figure.
  // That's double-counting, which is precisely what a reconciliation
  // point exists to prevent.
  //
  // The original concern was real but belongs elsewhere: an overpayment
  // still has to affect the LOAN, and it does, independently of this
  // file. buildLoanSchedule reads loan.overpayments directly (see
  // ledgerLoans.ts) and cardBalanceAsOf replays against the card's own
  // balanceAsOfDate anchor — neither consults payCycle.openingBalanceDate
  // at all. Verified by scripts/verify-overpayment-independence.ts: the
  // same £40 still reduces Home Improvements' capitalRemaining by £40
  // with this exemption gone. So the overpayment keeps every effect it
  // legitimately has; all it loses is a place in a personal cash ledger
  // that had already accounted for it.
  //
  // An overpayment dated on or after the opening balance date is
  // unaffected and lands in cleared exactly as before, which is the
  // ordinary case — log a loan today, overpay it in a fortnight, and it
  // clears normally.
  const stored = data.transactions.filter((t) => t.location === 'personal' && t.ownerId === personId && t.date >= payCycle.openingBalanceDate)
  const existingKeys = new Set(stored.map(dedupeKey).filter((k): k is string => k !== null))

  // Generation starts from the CURRENT cycle's start, not from asOfDate —
  // otherwise a bill/loan/card payment whose nominal date already fell
  // earlier in the current cycle, but hasn't been separately materialized
  // into a real Transaction yet, would silently never appear anywhere.
  // Never generate anything before the opening balance date either, for
  // the same visibility-floor reason `stored` is filtered above.
  const cycleStart = cycleBoundsForDate(asOfDate, payCycle).start
  const rangeStart = cycleStart > new Date(payCycle.openingBalanceDate) ? cycleStart : new Date(payCycle.openingBalanceDate)

  const generated: Omit<Transaction, 'id'>[] = []
  for (const template of data.recurringTemplates.filter((t) => t.location === 'personal' && t.ownerId === personId)) {
    generated.push(...generateTransactionsForTemplate(template, rangeStart, horizonEndDate))
  }
  for (const loan of data.loans.filter((l) => l.location === 'personal' && l.ownerId === personId && l.active)) {
    generated.push(...generateLoanPaymentTransactions(loan, rangeStart, horizonEndDate))
  }
  for (const card of data.creditCards.filter((c) => c.ownerId === personId)) {
    // Full transaction list, not the person-scoped `stored` one: the
    // card's derived balance has to see every payment and spend against
    // that card, and the visibility floor applied to `stored` above is a
    // display rule for the personal ledger, not a statement of what the
    // card actually owes.
    generated.push(...generateMinimumPaymentTransactions(card, rangeStart, horizonEndDate, data.transactions))
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
