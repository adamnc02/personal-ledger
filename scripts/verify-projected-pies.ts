// Sanity checks for the "Next 3 cycles" projected-segment math added to
// the Home page's Loans/Savings pie charts. No DOM here, so this exercises
// the underlying calculations (summarizeLoan-at-a-future-date, and the
// pending-savings_contribution-sum-within-horizon logic) the component
// reads from directly — not the SVG rendering itself.

import { summarizeLoan } from '../src/lib/ledgerLoans'
import { computeProjection, horizonRangeEnd } from '../src/lib/projection'
import { monthlyAmountForEntry } from '../src/lib/savings'
import type { AppDataV2, Loan, Person, PayCycleConfig } from '../src/types/ledger'
import { defaultLedgerData } from '../src/lib/ledgerStorage'
import { toLocalIsoDate } from '../src/lib/date'

function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${pass ? '✓' : '✗'} ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!pass) process.exitCode = 1
}

// ── Loan projection: a £1200 loan, £100/month, no overpayments ─────────
const loan: Loan = {
  id: 'loan-1',
  name: 'Sofa',
  principal: 1200, // 0%-equivalent (100 × 12) — this suite is about the projection horizon, not interest
  monthlyPayment: 100,
  termMonths: 12,
  startDate: '2026-01-01',
  categoryId: 'cat-loans',
  location: 'personal',
  ownerId: 'adam',
  payee: '',
  payeeSharePercent: 100,
  overpayments: [],
  active: true,
}

const todaySummary = summarizeLoan(loan, new Date('2026-06-15'))
check('As of 15 June, 6 payments have landed (Jan–Jun), £600 remains', todaySummary.remainingBalance, 600)

const threeMonthsOutSummary = summarizeLoan(loan, new Date('2026-09-15'))
check('As of 15 Sept (3 months later), 9 payments have landed, £300 remains — this is exactly the "projected" figure the ring reads', threeMonthsOutSummary.remainingBalance, 300)

check("Projected remaining is strictly less than today's remaining (the ring genuinely projects forward, not sideways)", threeMonthsOutSummary.remainingBalance < todaySummary.remainingBalance, true)

// A one-off overpayment logged for a FUTURE date should already be
// reflected in a projection that reaches past it, without needing "today"
// to have arrived yet.
const loanWithFutureOverpayment: Loan = { ...loan, overpayments: [{ id: 'op1', date: '2026-07-01', amount: 200 }] }
const withOverpaymentProjection = summarizeLoan(loanWithFutureOverpayment, new Date('2026-09-15'))
check(
  'A future-dated overpayment already logged is baked into the projection ahead of time (300 - 200 = 100)',
  withOverpaymentProjection.remainingBalance,
  100,
)

// ── Savings projection: pending contributions within the horizon, not double-counted against `currentAmount` ──
const person: Person = {
  id: 'adam',
  name: 'Adam',
  color: '#000',
  salaryHistory: [
    { id: 's1', personId: 'adam', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [], employerPensionPercent: 0 },
  ],
  salaryOverrides: [],
  savingsEntries: [
    { id: 'goal-1', type: 'goal', name: 'Holiday', includeInSummary: true, targetAmount: 2000, currentAmount: 500, targetDate: '2027-06-01' },
  ],
}

const payCycle: PayCycleConfig = {
  personId: 'adam',
  openingBalance: 1000,
  openingBalanceDate: '2026-01-01',
  paydayDayOfMonth: 28,
  paydayAdjustForNonWorkingDay: true,
  cycleStartDayOfMonth: 1,
}

const base = defaultLedgerData()
const data: AppDataV2 = { ...base, people: [person], payCycles: [payCycle], primaryPersonId: 'adam', transactions: [] }

const asOf = new Date('2026-06-15')
const threeCycleEnd = horizonRangeEnd(payCycle, 'three_cycles', asOf)
const projection = computeProjection(data, 'adam', payCycle, 'three_cycles', asOf)

const goalContributions = projection.transactions.filter((t) => t.type === 'savings_contribution' && t.sourceId === 'goal-1' && t.status === 'pending')
check('Projection window covers 3 upcoming paydays worth of contributions (Jun, Jul, Aug)', goalContributions.length, 3)

// generateSavingsContributions computes each contribution's amount via
// monthlyAmountForEntry(entry) using ITS OWN default `asOf` (real
// "today"), not the historical `asOf` this test walks the projection
// from — matching that exactly here rather than assuming otherwise.
const expectedMonthly = monthlyAmountForEntry(person.savingsEntries[0])
check('Each generated contribution equals the goal-required monthly amount', goalContributions.every((t) => t.amount === expectedMonthly), true)

const projectedTotal = 500 + goalContributions.reduce((sum, t) => sum + t.amount, 0)
check('Projected goal total after 3 cycles = 500 existing + 3× the required monthly amount', projectedTotal, 500 + expectedMonthly * 3)
check('Projected total is comfortably under the £2000 target (percent calc will clamp correctly, not overflow)', projectedTotal <= 2000, true)

// NB: date-only formatting here MUST go through the shared toLocalIsoDate
// helper (src/lib/date.ts), never `d.toISOString().slice(0, 10)` — this
// test previously reimplemented that exact banned pattern locally, which
// silently rolled threeCycleEnd back a day during BST (Aug 31 -> Aug 30)
// since toISOString() converts to UTC first. threeCycleEnd itself was
// always correct; only this comparison's own formatting was broken.
check('Horizon end used for the loan check and the savings check is the same kind of date (three_cycles)', toLocalIsoDate(threeCycleEnd), projection.horizonEnd)

console.log(process.exitCode ? '\nSome checks FAILED.' : '\nAll projected-pie checks passed.')
