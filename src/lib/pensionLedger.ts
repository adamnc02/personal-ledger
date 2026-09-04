// Pension as its own scheduled income source (backlog item c). Deliberately
// a SEPARATE small implementation from schedule.ts's RecurringTemplate
// walker rather than forcing Pension through it — schedule.ts's functions
// read RecurringTemplate-only fields throughout (categoryId, paymentMethod,
// location, payee, payeeSharePercent, kind), none of which Pension has, and
// genericizing that file would touch the Bills/Expenses pipeline it's
// already load-bearing for. The date-walking ALGORITHM is intentionally
// identical (same frequency stepping, same amount-history resolution, same
// occurrence-override shape) — only the field set differs — so this file
// mirrors schedule.ts's structure closely on purpose, the same way
// salaryLedger.ts and savingsLedger.ts each already implement their own
// variant of "walk paydays forward" rather than sharing one.

import { addMonths, addQuarters, addWeeks, addYears, addDays, startOfDay } from 'date-fns'
import { toLocalIsoDate as toIso } from './date'
import { adjustToWorkingDay, cycleBoundsForDate } from './payCycle'
import { INCOME_CATEGORY_ID } from '../types/ledger'
import type { AppDataV2, PayCycleConfig, Pension, RecurrenceFrequency, Transaction } from '../types/ledger'

const MAX_OCCURRENCES = 2000

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}

function clampToAnchorDay(date: Date, anchorDay: number): Date {
  const day = Math.min(anchorDay, daysInMonth(date.getFullYear(), date.getMonth()))
  return new Date(date.getFullYear(), date.getMonth(), day)
}

function nextOccurrence(current: Date, frequency: RecurrenceFrequency, intervalWeeks: number | undefined, anchorDay: number): Date {
  switch (frequency) {
    case 'weekly':
      return addWeeks(current, 1)
    case 'every_n_weeks':
      return addWeeks(current, Math.max(1, intervalWeeks ?? 1))
    case 'monthly':
      return clampToAnchorDay(addMonths(current, 1), anchorDay)
    case 'quarterly':
      return clampToAnchorDay(addQuarters(current, 1), anchorDay)
    case 'annual':
      return clampToAnchorDay(addYears(current, 1), anchorDay)
  }
}

/**
 * What `pension.amount` resolves to on a specific date — identical logic
 * to schedule.ts's resolveTemplateAmount (see that function's comment for
 * the full reasoning on the tie-break rule), against Pension's fields.
 */
export function resolvePensionAmount(pension: Pension, dateIso: string): number {
  const candidates: { effectiveFrom: string; amount: number }[] = [...(pension.amountHistory ?? [])]
  if (pension.amountEffectiveFrom) candidates.push({ effectiveFrom: pension.amountEffectiveFrom, amount: pension.amount })
  if (candidates.length === 0) return pension.amount

  const applicable = candidates
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.effectiveFrom <= dateIso)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.index - a.index)
  return applicable[0]?.amount ?? pension.amount
}

export interface RawPensionOccurrence {
  originalDate: string
  date: string
  amount: number
}

function walkPensionOccurrences(pension: Pension, rangeStart: Date, rangeEnd: Date): RawPensionOccurrence[] {
  if (!pension.active) return []
  if (rangeEnd < rangeStart) return []

  const anchor = new Date(pension.anchorDate)
  const anchorDay = anchor.getDate()

  let cursor = anchor
  let iterations = 0
  while (cursor < rangeStart && iterations < MAX_OCCURRENCES) {
    cursor = nextOccurrence(cursor, pension.frequency, pension.intervalWeeks, anchorDay)
    iterations++
  }

  const results: RawPensionOccurrence[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    const originalDate = toIso(cursor)
    const override = pension.occurrenceOverrides?.find((o) => o.originalDate === originalDate)
    if (!override?.deleted) {
      // Weekend/bank-holiday adjustment applies to the NOMINAL schedule
      // position, same as salary's resolvePayday — originalDate itself
      // stays the pure, unadjusted anchor (the override system's key),
      // only the displayed/effective `date` shifts. An explicit
      // per-occurrence override (edited date) always wins outright — it
      // already represents a deliberate, specific choice for that one
      // payment, so applying adjustment on top of it would be
      // second-guessing something the person just typed in themselves.
      const defaultDate = pension.adjustForNonWorkingDay ? toIso(adjustToWorkingDay(cursor)) : originalDate
      results.push({
        originalDate,
        date: override?.date ?? defaultDate,
        amount: override?.amount ?? resolvePensionAmount(pension, originalDate),
      })
    }
    cursor = nextOccurrence(cursor, pension.frequency, pension.intervalWeeks, anchorDay)
    iterations++
  }

  return results
}

