import type { AppData, Person as LegacyPerson } from '../types/models'
import type { BillLocation } from '../types/models'
import type { AppDataV2, Person } from '../types/ledger'
import { calculateNetSalary } from './tax'
import { combineBillsWithLoans } from './loans'

export interface HouseholdFigures {
  totalIncome: number // every person's net pay, normalized to a monthly-equivalent
  totalOutgoings: number // every bill and loan's full cost — not per-person splits
  totalAvailable: number
}

/**
 * The whole household's combined numbers — every person's income together,
 * against every bill and loan at full value (not anyone's individual split
 * share). Used by both the Dashboard's "Household" card and the What-if
 * page's household view toggle, so the two stay consistent with each other.
 */
export function calculateHouseholdFigures(data: AppData): HouseholdFigures {
  const allBills = combineBillsWithLoans(data.bills, data.loans)
  const totalIncome = round2(data.people.reduce((sum, p) => sum + calculateNetSalary(p.salary).netMonthly, 0))
  const totalOutgoings = round2(allBills.reduce((sum, b) => sum + b.cost, 0))
  const totalAvailable = round2(totalIncome - totalOutgoings)
  return { totalIncome, totalOutgoings, totalAvailable }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ── "Has a salary configured" helpers ───────────────────────────────────
// "A second person exists" and "a second salary is configured" are NOT the
// same thing — addPerson() creates a person with an empty salaryHistory,
// so a household can have 2+ people with only one of them actually earning
// anything yet. Joint bills/loans split a real income between people, so
// anywhere that offers "Joint" as a choice (not just displays one that
// already exists) should gate on this, not on people.length alone.

/** Ledger shape (types/ledger.ts) — current app data, most pages. */
export function hasSalaryConfigured(person: Pick<Person, 'salaryHistory'>): boolean {
  return person.salaryHistory.length > 0
}

export function peopleWithSalaryCount(people: Pick<Person, 'salaryHistory'>[]): number {
  return people.filter(hasSalaryConfigured).length
}

/**
 * Legacy shape (types/models.ts) — used by Scenarios.tsx/Dashboard.tsx via
 * legacyBridge's adapter. The adapter always produces a `salary` object
 * (never omits it), defaulting to `{ grossAnnual: 0, ... }` when there's no
 * real snapshot (see legacyBridge.ts's buildLegacyAppData), so
 * `grossAnnual > 0` is the closest available proxy for "has a real salary
 * configured" in this shape.
 */
export function hasLegacySalaryConfigured(person: Pick<LegacyPerson, 'salary'>): boolean {
  return person.salary.grossAnnual > 0
}

export function legacyPeopleWithSalaryCount(people: Pick<LegacyPerson, 'salary'>[]): number {
  return people.filter(hasLegacySalaryConfigured).length
}

// ── Reconciling stale person references ─────────────────────────────────
// Bills/loans/cards reference a person via ownerId (personal items) or
// payee (the joint split target). Removing a person should always clean
// these up (see LedgerContext.removePerson), but this is also run as part
// of the regular load/migration pipeline (ledgerStorage.ts) so that data
// already saved from before that fix — or a backup restored from that
// state — self-heals rather than staying broken: a personal item with a
// dangling ownerId silently drops out of that owner's totals/summary
// rings everywhere (see lib/bills.ts's personalBillsTotal, Home.tsx's
// loan/card filtering), and a leftover location: 'joint' item with fewer
// than 2 people keeps joint-only UI (the What-if page's Household toggle,
// Home.tsx's Joint summary card) visible with nothing real behind it.

export function reconcilePersonReferences(data: AppDataV2): AppDataV2 {
  if (data.people.length === 0) return data // nothing to reconcile against

  const validIds = new Set(data.people.map((p) => p.id))
  const fallbackOwnerId = validIds.has(data.primaryPersonId) ? data.primaryPersonId : data.people[0].id
  const stillHasMultiplePeople = data.people.length >= 2

  function reassign<T extends { location: BillLocation; ownerId: string; payee: string; payeeSharePercent: number }>(item: T): T {
    if (item.location === 'joint') {
      if (!stillHasMultiplePeople) {
        return { ...item, location: 'personal', ownerId: fallbackOwnerId, payee: '', payeeSharePercent: 100 }
      }
      return validIds.has(item.payee) ? item : { ...item, payee: fallbackOwnerId }
    }
    return validIds.has(item.ownerId) ? item : { ...item, ownerId: fallbackOwnerId }
  }

  return {
    ...data,
    primaryPersonId: fallbackOwnerId,
    recurringTemplates: data.recurringTemplates.map(reassign),
    loans: data.loans.map(reassign),
    creditCards: data.creditCards.map((c) => (validIds.has(c.ownerId) ? c : { ...c, ownerId: fallbackOwnerId })),
  }
}
