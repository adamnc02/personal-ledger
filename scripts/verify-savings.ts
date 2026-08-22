import { generateSavingsContributions } from '../src/lib/savingsLedger'
import { applyClearSideEffects, isSyntheticTransactionId } from '../src/lib/clearTransaction'
import { computeProjection } from '../src/lib/projection'
import { defaultCategories } from '../src/lib/categories'
import { cardBalanceAsOf } from '../src/lib/creditCards'
import { SAVINGS_CATEGORY_ID } from '../src/types/ledger'
import type { AppDataV2, PayCycleConfig, Person, Transaction } from '../src/types/ledger'

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
  salaryHistory: [],
  salaryOverrides: [],
  savingsEntries: [
    { id: 'goal-1', type: 'goal', name: 'House deposit', includeInSummary: true, targetAmount: 6000, currentAmount: 0, targetDate: '2027-01-01' },
    { id: 'plan-1', type: 'plan', name: 'General savings', includeInSummary: true, monthlyAmount: 100 },
    { id: 'excluded-1', type: 'plan', name: 'Not counted', includeInSummary: false, monthlyAmount: 50 },
  ],
}

// ---- 1. Savings contribution generation ----
const contributions = generateSavingsContributions(person, payCycle, new Date(2026, 0, 1), new Date(2026, 2, 31))
check('3 months × 2 active entries (goal + plan) = 6 contributions; the excluded one generates nothing', contributions.length, 6)
check('All generated contributions use the reserved Savings category', contributions.every((t) => t.categoryId === SAVINGS_CATEGORY_ID), true)
check('All generated contributions are pending', contributions.every((t) => t.status === 'pending'), true)
check('All generated contributions are direction "out"', contributions.every((t) => t.direction === 'out'), true)
check('The plan contributes its flat £100/month', contributions.filter((t) => t.sourceId === 'plan-1').every((t) => t.amount === 100), true)
check('Each contribution links back to its SavingsEntry via sourceId', contributions.every((t) => t.sourceType === 'savings_entry' && !!t.sourceId), true)

// ---- 2. pausedFrom ----
const pausedPerson: Person = {
  ...person,
  savingsEntries: [{ id: 'plan-2', type: 'plan', name: 'Pausable', includeInSummary: true, monthlyAmount: 50, pausedFrom: '2026-03-01' }],
}
const pausedContributions = generateSavingsContributions(pausedPerson, payCycle, new Date(2026, 0, 1), new Date(2026, 4, 31))
check('Contributions generate normally before pausedFrom (Jan, Feb)', pausedContributions.filter((t) => t.date < '2026-03-01').length, 2)
check('No contributions generate on/after pausedFrom (Mar onward)', pausedContributions.some((t) => t.date >= '2026-03-01'), false)

// ---- 3. Clear-transaction side effects ----
check('A synthetic id (generated:xxx) is correctly identified', isSyntheticTransactionId('generated:abc123'), true)
check('A real nanoid is NOT identified as synthetic', isSyntheticTransactionId('aB3xY9zQ'), false)

const savingsData: AppDataV2 = {
  people: [person],
  categories: defaultCategories(),
  recurringTemplates: [],
  loans: [],
  creditCards: [],
  transactions: [],
  payCycles: [payCycle],
  scenarios: [],
  primaryPersonId: 'me',
}
const contributionTxn: Transaction = {
  id: 'tx-1',
  date: '2026-01-28',
  amount: 100,
  direction: 'out',
  categoryId: SAVINGS_CATEGORY_ID,
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'savings_contribution',
  location: 'personal',
  ownerId: 'me',
  sourceType: 'savings_entry',
  sourceId: 'plan-1',
}
const afterClear = applyClearSideEffects(savingsData, contributionTxn)
check('Clearing a savings contribution does NOT affect a plan (no currentAmount field, no-op safely)', afterClear.people[0].savingsEntries.find((e) => e.id === 'plan-1')?.currentAmount, undefined)

const goalContributionTxn: Transaction = { ...contributionTxn, sourceId: 'goal-1', amount: 250 }
const afterGoalClear = applyClearSideEffects(savingsData, goalContributionTxn)
check('Clearing a GOAL contribution quietly increases currentAmount by the transaction amount', afterGoalClear.people[0].savingsEntries.find((e) => e.id === 'goal-1')?.currentAmount, 250)