/** Generates pending 'pension_income' transactions for every occurrence in the range — same "compute what should exist, caller dedupes" contract as schedule.ts/salaryLedger.ts/creditCards.ts. */
export function generatePensionTransactions(pension: Pension, rangeStart: Date, rangeEnd: Date): Omit<Transaction, 'id'>[] {
  return walkPensionOccurrences(pension, rangeStart, rangeEnd).map((occ) => ({
    date: occ.date,
    amount: occ.amount,
    direction: 'in',
    categoryId: INCOME_CATEGORY_ID,
    paymentMethod: 'bank_transfer',
    status: 'pending',
    type: 'pension_income',
    location: 'personal',
    ownerId: pension.personId,
    personId: pension.personId,
    sourceType: 'pension',
    sourceId: pension.id,
    note: pension.name,
  }))
}

/** Every upcoming occurrence, WITH its original scheduled date — Wallet.tsx's "next N upcoming payments as editable pills" needs this, same reason schedule.ts's templateOccurrencePreviews exists. */
export function pensionOccurrencePreviews(pension: Pension, asOfDate: Date, count: number): RawPensionOccurrence[] {
  return walkPensionOccurrences(pension, asOfDate, addYears(asOfDate, 15)).slice(0, count)
}

/** Every calendar date the pension's frequency would land on, ignoring occurrenceOverrides entirely — same purpose as schedule.ts's scheduledTemplateDates (Phase 4), just against Pension's own recurrence rule. */
export function scheduledPensionDates(pension: Pension, rangeStart: Date, rangeEnd: Date): string[] {
  if (rangeEnd < rangeStart) return []
  const anchor = new Date(pension.anchorDate)
  const anchorDay = anchor.getDate()
  let cursor = anchor
  let iterations = 0
  while (cursor < rangeStart && iterations < MAX_OCCURRENCES) {
    cursor = nextOccurrence(cursor, pension.frequency, pension.intervalWeeks, anchorDay)
    iterations++
  }
  const results: string[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    results.push(toIso(cursor))
    cursor = nextOccurrence(cursor, pension.frequency, pension.intervalWeeks, anchorDay)
    iterations++
  }
  return results
}

/** Reconciles occurrenceOverrides against a full desired-pause-set from the picker — identical logic to schedule.ts's setPausedTemplateOccurrences/savingsPotLedger.ts's setPausedDeposits (Phase 4). */
export function setPausedPensionOccurrences(pension: Pension, windowDates: string[], pausedDates: string[]): Pick<Pension, 'occurrenceOverrides'> {
  const windowSet = new Set(windowDates)
  const pausedSet = new Set(pausedDates)
  const untouched = (pension.occurrenceOverrides ?? []).filter((o) => !windowSet.has(o.originalDate) || o.date !== undefined || o.amount !== undefined)
  const newPauses = [...pausedSet].map((originalDate) => ({ originalDate, deleted: true }))
  return { occurrenceOverrides: [...untouched, ...newPauses] }
}

/** Builds the patch for "change the standing amount, effective from a chosen upcoming payment" — mirrors schedule.ts's applyTemplateAmountChange exactly, against Pension's fields. */
export function applyPensionAmountChange(pension: Pension, newAmount: number, effectiveFrom: string): Pick<Pension, 'amount' | 'amountEffectiveFrom' | 'amountHistory'> {
  const priorEntry = { effectiveFrom: pension.amountEffectiveFrom ?? pension.anchorDate, amount: pension.amount }
  return {
    amount: newAmount,
    amountEffectiveFrom: effectiveFrom,
    amountHistory: [...(pension.amountHistory ?? []), priorEntry],
  }
}

/** Convenience constructor for a new pension with sensible defaults, same role as schedule.ts's newRecurringTemplate. */
export function newPension(input: {
  personId: string
  name: string
  amount: number
  frequency: RecurrenceFrequency
  intervalWeeks?: number
  anchorDate: string
  adjustForNonWorkingDay?: boolean
  cycleStartFollowsPayday?: boolean
}): Omit<Pension, 'id'> {
  return {
    personId: input.personId,
    name: input.name,
    amount: input.amount,
    frequency: input.frequency,
    intervalWeeks: input.intervalWeeks,
    anchorDate: input.anchorDate,
    active: true,
    adjustForNonWorkingDay: input.adjustForNonWorkingDay ?? false,
    cycleStartFollowsPayday: input.cycleStartFollowsPayday ?? false,
  }
}

