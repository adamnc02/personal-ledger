// 2026-09-13 (dev.md follow-up, "average spend forecast" — see
// PROMPT-average-spend-forecast-toggle-2026-09-13.md) — projects a
// placeholder "average spend" amount into future pay cycles, scoped to
// the Personal or Joint card. The average is built from the trailing 3
// completed pay cycles' worth of ad-hoc `type: 'expense'` transactions
// (never bills, loans, credit_card_spend, recurring templates, or ad-hoc
// income), and each future cycle's own forecast is that average REDUCED
// by whatever real ad-hoc spend already sits in that cycle — Adam's own
// worked example: "£800 average, £250 already scheduled next month →
// £550 forecast," not a blanket skip-the-cycle rule.
//
// Deliberately does NOT bound by either ledger's own opening-balance
// date (`payCycle.openingBalanceDate` / `data.jointAccount.
// openingBalanceDate`) the way `computeProjection`/
// `computeJointAccountProjection` do — Adam's own words: "if we have
// older transactions after the account was balanced, we should still
// use the full available window." Rebalancing an account is a real
// reason old history would otherwise be excluded from a real-balance
// calculation, but it's still perfectly good signal for THIS average.

import { previousCycles } from './projection'
import type { AppDataV2, Transaction } from '../types/ledger'
import { toLocalIsoDate as toIso } from './date'

const round2 = (n: number) => Math.round(n * 100) / 100

/** Which ledger's ad-hoc expense history this forecast is scoped to — Personal (a specific owner) or Joint (no owner check, either person can log a joint ad-hoc expense). Never Savings Pot/Pot/Household/Credit Card. */
export type SpendScope = { location: 'personal'; ownerId: string } | { location: 'joint' }

function matchesSpendScope(t: Pick<Transaction, 'type' | 'location' | 'ownerId'>, scope: SpendScope): boolean {
  if (t.type !== 'expense') return false
  return scope.location === 'personal' ? t.location === 'personal' && t.ownerId === scope.ownerId : t.location === 'joint'
}

function inCycle(t: Pick<Transaction, 'date'>, cycle: { start: Date; end: Date }): boolean {
  return t.date >= toIso(cycle.start) && t.date <= toIso(cycle.end)
}

/**
 * The trailing average ad-hoc expense per cycle, over the last 3
 * completed cycles (not including the current, still-in-progress one).
 * The divisor counts only cycles that actually contain at least one
 * matching transaction — this one rule handles both a genuinely new
 * account (early cycles have no data yet) and a cycle where the person
 * simply logged nothing that period, without needing to separately
 * detect "didn't exist yet" vs. "existed but empty." Returns 0 if none
 * of the 3 cycles have any matching history at all.
 */
export function averageAdHocExpensePerCycle(data: AppDataV2, scope: SpendScope, personId: string, asOfDate: Date): number {
  const cycles = previousCycles(data, personId, 3, asOfDate)
  let total = 0
  let count = 0
  for (const cycle of cycles) {
    const matching = data.transactions.filter((t) => matchesSpendScope(t, scope) && inCycle(t, cycle))
    if (matching.length === 0) continue
    total += matching.reduce((sum, t) => sum + t.amount, 0)
    count++
  }
  return count === 0 ? 0 : round2(total / count)
}

/**
 * The forecast for ONE future cycle: the trailing average reduced by
 * whatever real ad-hoc spend (same scope) already sits in that cycle,
 * clamped at 0 (never negative). `realSpend` is returned alongside so a
 * caller can show a "reduced from £X" caption when it's non-zero.
 */
export function forecastSpendForCycle(data: AppDataV2, scope: SpendScope, averagePerCycle: number, cycle: { start: Date; end: Date }): { forecastAmount: number; realSpend: number } {
  const realSpend = round2(data.transactions.filter((t) => matchesSpendScope(t, scope) && inCycle(t, cycle)).reduce((sum, t) => sum + t.amount, 0))
  const forecastAmount = Math.max(0, round2(averagePerCycle - realSpend))
  return { forecastAmount, realSpend }
}
