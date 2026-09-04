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
import type { PayCycleConfig, RecurringTemplate, Transaction } from '../types/ledger'
import { upcomingPaydays } from './salaryLedger'
import { nextCycleStartAfter } from './payCycle'
import { categoryForTransfer } from './transferLedger'

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
 *
 * Ties (two candidates sharing the exact same effectiveFrom) are broken
 * by RECENCY OF RECORDING, not by date alone — confirmed as a real,
 * not-just-theoretical bug: applyTemplateAmountChange's own "prior value"
 * entry falls back to `template.anchorDate` the first time a bill is ever
 * edited (see that function's comment), and a bill's anchor date is
 * routinely the exact same date the person picks in the "apply from"
 * picker — it's usually the very first, most natural option shown,
 * especially for a bill that hasn't had a real occurrence yet. That
 * collision is not an edge case: it's the single most common edit (drop
 * the amount, apply "from the very next payment"), and without this,
 * whichever candidate happened to land first in the array — always the
 * STALE one, since the true current value is appended last — silently
 * and permanently won every date it was asked about, making the edit the
 * person just made never show up anywhere. `candidates` is built in
 * strict chronological-recording order (amountHistory entries in the
 * order they were appended, then the live amount/amountEffectiveFrom
 * pair last, since that's always the most recent decision) — so on a
 * tie, the LATER array index is the more-recently-recorded, and
 * therefore more authoritative, statement about that date.
 */
export function resolveTemplateAmount(template: RecurringTemplate, dateIso: string): number {
  const candidates: { effectiveFrom: string; amount: number }[] = [...(template.amountHistory ?? [])]
  if (template.amountEffectiveFrom) candidates.push({ effectiveFrom: template.amountEffectiveFrom, amount: template.amount })

  if (candidates.length === 0) return template.amount

  const applicable = candidates
    .map((c, index) => ({ ...c, index }))
    .filter((c) => c.effectiveFrom <= dateIso)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.index - a.index)
  // dateIso predates every recorded change (e.g. asking about a date
  // before the bill's own history begins) — the current amount is the
  // only reasonable answer left, same as an untouched template.
  return applicable[0]?.amount ?? template.amount
}

export interface RawOccurrence {
  originalDate: string // the naturally-scheduled date, before any per-occurrence override
  date: string // the displayed/effective date — same as originalDate unless overridden
  amount: number
}

/**
 * Walks a template's frequency/anchorDate forward across [rangeStart,
 * rangeEnd] and returns every occurrence — shared by
 * generateTransactionsForTemplate (which turns these into full
 * Transaction shapes) and templateOccurrencePreviews (which needs the
 * ORIGINAL date alongside the resolved one, for Expenses.tsx's
 * per-occurrence edit/delete UI). A 'transaction'-kind template's
 * occurrenceOverrides are applied here, once, so both callers see
 * exactly the same resolved schedule — a deleted occurrence is dropped
 * entirely, an edited one carries its overridden date/amount. Templates
 * with kind 'bill' (or absent) never carry occurrenceOverrides, so this
 * is a no-op for them.
 */
function walkOccurrences(template: RecurringTemplate, rangeStart: Date, rangeEnd: Date): RawOccurrence[] {
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

  const results: RawOccurrence[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    const originalDate = toIso(cursor)
    const override = template.occurrenceOverrides?.find((o) => o.originalDate === originalDate)
    if (!override?.deleted) {
      results.push({
        originalDate,
        date: override?.date ?? originalDate,
        amount: override?.amount ?? resolveTemplateAmount(template, originalDate),
      })
    }
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }

  return results
}

/**
 * `payCycle` is only used for a `kind: 'transfer'` template with
 * `followsPayday: true` OR `followsCycleStart: true` — every other kind
 * ignores it entirely, so existing callers that don't have one to hand
 * (or are generating for a pot/joint account rather than the primary
 * person) can keep omitting it. See TransferLocation/RecurringTemplate.
 * followsPayday/followsCycleStart in types/ledger.ts for the full
 * reasoning. If a template somehow has both set, followsPayday wins —
 * the two are meant to be mutually exclusive (enforced by the UI), this
 * is just a defined tie-break rather than an unreachable branch.
 */
