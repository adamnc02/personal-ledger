// Household card's own data layer — Adam's 2026-09-03 correction: the
// Household card shows EACH person's own personal picture only (income,
// personal-location bills/loans/ad-hoc, and joint_deposit/
// joint_withdrawal transactions) — no joint bills, and no synthetic
// per-person SHARE of a joint bill either. That share genuinely belongs
// on the person's own Personal card (it does reduce their real personal
// cash — see projection.ts's generateJointContributionTransactions), but
// showing it a second time here, unsplit-looking, would misrepresent it
// as a personal bill in its own right. So it's filtered out below, by
// tracing a transaction's sourceId back to a joint-location
// RecurringTemplate/Loan — the one reliable marker, since
// generateJointContributionTransactions is the ONLY generator that
// produces these (jointLedger.ts).
//
// The joint account's own real ledger — actual joint bills paid, actual
// deposits/withdrawals — lives entirely on the Joint card instead (see
// jointAccountLedger.ts). Nothing here reads AppDataV2.jointAccount.

import { computeProjection, type ProjectionHorizon } from './projection'
import { horizonCycles } from './projection'
import { isLedgerTransaction, signedAmount } from './runningBalance'
import type { AppDataV2, Transaction } from '../types/ledger'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Every RecurringTemplate/Loan id that's joint-location. */
function jointSourceIds(data: AppDataV2): Set<string> {
  const ids = new Set<string>()
  for (const t of data.recurringTemplates) if (t.location === 'joint') ids.add(t.id)
  for (const l of data.loans) if (l.location === 'joint') ids.add(l.id)
  return ids
}

function isJointShareTransaction(t: Transaction, jointIds: Set<string>): boolean {
  return (t.sourceType === 'recurring_template' || t.sourceType === 'loan') && !!t.sourceId && jointIds.has(t.sourceId)
}

export interface HouseholdPersonProjection {
  personId: string
  personName: string
  openingBalance: number
  clearedBalance: number
  projectedBalance: number
  horizonEnd: string
  // Real+generated, personal-only (joint-bill shares stripped) — the
  // exact set CycleGroupedList/DateOrderedList/etc. below fold over, so
  // this person's own section total can never disagree with what's shown.
  transactions: Transaction[]
  cycles: { start: Date; end: Date }[] // this person's OWN cycle bounds — used when grouping by person + cycle-end totals
}

/**
 * One person's personal-only projection for the Household card.
 * Recomputes clearedBalance/projectedBalance from the FILTERED
 * transaction set (rather than trusting computeProjection's own figures,
 * which legitimately include the joint-bill share) so the Household
 * hero and its own transaction list can never disagree — the same
 * "single source, not two calculations" property the rest of this app
 * holds everywhere else (see e.g. projection.ts's own header comment).
 */
export function computeHouseholdPersonProjection(
  data: AppDataV2,
  personId: string,
  horizon: ProjectionHorizon,
  asOfDate: Date = new Date(),
): HouseholdPersonProjection | null {
  const person = data.people.find((p) => p.id === personId)
  const payCycle = data.payCycles.find((pc) => pc.personId === personId)
  if (!person || !payCycle) return null

  const jointIds = jointSourceIds(data)
  const projection = computeProjection(data, personId, payCycle, horizon, asOfDate)
  const transactions = projection.transactions.filter((t) => !isJointShareTransaction(t, jointIds))

  const clearedBalance = round2(
    payCycle.openingBalance +
      transactions.filter((t) => t.status === 'cleared' && isLedgerTransaction(t)).reduce((sum, t) => sum + signedAmount(t), 0),
  )
  const pendingWithinHorizon = transactions.filter((t) => t.status === 'pending' && isLedgerTransaction(t) && t.date <= projection.horizonEnd)
  const projectedBalance = round2(clearedBalance + pendingWithinHorizon.reduce((sum, t) => sum + signedAmount(t), 0))

  return {
    personId,
    personName: person.name,
    openingBalance: payCycle.openingBalance,
    clearedBalance,
    projectedBalance,
    horizonEnd: projection.horizonEnd,
    transactions,
    cycles: horizonCycles(data, personId, horizon, asOfDate),
  }
}

/** Every household member's personal-only projection, for whoever has a pay cycle set up (same "missing pay cycle just gets left out" convention Home.tsx's existing household hero already uses). */
export function computeHouseholdProjections(data: AppDataV2, horizon: ProjectionHorizon, asOfDate: Date = new Date()): HouseholdPersonProjection[] {
  return data.people
    .map((p) => computeHouseholdPersonProjection(data, p.id, horizon, asOfDate))
    .filter((r): r is HouseholdPersonProjection => r !== null)
}
