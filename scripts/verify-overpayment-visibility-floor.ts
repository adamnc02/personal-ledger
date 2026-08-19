import { computeProjection } from '../src/lib/projection'
import { defaultLedgerData } from '../src/lib/ledgerStorage'
import type { AppDataV2, PayCycleConfig, Transaction } from '../src/types/ledger'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

const base = defaultLedgerData()
const personId = base.primaryPersonId

const payCycle: PayCycleConfig = {
  personId,
  openingBalance: 0,
  openingBalanceDate: '2026-08-19',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}

// The exact real bug: an overpayment logged for a date ONE DAY before the
// pay cycle's openingBalanceDate used to vanish entirely — not shown in
// the ledger, not counted in the balance — even though it's a real,
// deliberately-logged cash event. Confirmed live by moving this same
// transaction's date to either side of the boundary.
const overpaymentBeforeFloor: Transaction = {
  id: 't1',
  date: '2026-08-18',
  amount: 200,
  direction: 'out',
  categoryId: 'x',
  paymentMethod: 'bank_transfer',
  status: 'cleared',
  type: 'loan_payment',
  location: 'personal',
  ownerId: personId,
  payee: '',
  payeeSharePercent: 100,
  sourceType: 'loan_overpayment',
  sourceId: 'op1',
}

const data: AppDataV2 = { ...base, payCycles: [payCycle], transactions: [overpaymentBeforeFloor] }
const projection = computeProjection(data, personId, payCycle, 'current_cycle', new Date('2026-08-19'))

check('An overpayment dated before openingBalanceDate still appears in the projection\'s transaction list', projection.transactions.some((t) => t.id === 't1'), true)
check('...and is counted in the cleared balance (0 - 200 = -200)', projection.clearedBalance, -200)
check('...and flows through to the projected balance too', projection.projectedBalance, -200)

// A routine, ORDINARY historical transaction (not an overpayment) dated
// before the floor should still be hidden — this fix is deliberately
// scoped to overpayments only, not a general loosening of the floor.
const ordinaryPastExpense: Transaction = {
  id: 't2',
  date: '2026-08-18',
  amount: 50,
  direction: 'out',
  categoryId: 'x',
  paymentMethod: 'card',
  status: 'cleared',
  type: 'expense',
  location: 'personal',
  ownerId: personId,
  payee: '',
  payeeSharePercent: 100,
}
const dataWithOrdinary: AppDataV2 = { ...base, payCycles: [payCycle], transactions: [ordinaryPastExpense] }
const projectionOrdinary = computeProjection(dataWithOrdinary, personId, payCycle, 'current_cycle', new Date('2026-08-19'))
check('An ORDINARY (non-overpayment) transaction dated before the floor is still hidden, as designed', projectionOrdinary.transactions.length, 0)
check('...and does not affect the balance either', projectionOrdinary.clearedBalance, 0)

// A credit card lump payment gets the same exemption as a loan overpayment.
const cardLumpPayment: Transaction = { ...overpaymentBeforeFloor, id: 't3', type: 'credit_card_payment', sourceType: 'credit_card_lump_payment', sourceId: 'lp1' }
const dataWithLump: AppDataV2 = { ...base, payCycles: [payCycle], transactions: [cardLumpPayment] }
const projectionLump = computeProjection(dataWithLump, personId, payCycle, 'current_cycle', new Date('2026-08-19'))
check('A credit card lump payment gets the same exemption as a loan overpayment', projectionLump.transactions.some((t) => t.id === 't3'), true)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll overpayment-visibility-floor checks passed.')