export function generateTransactionsForTemplate(
  template: RecurringTemplate,
  rangeStart: Date,
  rangeEnd: Date,
  payCycle?: PayCycleConfig,
): Omit<Transaction, 'id'>[] {
  const isTransactionKind = template.kind === 'transaction'
  const isTransferKind = template.kind === 'transfer'
  const isIncome = isTransactionKind && template.recurringTransactionType === 'income'
  const fromLoc = isTransferKind ? template.transferFrom : undefined
  const toLoc = isTransferKind ? template.transferTo : undefined

  return walkOccurrences(template, rangeStart, rangeEnd).map((occ) => {
    // A follows-payday transfer resolves its date against the actual
    // payday on/after the naturally-walked date, rather than using that
    // date directly — this is what lets a transfer "land on payday" even
    // when payday itself drifts (weekends/bank holidays, non-monthly pay
    // frequencies). Falls back to the natural date if no payCycle was
    // supplied. A follows-cycle-start transfer does the same against the
    // person's budgeting-cycle boundary instead (Salary Sorter session,
    // 2026-09) — for someone whose cycle doesn't track payday
    // (PayCycleConfig.cycleStartFollowsPayday can differ from payday
    // entirely). followsPayday takes precedence if both are somehow set.
    const date =
      isTransferKind && template.followsPayday && payCycle
        ? toIso(upcomingPaydays(payCycle, new Date(occ.date), 1)[0] ?? new Date(occ.date))
        : isTransferKind && template.followsCycleStart && payCycle
          ? toIso(nextCycleStartAfter(new Date(occ.date), payCycle))
          : occ.date

    return {
      date,
      amount: occ.amount,
      direction: isTransferKind ? (fromLoc?.type === 'personal' ? 'out' : 'in') : isTransactionKind ? (isIncome ? 'in' : 'out') : 'out',
      categoryId: isTransferKind ? categoryForTransfer(fromLoc, toLoc) : template.categoryId,
      paymentMethod: template.paymentMethod,
      status: 'pending',
      type: isTransferKind ? 'transfer' : isTransactionKind ? template.recurringTransactionType! : 'bill_payment',
      location: template.location,
      ownerId: template.ownerId,
      payee: template.payee,
      payeeSharePercent: template.payeeSharePercent,
      // Pots backlog item (2026-09-03) — carried straight through only
      // when this template is actually pot-located (a pot-funded bill),
      // OR (2026-09-04) when this is a transfer with a pot on either
      // end — same convention as creditCardId/savingsPotId being set
      // only on the transaction types that need them.
      potId: isTransferKind ? (fromLoc?.type === 'pot' ? fromLoc.potId : toLoc?.type === 'pot' ? toLoc.potId : undefined) : template.location === 'pot' ? template.potId : undefined,
      savingsPotId: isTransferKind ? (fromLoc?.type === 'savings' ? fromLoc.savingsPotId : toLoc?.type === 'savings' ? toLoc.savingsPotId : undefined) : undefined,
      fromLocation: fromLoc,
      toLocation: toLoc,
      followsPayday: isTransferKind ? template.followsPayday : undefined,
      followsCycleStart: isTransferKind ? template.followsCycleStart : undefined,
      sourceType: 'recurring_template',
      sourceId: template.id,
      // The specific bill's/recurring transaction's/transfer's own name —
      // without this, a row falls back to its category's name for
      // display, which duplicates the category group header when viewed
      // grouped by category (e.g. a "TV" category group whose own rows
      // also just say "TV" instead of "TV License").
      note: template.name,
      personId: isIncome ? template.personId : undefined,
    }
  })
}


/**
 * Every upcoming occurrence for a 'transaction'-kind template, WITH its
 * original scheduled date alongside the possibly-overridden display
 * date/amount — Expenses.tsx's "next 12 upcoming" expand panel uses this
 * (rather than generateTransactionsForTemplate directly) because an
 * edit/delete on one of those rows has to key itself to the ORIGINAL
 * slot (occurrenceOverrides' own key), regardless of what date that
 * occurrence currently displays. 15 years covers even an annual
 * frequency's `count` occurrences comfortably.
 */
export function templateOccurrencePreviews(template: RecurringTemplate, asOfDate: Date, count: number): RawOccurrence[] {
  return walkOccurrences(template, asOfDate, addYears(asOfDate, 15)).slice(0, count)
}

/**
 * Every calendar date the template's frequency would land on in
 * [rangeStart, rangeEnd] — deliberately IGNORING occurrenceOverrides
 * entirely, unlike walkOccurrences/generateTransactionsForTemplate. This
 * is what the pause picker itself needs to show as candidates: a
 * currently-paused date has to appear in the list so it can be unchecked,
 * which the normal (pause-aware) walk would never surface — a paused
 * date isn't a real occurrence any more, generator-side. Same shape and
 * purpose as savingsPotLedger.ts's scheduledDepositDates (Phase 4 —
 * generalizing the SavingsPot-only pause picker to Bills/Pensions too).
 */
export function scheduledTemplateDates(template: RecurringTemplate, rangeStart: Date, rangeEnd: Date): string[] {
  if (rangeEnd < rangeStart) return []
  const anchor = new Date(template.anchorDate)
  const anchorDay = anchor.getDate()
  let cursor = anchor
  let iterations = 0
  while (cursor < rangeStart && iterations < MAX_OCCURRENCES) {
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }
  const results: string[] = []
  while (cursor <= rangeEnd && iterations < MAX_OCCURRENCES) {
    results.push(toIso(cursor))
    cursor = nextOccurrence(cursor, template, anchorDay)
    iterations++
  }
  return results
}

/**
 * Given the FULL set of dates the person now wants paused (from a
 * multi-select checklist drawn from scheduledTemplateDates), reconciles
 * occurrenceOverrides to match — a newly-checked date gets a
 * {originalDate, deleted: true} entry, an unchecked one has its entry
 * removed, anything already correct is left alone. Overrides outside the
 * shown window, or carrying a date/amount override rather than a pure
 * pause marker, are untouched. Identical logic to
 * savingsPotLedger.ts's setPausedDeposits — see that function's comment
 * for the full reasoning (Adam's explicit no-separate-resume-flow call).
 */
export function setPausedTemplateOccurrences(template: RecurringTemplate, windowDates: string[], pausedDates: string[]): Pick<RecurringTemplate, 'occurrenceOverrides'> {
  const windowSet = new Set(windowDates)
  const pausedSet = new Set(pausedDates)
  const untouched = (template.occurrenceOverrides ?? []).filter((o) => !windowSet.has(o.originalDate) || o.date !== undefined || o.amount !== undefined)
  const newPauses = [...pausedSet].map((originalDate) => ({ originalDate, deleted: true }))
  return { occurrenceOverrides: [...untouched, ...newPauses] }
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
