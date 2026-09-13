// Verifies the "average spend forecast" feature (dev.md follow-up — see
// PROMPT-average-spend-forecast-toggle-2026-09-13.md): the trailing
// 3-cycle average of ad-hoc `type: 'expense'` transactions, the
// per-cycle reduction math, and — critically — that the average is NOT
// bound by either ledger's own opening-balance date (Adam's own
// rebalancing scenario).

import { previousCycles } from '../src/lib/projection'
import { averageAdHocExpensePerCycle, forecastSpendForCycle, type SpendScope } from '../src/lib/averageSpendForecast'
import { toLocalIsoDate as iso } from '../src/lib/date'
import type { AppDataV2, PayCycleConfig, Transaction } from '../src/types/ledger'

let passed = 0
let failed = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`)
  }
}
function assert(label: string, condition: boolean) {
  check(label, condition, true)
}

const payCycle: PayCycleConfig = {
  personId: 'p1',
  openingBalance: 1000,
  // 2026-09 — deliberately set well AFTER some of the fixture's ad-hoc
  // expenses below, to prove the average genuinely ignores this bound
  // (Adam's own rebalancing scenario).
  openingBalanceDate: '2026-09-01',
  paydayDayOfMonth: 25,
  paydayAdjustForNonWorkingDay: false,
  cycleStartDayOfMonth: 25,
}

function expense(id: string, date: string, amount: number, location: 'personal' | 'joint', ownerId = 'p1'): Transaction {
  return {
    id,
    date,
    amount,
    direction: 'out',
    categoryId: 'cat-food',
    paymentMethod: 'card',
    status: 'cleared',
    type: 'expense',
    location,
    ownerId,
  }
}

function dataWith(transactions: Transaction[]): AppDataV2 {
  return {
    primaryPersonId: 'p1',
    people: [{ id: 'p1', name: 'Test', color: '#ff5b4c', salaryHistory: [], salaryOverrides: [], savingsEntries: [] }],
    categories: [],
    recurringTemplates: [],
    loans: [],
    creditCards: [],
    transactions,
    payCycles: [payCycle],
    pensions: [],
    savingsPots: [],
    scenarios: [],
  } as unknown as AppDataV2
}

const asOf = new Date(2026, 9, 10) // 10 Oct 2026 — mid-cycle, well after openingBalanceDate

// ── 1. previousCycles: 3 cycles immediately before "now"'s, tiling with no gaps ──
{
  const cycles = previousCycles(dataWith([]), 'p1', 3, asOf)
  assert('previousCycles returns exactly 3 cycles', cycles.length === 3)
  // Each should end the day before the next (later) one starts — cycles[0] is the most recent past cycle.
  for (let i = 0; i < cycles.length - 1; i++) {
    const laterEnd = iso(cycles[i].start)
    const earlierEnd = iso(cycles[i + 1].end)
    assert(`previousCycles[${i + 1}] ends the day before previousCycles[${i}] starts`, new Date(earlierEnd) < new Date(laterEnd))
  }
  assert('the most recent previousCycle ends before "now"\'s own cycle starts', cycles[0].end < asOf)
}

// Cycle boundaries for reference (paydayDayOfMonth 25, no weekend adjustment):
// cycle containing 2026-10-10 runs 2026-09-25..2026-10-24 (call it "current").
// previousCycles(asOf, 3) => [2026-08-25..2026-09-24, 2026-07-25..2026-08-24, 2026-06-25..2026-07-24]

// ── 2. Basic average across 3 cycles, all non-empty ──
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const data = dataWith([
    expense('e1', '2026-09-10', 300, 'personal'), // cycle -1 (Aug25-Sep24)
    expense('e2', '2026-08-10', 200, 'personal'), // cycle -2 (Jul25-Aug24)
    expense('e3', '2026-07-10', 400, 'personal'), // cycle -3 (Jun25-Jul24)
  ])
  const avg = averageAdHocExpensePerCycle(data, scope, 'p1', asOf)
  check('average across 3 non-empty cycles = (300+200+400)/3', avg, 300)
}

// ── 3. Partial-history divisor: only cycles with matching transactions count ──
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const data = dataWith([
    expense('e1', '2026-09-10', 300, 'personal'), // cycle -1 only — the other two cycles have nothing
  ])
  const avg = averageAdHocExpensePerCycle(data, scope, 'p1', asOf)
  check('average with only 1 of 3 cycles populated divides by 1, not 3', avg, 300)
}
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const avg = averageAdHocExpensePerCycle(dataWith([]), scope, 'p1', asOf)
  check('average with ZERO matching history anywhere is 0 (nothing to forecast)', avg, 0)
}

// ── 4. Rebalancing: ad-hoc expenses dated BEFORE payCycle.openingBalanceDate still count ──
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  // All 3 of these predate payCycle.openingBalanceDate ('2026-09-01') —
  // computeProjection would exclude every one of them from a real
  // balance calculation, but this average must NOT.
  const data = dataWith([
    expense('e1', '2026-08-10', 100, 'personal'), // cycle -2, before openingBalanceDate
    expense('e2', '2026-07-10', 100, 'personal'), // cycle -3, before openingBalanceDate
  ])
  const avg = averageAdHocExpensePerCycle(data, scope, 'p1', asOf)
  assert('REGRESSION GUARD — ad-hoc expenses dated before payCycle.openingBalanceDate still feed the average (not silently excluded)', avg > 0)
  check('average correctly built from pre-rebalance history alone', avg, 100)
}

// ── 5. What counts as "spend": only ad-hoc type:'expense', location:'personal', ownerId matches ──
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const otherOwner: Transaction = expense('e-other', '2026-09-10', 999, 'personal', 'p2')
  const income: Transaction = { ...expense('e-income', '2026-09-10', 999, 'personal'), type: 'income', direction: 'in' }
  const billPayment: Transaction = { ...expense('e-bill', '2026-09-10', 999, 'personal'), type: 'bill_payment' }
  const cardSpend: Transaction = { ...expense('e-card', '2026-09-10', 999, 'personal'), type: 'credit_card_spend' }
  const jointExpense: Transaction = expense('e-joint', '2026-09-10', 999, 'joint')
  const realOne = expense('e-real', '2026-09-10', 50, 'personal')
  const data = dataWith([otherOwner, income, billPayment, cardSpend, jointExpense, realOne])
  const avg = averageAdHocExpensePerCycle(data, scope, 'p1', asOf)
  check('only the genuine ad-hoc personal expense counts — other owner/income/bill/card-spend/joint all excluded', avg, 50)
}

// ── 6. Cross-contamination guard: joint expense never feeds Personal average, and vice versa ──
{
  const personalScope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const jointScope: SpendScope = { location: 'joint' }
  const data = dataWith([expense('e1', '2026-09-10', 500, 'joint'), expense('e2', '2026-09-10', 300, 'personal')])
  check('CROSS-CONTAMINATION GUARD — a location:joint expense never feeds the Personal average', averageAdHocExpensePerCycle(data, personalScope, 'p1', asOf), 300)
  check('CROSS-CONTAMINATION GUARD — a location:personal expense never feeds the Joint average', averageAdHocExpensePerCycle(data, jointScope, 'p1', asOf), 500)
}

// ── 7. Joint scope has no ownerId filter — either person's logged joint expense counts ──
{
  const jointScope: SpendScope = { location: 'joint' }
  const data = dataWith([expense('e1', '2026-09-10', 100, 'joint', 'p1'), expense('e2', '2026-08-10', 200, 'joint', 'p2')])
  const avg = averageAdHocExpensePerCycle(data, jointScope, 'p1', asOf)
  check('Joint average includes ad-hoc expenses logged by EITHER owner (no ownerId filter)', avg, 150)
}

// ── 8. Adam's own worked example: £800 average, £250 already scheduled -> £550 forecast ──
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const cycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) } // a future cycle
  const data = dataWith([expense('e1', '2026-11-05', 150, 'personal'), expense('e2', '2026-11-10', 100, 'personal')]) // £250 already logged this future cycle
  const { forecastAmount, realSpend } = forecastSpendForCycle(data, scope, 800, cycle)
  check("Adam's worked example — realSpend correctly totals the £250 already scheduled", realSpend, 250)
  check("Adam's worked example — forecast reduces from £800 to £550", forecastAmount, 550)
}

// ── 9. Forecast clamps to 0 when real spend meets or exceeds the average (never negative) ──
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const cycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) }
  const data = dataWith([expense('e1', '2026-11-05', 900, 'personal')])
  const { forecastAmount, realSpend } = forecastSpendForCycle(data, scope, 800, cycle)
  check('real spend already exceeding the average clamps the forecast to 0, not negative', forecastAmount, 0)
  check('realSpend is still reported accurately even when it exceeds the average', realSpend, 900)
}

// ── 10. Forecast with zero real spend this cycle equals the average outright ──
{
  const scope: SpendScope = { location: 'personal', ownerId: 'p1' }
  const cycle = { start: new Date(2026, 9, 25), end: new Date(2026, 10, 24) }
  const { forecastAmount, realSpend } = forecastSpendForCycle(dataWith([]), scope, 800, cycle)
  check('no real spend this cycle -> forecast equals the average unreduced', forecastAmount, 800)
  check('realSpend is 0', realSpend, 0)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
