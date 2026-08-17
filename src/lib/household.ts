import type { AppData } from '../types/models'
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