// ── Cycle boundaries when a pension is the followed income source ─────
// payCycle.ts's own paydayCycleBounds is fundamentally day-of-month
// shaped (resolvePayday walks whole MONTHS) — it has no way to express
// a weekly or every-N-weeks schedule at all. Rather than bolt that onto
// payCycle.ts (which stays foundational date/holiday math, no knowledge
// of Pension or AppDataV2), this reuses the SAME "collect a wide window
// of resolved occurrences, pick the true predecessor of the reference
// date" strategy generically, via walkPensionOccurrences — which already
// handles every RecurrenceFrequency shape uniformly.

/**
 * Cycle bounds anchored to a specific pension's OWN resolved payday
 * schedule — only meaningful when pension.cycleStartFollowsPayday is
 * true (see resolveCycleBounds, which is what actually decides whether
 * to call this or fall back to a fixed day-of-month boundary).
 * occurrenceOverrides are deliberately ignored here (a structural/
 * calendar concept shouldn't shift because one specific payment got
 * hand-edited) — same reasoning payCycle.ts's own boundary math never
 * has to state explicitly, since salary has no per-occurrence override
 * concept to ignore in the first place.
 */
export function pensionCycleBounds(referenceDate: Date, pension: Pension): { start: Date; end: Date } {
  const ref = startOfDay(referenceDate)
  const structural = { ...pension, occurrenceOverrides: undefined }

  // A window wide enough for the slowest frequency (annual) to still
  // bracket `ref` on both sides, mirroring payCycle.ts's own ±3-month
  // window reasoning for the monthly case.
  const rangeStart = addYears(ref, -2)
  const rangeEnd = addYears(ref, 2)
  const dates = walkPensionOccurrences(structural, rangeStart, rangeEnd).map((occ) => new Date(occ.date))
  dates.sort((a, b) => a.getTime() - b.getTime())

  if (dates.length === 0) {
    // No occurrences at all in range (e.g. an inactive pension somehow
    // still selected as the follow target) — fall back to a plain
    // calendar-month window around ref rather than producing an
    // unbounded/empty result.
    return { start: new Date(ref.getFullYear(), ref.getMonth(), 1), end: new Date(ref.getFullYear(), ref.getMonth() + 1, 0) }
  }

  let start = dates[0]
  let next = dates[dates.length - 1]
  for (let i = 0; i < dates.length; i++) {
    if (dates[i].getTime() <= ref.getTime()) {
      start = dates[i]
      next = dates[i + 1] ?? addYears(dates[i], 1)
    }
  }
  return { start, end: addDays(next, -1) }
}

/**
 * THE function everything in the app should call for "this person's
 * current cycle window" — resolves which income source governs
 * (payCycle.followsIncomeSource, defaulting to salary) and computes
 * bounds accordingly:
 *  - Following salary, or cycleStartFollowsPayday is off for the
 *    followed pension: the existing, unchanged fixed/salary-payday
 *    boundary math in payCycle.ts's cycleBoundsForDate — zero behaviour
 *    change for anyone not actively following a pension with this
 *    switched on.
 *  - Following a pension with cycleStartFollowsPayday on: that
 *    pension's own resolved schedule, via pensionCycleBounds above.
 * Every call site that used to call cycleBoundsForDate(date, payCycle)
 * directly for a PERSON's own cycle (not a fixed/bare-number boundary)
 * should call this instead — see payCycle.ts, projection.ts,
 * purchaseImpact.ts, Home.tsx for the call sites this replaced.
 */
export function resolveCycleBounds(data: AppDataV2, personId: string, referenceDate: Date): { start: Date; end: Date } {
  const payCycle = data.payCycles.find((pc) => pc.personId === personId)
  const fallbackSpec: PayCycleConfig = payCycle ?? {
    personId,
    openingBalance: 0,
    openingBalanceDate: toIso(referenceDate),
    paydayDayOfMonth: 28,
    paydayAdjustForNonWorkingDay: true,
    cycleStartDayOfMonth: 1,
  }

  const follows = fallbackSpec.followsIncomeSource
  if (follows?.type === 'pension') {
    const pension = data.pensions.find((p) => p.id === follows.pensionId && p.personId === personId)
    if (pension) {
      if (!pension.cycleStartFollowsPayday) {
        // Fixed day-of-month boundary — cycleStartDayOfMonth is a
        // person-level number, unrelated to which source is followed,
        // so this is the same math as the salary case, just forced onto
        // the "fixed" branch regardless of what cycleStartFollowsPayday
        // says elsewhere on the person's own PayCycleConfig.
        return cycleBoundsForDate(referenceDate, { ...fallbackSpec, cycleStartFollowsPayday: false })
      }
      return pensionCycleBounds(referenceDate, pension)
    }
    // Dangling reference (pension deleted without the reconciliation in
    // LedgerContext's removePension running yet, or similar edge case)
    // — fall through to the salary/fixed path below rather than throw.
  }
  return cycleBoundsForDate(referenceDate, fallbackSpec)
}
