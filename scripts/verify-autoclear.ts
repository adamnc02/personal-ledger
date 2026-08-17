import { autoClearDuePayments } from '../src/lib/autoClear'
import { defaultCategories } from '../src/lib/categories'
import { SAVINGS_CATEGORY_ID, BILLS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, CreditCard, PayCycleConfig, Person, RecurringTemplate } from '../src/types/ledger'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}

const payCycle: PayCycleConfig = {
  personId: 'me',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}

const person: Person = {
  id: 'me',
  name: 'Me',
  color: '#ff5b4c',
  salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }],
  salaryOverrides: [],
  savingsEntries: [{ id: 'goal-1', type: 'goal', name: 'House deposit', includeInSummary: true, targetAmount: 5000, currentAmount: 0, targetDate: '2028-01-01' }],
}

const monthlyBill: RecurringTemplate = {
  id: 'bill-1',
  name: 'Netflix',
  amount: 15,
  categoryId: BILLS_CATEGORY_ID,
  paymentMethod: 'direct_debit',
  frequency: 'monthly',
  anchorDate: '2026-06-10',
  location: 'personal',
  ownerId: 'me',
  payee: '',
  payeeSharePercent: 100,
  active: true,
}

const card: CreditCard = {
  id: 'card-1',
  name: 'Amex',
  categoryId: SAVINGS_CATEGORY_ID,
  color: '#8b5cf6',
  interestRatePercent: 20,
  currentBalance: 500,
  minimumPayment: { type: 'fixed', amount: 40 },
  paymentDayOfMonth: 12,
  ownerId: 'me',
  lumpPayments: [],
  active: true,
}

const data: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [monthlyBill],
  loans: [],
  creditCards: [card],
  transactions: [],
  payCycles: [payCycle],
  scenarios: [],
  primaryPersonId: 'me',
}

// asOf mid-July 2026 — several months of bills, salary, savings, and one
// credit card minimum payment should all have come due since Jan 1.
const asOf = new Date(2026, 6, 15)
const settled = autoClearDuePayments(data, asOf)

// ---- 1. Due items are materialized as real, cleared transactions ----
check('Some transactions were actually created (settled !== original data)', settled !== data, true)
const clearedBills = settled.transactions.filter((t) => t.sourceId === 'bill-1')
check('Netflix (monthly since June) has cleared occurrences materialized', clearedBills.length > 0, true)
check('All materialized bill occurrences are status "cleared", not pending', clearedBills.every((t) => t.status === 'cleared'), true)
check('None of the materialized occurrences are dated after asOf', clearedBills.every((t) => t.date <= '2026-07-15'), true)

const clearedSalary = settled.transactions.filter((t) => t.type === 'salary')
check('Salary paydays that have passed are also auto-cleared (not just outgoing types)', clearedSalary.length > 0 && clearedSalary.every((t) => t.status === 'cleared'), true)

// ---- 2. Side effects actually apply — the whole point of this over the old tap mechanism ----
const clearedContribution = settled.transactions.find((t) => t.type === 'savings_contribution')
check('A savings contribution that came due was materialized', !!clearedContribution, true)
const updatedGoal = settled.people[0].savingsEntries.find((e) => e.id === 'goal-1')
check("Clearing it quietly increased the goal's currentAmount (the side effect actually ran, automatically)", (updatedGoal?.currentAmount ?? 0) > 0, true)

const clearedCardPayment = settled.transactions.find((t) => t.type === 'credit_card_payment' && t.creditCardId === 'card-1')
check('A credit card minimum payment that came due was materialized', !!clearedCardPayment, true)
check("Clearing it reduced the card's balance automatically", settled.creditCards[0].currentBalance < 500, true)

// ---- 3. Idempotency — the property that makes it safe to run on every data change ----
const secondPass = autoClearDuePayments(settled, asOf)
check('Running it again with nothing new due returns the EXACT SAME reference (no-op, prevents an infinite update loop)', secondPass === settled, true)

// ---- 4. Never settles anything in the future ----
const nearFuture = new Date(2026, 6, 20) // 20 July — 5 days after asOf
const futureCheck = autoClearDuePayments(data, nearFuture)
check('No materialized transaction is ever dated after the asOf passed in', futureCheck.transactions.every((t) => t.date <= '2026-07-20'), true)

// A bill due tomorrow relative to a given asOf must NOT be cleared today.
const dataForTomorrowTest: AppDataV2 = {
  ...data,
  recurringTemplates: [{ ...monthlyBill, anchorDate: '2026-07-16' }], // due the day AFTER our asOf
}
const tomorrowCheck = autoClearDuePayments(dataForTomorrowTest, asOf)
check('A bill due the day after asOf is NOT auto-cleared yet', tomorrowCheck.transactions.some((t) => t.date === '2026-07-16'), false)

// ---- 5. Future-dated LOGGED payments (not just generated ones) must also wait until their date arrives ----
// The exact reported bug: a manually-logged credit card lump payment
// dated in the future was clearing (and reducing the balance)
// immediately at logging time, ignoring its date entirely.
import { recordCreditCardLumpPayment } from '../src/lib/creditCards'

const cardForLumpTest: CreditCard = { ...card, id: 'card-2', currentBalance: 500, minimumPayment: { type: 'fixed', amount: 0 } }
const lumpResult = recordCreditCardLumpPayment(cardForLumpTest, 200, '2026-08-20')
check("Logging a FUTURE-dated lump payment creates it as 'pending', not 'cleared'", lumpResult.transaction.status, 'pending')
check("Logging a future-dated lump payment does NOT touch the card's balance immediately", lumpResult.updatedCard.currentBalance, 500)

const lumpData: AppDataV2 = {
  ...data,
  creditCards: [lumpResult.updatedCard],
  transactions: [{ ...lumpResult.transaction, id: 'lump-tx' }],
}
const beforeDueDate = autoClearDuePayments(lumpData, new Date(2026, 7, 19)) // 19 Aug — one day before due
check('The day before its date, the lump payment is STILL pending', beforeDueDate.transactions.find((t) => t.id === 'lump-tx')?.status, 'pending')
check('The day before its date, the balance is STILL untouched', beforeDueDate.creditCards[0].currentBalance, 500)

const onDueDate = autoClearDuePayments(lumpData, new Date(2026, 7, 20)) // 20 Aug — exactly its date
check('On its exact date, the lump payment settles to cleared', onDueDate.transactions.find((t) => t.id === 'lump-tx')?.status, 'cleared')
check("On its exact date, the balance reduces (500 - 200 = 300)", onDueDate.creditCards[0].currentBalance, 300)

// A same-day (not future) lump payment should still clear immediately, unaffected by this fix.
const immediateLump = recordCreditCardLumpPayment({ ...card, id: 'card-3', currentBalance: 500, minimumPayment: { type: 'fixed', amount: 0 } }, 100, '2026-08-15', undefined)
check('A same-day (not future-dated) lump payment is still created as cleared immediately', immediateLump.transaction.status, 'cleared')

console.log(failures === 0 ? '\nAll auto-clear checks passed.' : `\n${failures} auto-clear check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
