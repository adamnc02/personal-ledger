import { buildCreditCardTrendSeries } from '../src/lib/creditCards'
import type { AppDataV2, CreditCard, Person, Transaction } from '../src/types/ledger'
import { defaultPayCycleConfig } from '../src/lib/ledgerStorage'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const me: Person = { id: 'me', name: 'Me', color: '#fff', salaryHistory: [], salaryOverrides: [], savingsEntries: [] }
const payCycle = { ...defaultPayCycleConfig('me'), openingBalanceDate: '2020-01-01' }

const card: CreditCard = {
  id: 'card-1',
  name: 'Visa',
  categoryId: 'category-shopping',
  color: '#fff',
  interestRatePercent: 0,
  currentBalance: 200,
  balanceAsOfDate: '2026-09-01',
  minimumPayment: { type: 'fixed', amount: 25 },
  paymentDayOfMonth: 28,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}

const txns: Transaction[] = [
  { id: 'c1', date: '2026-09-06', amount: 50, direction: 'out', categoryId: 'category-shopping', paymentMethod: 'card', status: 'cleared', type: 'credit_card_spend', location: 'personal', ownerId: 'me', creditCardId: 'card-1' },
  { id: 'c2', date: '2026-09-10', amount: 30, direction: 'out', categoryId: 'category-shopping', paymentMethod: 'bank_transfer', status: 'cleared', type: 'credit_card_payment', location: 'personal', ownerId: 'me', creditCardId: 'card-1' },
]

const data: AppDataV2 = {
  primaryPersonId: 'me',
  people: [me],
  categories: [],
  recurringTemplates: [],
  loans: [],
  creditCards: [card],
  pensions: [],
  savingsPots: [],
  pots: [],
  transactions: txns,
  payCycles: [payCycle],
  scenarios: [],
  jointAccount: null,
}

const asOfDate = new Date(2026, 8, 15)
const series = buildCreditCardTrendSeries(data, card, 'this_cycle', asOfDate)
check('days span the current calendar-month cycle', [series.days[0], series.days[series.days.length - 1]], ['2026-09-01', '2026-09-30'])
check('Owed balance before any activity = the stated anchor (200)', series.balance[0].clearedBalance, 200)
check('After the £50 spend (6 Sep), owed balance = 250', series.balance.find((b) => b.date === '2026-09-06')!.clearedBalance, 250)
check('After the £30 payment (10 Sep), owed balance = 220', series.balance.find((b) => b.date === '2026-09-10')!.clearedBalance, 220)
check('Balance chart carries the same figure in both cleared/projected fields (a card\'s owed balance is one continuous figure, not cleared-vs-pending)', series.balance.find((b) => b.date === '2026-09-10')!.projectedBalance, 220)
check('Spend-to-date by 6 Sep counts only the credit_card_spend (£50), not the payment', series.spend.find((s) => s.date === '2026-09-06')!.spendToDate, 50)
check('Spend-to-date does not increase again on the payment date (10 Sep)', series.spend.find((s) => s.date === '2026-09-10')!.spendToDate, 50)

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`)
  process.exit(1)
} else {
  console.log('\nAll Credit Card trend-series checks passed.')
}
