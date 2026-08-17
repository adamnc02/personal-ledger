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
    results.push({
      date: toIso(cursor),
      amount: template.amount,
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

/** Convenience constructor for a new template with sensible defaults for fields the create form doesn't ask about directly. */
export function newRecurringTemplate(
  input: Omit<RecurringTemplate, 'id' | 'active'>,
): RecurringTemplate {
  return { id: nanoid(8), active: true, ...input }
}