// Clearing a second contribution should ADD to the running total, not overwrite it.
const afterSecondGoalClear = applyClearSideEffects(afterGoalClear, { ...goalContributionTxn, id: 'tx-2', amount: 250 })
check('A second cleared contribution accumulates on top of the first, not replaces it', afterSecondGoalClear.people[0].savingsEntries.find((e) => e.id === 'goal-1')?.currentAmount, 500)

// ---- 4. Credit card payment clearing (the "easy follow-on" using the same mechanism) ----
const cardData: AppDataV2 = {
  ...savingsData,
  creditCards: [
    { id: 'card-1', name: 'Amex', categoryId: SAVINGS_CATEGORY_ID, color: '#8b5cf6', interestRatePercent: 0, currentBalance: 500, balanceAsOfDate: '2026-01-01', minimumPayment: { type: 'fixed', amount: 40 }, paymentDayOfMonth: 10, ownerId: 'me', lumpPayments: [], active: true },
  ],
}
const generatedMinPaymentTxn: Transaction = {
  id: 'generated:xyz',
  date: '2026-01-10',
  amount: 40,
  direction: 'out',
  categoryId: SAVINGS_CATEGORY_ID,
  paymentMethod: 'direct_debit',
  status: 'cleared',
  type: 'credit_card_payment',
  location: 'personal',
  ownerId: 'me',
  creditCardId: 'card-1',
}
// Credit card payments no longer have a clear-time SIDE EFFECT at all —
// the card's balance is derived from its transactions rather than kept
// as a running total (see cardBalanceAsOf). So the assertions flip: the
// stored anchor must stay put, and the DERIVED figure is what moves.
// applyClearSideEffects being a no-op for this type is now the correct
// behaviour, and worth pinning explicitly so a future change that
// reintroduces the mutation shows up as a double-count here.
const afterCardClear = applyClearSideEffects(cardData, generatedMinPaymentTxn)
check('Clearing a generated minimum payment does NOT mutate the stored anchor (no side effect any more)', afterCardClear.creditCards[0].currentBalance, 500)
check('...and the DERIVED balance reflects it instead', cardBalanceAsOf(cardData.creditCards[0], [generatedMinPaymentTxn], new Date(2026, 0, 10)), 460)

const lumpPaymentTxn: Transaction = { ...generatedMinPaymentTxn, id: 'tx-3', sourceType: 'credit_card_lump_payment', sourceId: 'lump-1' }
const afterLumpClear = applyClearSideEffects(cardData, lumpPaymentTxn)
check('A lump payment likewise leaves the stored anchor alone', afterLumpClear.creditCards[0].currentBalance, 500)
check('A lump payment reduces the derived balance uniformly with any other credit_card_payment (no special-cased exemption)', cardBalanceAsOf(cardData.creditCards[0], [lumpPaymentTxn], new Date(2026, 0, 10)), 460)

// ---- 5. Opening balance as a visibility floor ----
const floorPayCycle: PayCycleConfig = { ...payCycle, openingBalanceDate: '2026-06-01' }
const floorData: AppDataV2 = {
  ...savingsData,
  payCycles: [floorPayCycle],
  transactions: [
    { id: 'old-1', date: '2026-05-15', amount: 50, direction: 'out', categoryId: 'category-bills', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' },
    { id: 'new-1', date: '2026-06-15', amount: 30, direction: 'out', categoryId: 'category-bills', paymentMethod: 'card', status: 'cleared', type: 'expense', location: 'personal', ownerId: 'me' },
  ],
}
const floorProjection = computeProjection(floorData, 'me', floorPayCycle, 'current_cycle', new Date(2026, 5, 20))
check('A transaction dated BEFORE the opening balance date is excluded from the list entirely', floorProjection.transactions.some((t) => t.id === 'old-1'), false)
check('A transaction dated on/after the opening balance date IS included', floorProjection.transactions.some((t) => t.id === 'new-1'), true)
check("clearedBalance excludes the pre-opening-balance transaction (1000 opening - only the £30, not also the £50)", floorProjection.clearedBalance, 970)

console.log(failures === 0 ? '\nAll savings/clearing checks passed.' : `\n${failures} savings/clearing check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
