// Salary as a dated history rather than one fixed figure (doc Section
// 3.4). Two things live here:
//  - computeNetPayForPeriod: what a given pay period's net pay actually
//    is — a manual SalaryOverride if one exists for that exact date,
//    otherwise the tax engine run against whichever SalarySnapshot was
//    effective on that date.
//  - generateSalaryTransactions: turns that into dated, pending 'salary'
//    Transaction occurrences, same "compute what should exist, caller
//    dedupes" contract as schedule.ts / ledgerLoans.ts / creditCards.ts.
//
// SIMPLIFICATION, stated explicitly: "Bonus" ad-hoc entries (TransactionType
// 'bonus', loggable from the Transactions page and the Salary page's "Attach a
// bonus to a pay" button) DO use this file's tax engine now — via
// computeNetBonusAmount below — to work out the correct net-of-tax amount
// from a gross figure. What they still don't do is get folded into a
// SalaryOverride or the generated 'salary' transaction for that period;
// the taxed net amount logs as its own standalone incoming transaction.
// Folding it into the payday transaction instead would mean either
// double-counting (if both existed) or silently rewriting a logged bonus
// into an invisible adjustment to a different transaction. A manual
// SalaryOverride remains the tool for "this period's net pay was actually
// £X"; a logged Bonus is "extra, properly-taxed money came in, on top of
// salary, without changing what salary itself shows as."

import { calculateBonusOnTop, calculateNetSalary, type BonusBreakdown, type SalaryInput } from './tax'
import { resolvePayday } from './payCycle'
import { INCOME_CATEGORY_ID } from '../types/ledger'
import type { Person, PayCycleConfig, SalarySnapshot, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100
import { toLocalIsoDate as toIso } from './date'

/** The snapshot effective on `date` — the latest one with effectiveFrom on or before it, never a future one. */
/**
 * The snapshot effective on `date` — the latest one with effectiveFrom on
 * or before it. When two snapshots share the exact same effectiveFrom
 * (which happens every time the same period gets edited more than once —
 * e.g. adjusting a pension %, saving "all future", then adjusting it
 * again), the one added MOST RECENTLY wins, not whichever happened to
 * sort first. A plain `.sort()` by date string alone is stable, which
 * for a genuine tie preserves original array order — since newly-added
 * snapshots are appended to the end of the array, that would silently
 * keep the OLDER edit as "applicable" and make the newer one invisible.
 * The explicit index tie-break below is what prevents that.
 */
export function findApplicableSnapshot(person: Person, date: string): SalarySnapshot | null {
  const applicable = person.salaryHistory
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s.effectiveFrom <= date)
    .sort((a, b) => {
      const byDate = b.s.effectiveFrom.localeCompare(a.s.effectiveFrom)
      if (byDate !== 0) return byDate
      return b.index - a.index // tie: prefer the one added later (a more recent edit)
    })
  return applicable[0]?.s ?? null
}

function snapshotToSalaryInput(snapshot: SalarySnapshot): SalaryInput {
  return {
    grossAnnual: snapshot.grossAnnual,
    taxCode: snapshot.taxCode,
    studentLoanPlan: snapshot.studentLoanPlan,
    payFrequency: snapshot.payFrequency,
    deductions: snapshot.deductions,
    employerPensionPercent: snapshot.employerPensionPercent,
  }
}

/**
 * Net value of a one-off GROSS bonus for this person, on this pay
 * period's snapshot — properly taxed, not face-value. The actual maths
 * lives in tax.ts's calculateBonusOnTop; see its comment for why the
 * bonus is charged tax and NI ONLY, with none of the person's standing
 * deductions applied to it, and why that's a correction rather than a
 * tweak.
 *
 * Returns null if there's no applicable snapshot for the period (same
 * "unanswerable, not zero" contract as computeNetPayForPeriod).
 */
export function computeBonusBreakdownForPeriod(person: Person, payPeriodDate: string, grossBonusAmount: number): BonusBreakdown | null {
  const snapshot = findApplicableSnapshot(person, payPeriodDate)
  if (!snapshot) return null
  return calculateBonusOnTop(snapshotToSalaryInput(snapshot), grossBonusAmount)
}

export function computeNetBonusAmount(person: Person, payPeriodDate: string, grossBonusAmount: number): number | null {
  if (grossBonusAmount <= 0) return 0
  const breakdown = computeBonusBreakdownForPeriod(person, payPeriodDate, grossBonusAmount)
  return breakdown === null ? null : round2(breakdown.net)
}

/**
 * The tax-engine-computed net pay for this period from the applicable
 * salary snapshot alone — deliberately ignoring any SalaryOverride. This
 * is the "base" figure a bonus gets added on top of, and what an override
 * reverts to when removed. Returns null when there's no applicable
 * snapshot at all.
 */
