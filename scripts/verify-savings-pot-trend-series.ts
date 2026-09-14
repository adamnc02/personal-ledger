import { buildSavingsPotTrendSeries, newSavingsPot } from '../src/lib/savingsPotLedger'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'
import type { AppDataV2, Person, SavingsPot, Transaction } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const me: Person = { id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [], savingsEntries: [] }
const payCycle = { ...defaultPayCycleConfig('me'), openingBalanceDate: '2020-01-01' }
const pot: SavingsPot = {
  ...newSavingsPot({
    personId: 'me',
    name: 'Rainy day',
    openingBalance: 1000,
    openingDate: '2020-01-01',
    interestMethod: { type: 'aer_credited', aer: 0, creditingFrequency: 'monthly' },
    color: '#123456',
  }),
  id: 'sp-1',
}

const txns: Transaction[] = [
  { id: 's1', date: '2026-09-05', amount: 100, direction: 'out', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_deposit', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
  { id: 's2', date: '2026-09-20', amount: 40, direction: 'in', categoryId: 'category-savings', paymentMethod: 'bank_transfer', status: 'cleared', type: 'savings_withdrawal', location: 'personal', ownerId: 'me', savingsPotId: 'sp-1' },
]

const data: AppDataV2 = {
  primaryPersonId: 'me',
  people: [me],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  pensions: [],
  savingsPots: [pot],
  pots: [],
  transactions: txns,
  payCycles: [payCycle],
  scenarios: [],
  jointAccount: null,
}

const asOfDate = new Date(2026, 8, 25)

// ---- This Cycle: one pill per day, end-of-day balance, sign-dependent net ----
const thisCycle = buildSavingsPotTrendSeries(data, pot, 'this_cycle', asOfDate)
check('This Cycle produces one point per day of the current calendar-month cycle', thisCycle.points.length, 30)
check('Day 1 (before any activity) end balance = opening balance', thisCycle.points[0].endBalance, 1000)
const depositDay = thisCycle.points.find((p) => p.periodStart === '2026-09-05')!
check('The deposit day end balance = 1100', depositDay.endBalance, 1100)
check('The deposit day netChange is POSITIVE (net saved)', depositDay.netChange > 0, true)
const withdrawalDay = thisCycle.points.find((p) => p.periodStart === '2026-09-20')!
check('The withdrawal day end balance = 1060', withdrawalDay.endBalance, 1060)
check('The withdrawal day netChange is NEGATIVE (net withdrawn) — sign-dependent tooltip metric', withdrawalDay.netChange < 0, true)
check('A day with no activity has netChange exactly 0', thisCycle.points.find((p) => p.periodStart === '2026-09-10')!.netChange, 0)

// ---- Last 6 Cycles: weekly buckets, w/c label ----
const last6 = buildSavingsPotTrendSeries(data, pot, 'last_6_cycles', asOfDate)
check('Last 6 Cycles produces at least 6 weekly columns', last6.points.length >= 6, true)
check('Every weekly column carries a "w/c" axis label', last6.points.every((p) => p.axisLabel.startsWith('w/c')), true)
check('Weekly columns are chronologically ascending', last6.points.every((p, i, arr) => i === 0 || p.periodStart >= arr[i - 1].periodStart), true)

// ---- Year: one pill per pay cycle, offset-labelled 0/-1/-2/... ----
const year = buildSavingsPotTrendSeries(data, pot, 'year', asOfDate)
check('Year produces 12 columns (current pay cycle + 11 before it)', year.points.length, 12)
check('The LAST column (current cycle) is offset 0', year.points[year.points.length - 1].axisLabel, '0')
check('The column before it is offset -1', year.points[year.points.length - 2].axisLabel, '-1')
check('The final column\'s end balance matches This Cycle\'s own final balance', year.points[year.points.length - 1].endBalance, thisCycle.points[thisCycle.points.length - 1].endBalance)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Savings Pot pill-chart trend-series checks passed.')
}
