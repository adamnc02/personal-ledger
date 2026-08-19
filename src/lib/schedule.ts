// Expands a RecurringTemplate's frequency into individual, pending
// Transaction occurrences within a date range (doc Section 3.1 / 4.1:
// "Rebuild" classification — replaces the old app's implicit "monthly,
// due day N" assumption with a real frequency model). Pure/idempotent:
// callers are responsible for deduping against transactions that already
// exist for a given (sourceId, date) pair before inserting the result —
// this file only computes what SHOULD exist in the range, it doesn't
// know what's already been generated.

import { addMonths, addQuarters, addWeeks, addYears } from 'date-fns'
import { nanoid } from 'nanoid'
import type { RecurringTemplate, Transaction } from '../types/ledger'

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}

/** Re-applies the anchor date's day-of-month to `date`, clamped to that month's real length (e.g. anchor day 31 in a 30-day month lands on the 30th). */
function clampToAnchorDay(date: Date, anchorDay: number): Date {
  const day = Math.min(anchorDay, daysInMonth(date.getFullYear(), date.getMonth()))
  return new Date(date.getFullYear(), date.getMonth(), day)
}

function nextOccurrence(current: Date, template: RecurringTemplate, anchorDay: number): Date {
  switch (template.frequency) {
    case 'weekly':
      return addWeeks(current, 1)
    case 'every_n_weeks':
      return addWeeks(current, Math.max(1, template.intervalWeeks ?? 1))
    case 'monthly':
      return clampToAnchorDay(addMonths(current, 1), anchorDay)
    case 'quarterly':
      return clampToAnchorDay(addQuarters(current, 1), anchorDay)
    case 'annual':
      return clampToAnchorDay(addYears(current, 1), anchorDay)
  }
}

import { toLocalIsoDate as toIso } from './date'

// Sanity cap on iterations, independent of the date range — protects
// against a pathological template (e.g. every_n_weeks with an
// accidental interval of 0) spinning forever rather than just returning
// an empty/short result.
const MAX_OCCURRENCES = 2000

/**
 * What `template.amount` resolves to on a specific date, accounting for a
 * scheduled change recorded via amountEffectiveFrom/amountHistory (Bills.tsx's
 * "which payment should this apply from" picker). Mirrors
 * salaryLedger.ts's findApplicableSnapshot: every past value is checked
 * as a candidate, and whichever one's effectiveFrom is the latest that's
 * still on-or-before `dateIso` wins — including the CURRENT amount
 * itself, via its own amountEffectiveFrom, competing on equal footing
 * with the historical entries rather than being asserted as always-latest.
 */
export function resolveTemplateAmount(template: RecurringTemplate, dateIso: string): number {
  const candidates: { effectiveFrom: string; amount: number }[] = [...(template.amountHistory ?? [])]
  if (template.amountEffectiveFrom) candidates.push({ effectiveFrom: template.amountEffectiveFrom, amount: template.amount })

  if (candidates.length === 0) return template.amount

  const applicable = candidates.filter((c) => c.effectiveFrom <= dateIso).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
  // dateIso predates every recorded change (e.g. asking about a date
  // before the bill's own history begins) — the current amount is the
  // only reasonable answer left, same as an untouched template.
  return applicable[0]?.amount ?? template.amount
}

export function generateTransactionsForTemplate(
  template: RecurringTemplate,
  rangeStart: Date,
  rangeEnd: Date,
): Omit<Transaction, 'id'>[] {
  if (!template.active) return []
  if (rangeEnd < rangeStart) return []

  const anchor = new Date(template.anchorDate)
  const anchorDay = anchor.getDate()

  let cursor = anchor
  let iterations = 0
  // Walk forward from the anchor to the start of the range without
  // emitting anything — the anchor itself may be years in the past.
  while (cursor < rangeStart && iterations < MAX_OCCURRENCES) {
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }

  const results: Omit<Transaction, 'id'>[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    const dateIso = toIso(cursor)
    results.push({
      date: dateIso,
      amount: resolveTemplateAmount(template, dateIso),
      direction: 'out',
      categoryId: template.categoryId,
      paymentMethod: template.paymentMethod,
      status: 'pending',
      type: 'bill_payment',
      location: template.location,
      ownerId: template.ownerId,
      payee: template.payee,
      payeeSharePercent: template.payeeSharePercent,
      sourceType: 'recurring_template',
      sourceId: template.id,
      // The specific bill's own name — without this, a row falls back to
      // its category's name for display, which duplicates the category
      // group header when viewed grouped by category (e.g. a "TV"
      // category group whose own rows also just say "TV" instead of
      // "TV License").
      note: template.name,
    })
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }

  return results
}

/**
 * Builds the patch to apply when a bill's amount changes and the person
 * has picked which payment it should take effect from (Bills.tsx's
 * follow-up picker) — preserves the OLD amount as a history entry so
 * anything before `effectiveFrom` keeps resolving to it, exactly as
 * salaryLedger.ts's snapshot list does for a pay rise.
 */
export function applyTemplateAmountChange(
  template: RecurringTemplate,
  newAmount: number,
  effectiveFrom: string,
): Pick<RecurringTemplate, 'amount' | 'amountEffectiveFrom' | 'amountHistory'> {
  const priorEntry = { effectiveFrom: template.amountEffectiveFrom ?? template.anchorDate, amount: template.amount }
  return {
    amount: newAmount,
    amountEffectiveFrom: effectiveFrom,
    amountHistory: [...(template.amountHistory ?? []), priorEntry],
  }
}

/**
 * The most recent past occurrence (if any) and the next 3 upcoming ones,
 * for Bills.tsx's "apply this change from which payment?" picker —
 * always computed from the template's CURRENT schedule shape (frequency/
 * anchor), independent of any amount history, since which DATES a bill
 * falls on doesn't change just because its amount did.
 */
export function recentAndUpcomingOccurrences(template: RecurringTemplate, asOfDate: Date): { date: string; isPast: boolean }[] {
  const past = generateTransactionsForTemplate(template, addYears(asOfDate, -1), asOfDate)
  const upcoming = generateTransactionsForTemplate(template, asOfDate, addYears(asOfDate, 1)).filter((t) => t.date !== past.at(-1)?.date)

  const result: { date: string; isPast: boolean }[] = []
  if (past.length > 0) result.push({ date: past[past.length - 1].date, isPast: true })
  for (const t of upcoming.slice(0, 3)) result.push({ date: t.date, isPast: false })
  return result
}

/** Convenience constructor for a new template with sensible defaults for fields the create form doesn't ask about directly. */
export function newRecurringTemplate(
  input: Omit<RecurringTemplate, 'id' | 'active'>,
): RecurringTemplate {
  return { id: nanoid(8), active: true, ...input }
}