export function computeSnapshotNetPayForPeriod(person: Person, payPeriodDate: string): number | null {
  const snapshot = findApplicableSnapshot(person, payPeriodDate)
  if (!snapshot) return null
  return round2(calculateNetSalary(snapshotToSalaryInput(snapshot)).netPerPeriod)
}

/**
 * Net pay for a specific pay period date. Returns null only when there's
 * no applicable snapshot at all (person has no salary history yet as of
 * that date) — a genuinely unanswerable case, not a zero.
 */
export function computeNetPayForPeriod(person: Person, payPeriodDate: string): number | null {
  const override = person.salaryOverrides.find((o) => o.payPeriodDate === payPeriodDate)

  // A BONUS override is RECOMPUTED here rather than read back from its
  // stored netPayOverride. The stored figure is a snapshot of "base net
  // pay + net bonus" taken at the moment the bonus was attached, and it
  // goes stale the instant anything it was derived from changes — edit
  // the gross salary, a pension percentage, or the tax code afterwards
  // and the period keeps reporting a net pay computed against the OLD
  // salary, silently, with nothing in the UI hinting that the two no
  // longer agree. Deriving it makes that whole class of staleness
  // impossible; bonusGrossAmount (what the person actually typed) is the
  // only thing that genuinely needs storing. netPayOverride is still
  // written for backwards compatibility and for the plain manual
  // override case below, which has no formula to re-derive from.
  if (override?.bonusGrossAmount) {
    const base = computeSnapshotNetPayForPeriod(person, payPeriodDate)
    const netBonus = computeNetBonusAmount(person, payPeriodDate, override.bonusGrossAmount)
    if (base !== null && netBonus !== null) return round2(base + netBonus)
  }

  if (override) return round2(override.netPayOverride)

  return computeSnapshotNetPayForPeriod(person, payPeriodDate)
}

/** Generates pending 'salary' transactions for each resolved payday in the range. Skips any period with no applicable snapshot rather than emitting a zero-amount transaction. */
export function generateSalaryTransactions(person: Person, payCycle: PayCycleConfig, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  const results: Omit<Transaction, 'id'>[] = []
  let cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)

  while (cursor <= rangeEnd) {
    const payday = resolvePayday(cursor.getFullYear(), cursor.getMonth(), payCycle.paydayDayOfMonth, payCycle.paydayAdjustForNonWorkingDay)
    if (payday >= rangeStart && payday <= rangeEnd) {
      const dateIso = toIso(payday)
      const netPay = computeNetPayForPeriod(person, dateIso)
      if (netPay !== null && netPay > 0) {
        results.push({
          date: dateIso,
          amount: netPay,
          direction: 'in',
          categoryId: INCOME_CATEGORY_ID,
          paymentMethod: 'bank_transfer',
          status: 'pending',
          type: 'salary',
          location: 'personal',
          ownerId: person.id,
          personId: person.id,
        })
      }
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return results
}

// ── Upcoming / closed payday lists — Salary page redesign ─────────────
// "Upcoming" = strictly after `fromDate` (today) — the moment a payday's
// date arrives, it's no longer upcoming, it's paid (closed). "Closed" =
// on or before `beforeDate`. Both walk month-by-month using the same
// resolvePayday logic everything else uses, so these lists are always
// consistent with the actual weekend/bank-holiday-adjusted payday, not
// just the nominal day-of-month.

export function upcomingPaydays(payCycle: PayCycleConfig, fromDate: Date, count: number): Date[] {
  const results: Date[] = []
  let cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1)
  let guard = 0
  while (results.length < count && guard < 120) {
    const payday = resolvePayday(cursor.getFullYear(), cursor.getMonth(), payCycle.paydayDayOfMonth, payCycle.paydayAdjustForNonWorkingDay)
    if (payday > fromDate) results.push(payday)
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    guard++
  }
  return results
}

/**
 * The last `count` closed (already-paid) paydays before `beforeDate`.
 * Never walks back past the pay cycle's opening balance date — there's
 * no use showing payday history from before the point the balance was
 * actually reconciled from, same visibility-floor reasoning as
 * everywhere else opening balance applies.
 */
export function closedPaydays(payCycle: PayCycleConfig, beforeDate: Date, count: number): Date[] {
  const results: Date[] = []
  const openingBalanceDate = new Date(payCycle.openingBalanceDate)
  const floorMonth = new Date(openingBalanceDate.getFullYear(), openingBalanceDate.getMonth(), 1)
  let cursor = new Date(beforeDate.getFullYear(), beforeDate.getMonth(), 1)
  let guard = 0
  while (results.length < count && guard < 120 && cursor >= floorMonth) {
    const payday = resolvePayday(cursor.getFullYear(), cursor.getMonth(), payCycle.paydayDayOfMonth, payCycle.paydayAdjustForNonWorkingDay)
    if (payday <= beforeDate && payday >= openingBalanceDate) results.push(payday)
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1)
    guard++
  }
  // Walked backward, so the closest-to-today payday was collected first — reverse to chronological (oldest first, most recent last).
  return results.reverse()
}
