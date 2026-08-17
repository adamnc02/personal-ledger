import type { Person, SavingsEntry } from '../types/models'

/**
 * The monthly amount a savings entry represents:
 *  - 'plan': the flat monthly amount you've committed to
 *  - 'goal': the amount required per month to hit the target by its date
 *    (0 if there's no target date set — a goal without a date is just a
 *    progress tracker, not a monthly commitment)
 */
export function monthlyAmountForEntry(entry: SavingsEntry, asOf: Date = new Date()): number {
  if (entry.type === 'plan') return entry.monthlyAmount ?? 0

  if (!entry.targetDate || !entry.targetAmount) return 0
  const remaining = Math.max(0, entry.targetAmount - (entry.currentAmount ?? 0))
  const months = monthsUntil(entry.targetDate, asOf)
  if (months <= 0) return remaining // overdue or due this month — the whole remainder is "required" now
  return round2(remaining / months)
}

/** Total monthly savings this person has opted to count against their available balance. */
export function totalMonthlySavingsForPerson(person: Person, asOf: Date = new Date()): number {
  const total = (person.savingsEntries ?? [])
    .filter((e) => e.includeInSummary)
    .reduce((sum, e) => sum + monthlyAmountForEntry(e, asOf), 0)
  return round2(total)
}

export function monthsUntil(targetDate: string, asOf: Date = new Date()): number {
  const target = new Date(targetDate)
  return Math.max(
    1,
    (target.getFullYear() - asOf.getFullYear()) * 12 + (target.getMonth() - asOf.getMonth()) + (target.getDate() >= asOf.getDate() ? 0 : -1)
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
