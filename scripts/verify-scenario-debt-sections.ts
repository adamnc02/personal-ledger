// 2026-09-17 (Adam): loan and credit-card What-if cards adopt the savings
// pot layout — where the debt stands now, one section per date (each
// building on the ones before), then all changes against now.
//
// debtImpacts is a DISPLAY derivation alongside the untouched loanImpacts
// loops, which still own monthlyImpact/oneOffCashImpact (and the verify
// scripts guarding them). The amounts come from the same pool cascade, so
// the two cannot disagree about how much landed where — checked below.
//
// Excluded debts deliberately keep their old card and produce no
// debtImpact (Adam: "leave exclude as it is").

import { readFileSync } from 'node:fs'
import { addMonths, differenceInCalendarMonths, startOfMonth } from 'date-fns'
import { migrateLedgerData } from '../src/lib/ledgerStorage'
import { buildLegacyAppData } from '../src/lib/legacyBridge'
import { calculateScenarioImpact, calculateHouseholdScenarioImpact } from '../src/lib/scenarios'
import { summarizeLoan } from '../src/lib/loans'
import { toLocalIsoDate, todayIso, parseLocalDate } from '../src/lib/date'
import type { AppDataV2, CreditCard, Loan, Person } from '../src/types/ledger'
import type { AppData, Scenario } from '../src/types/models'

let failures = 0
function check(label: string, actual: unknown, expected: unknown, tolerance = 0.01) {
  const ok = typeof actual === 'number' && typeof expected === 'number' ? Math.abs(actual - expected) <= tolerance : JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  if (!ok) failures++
}
function checkTrue(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
  if (!ok) failures++
}

type Action = Scenario['actions'][number]
function scenario(...actions: Omit<Action, 'id' | 'label'>[]): Scenario {
  return { id: 'sc', name: 'Test', includeInCumulative: true, actions: actions.map((a, i) => ({ id: `a${i}`, label: '', ...a })) }
}
const monthStart = (n: number) => toLocalIsoDate(addMonths(startOfMonth(new Date()), n))
const d1 = monthStart(2)
const d2 = monthStart(5)

console.log('1. Synthetic loan and credit card')
{
  const me: Person = {
    id: 'me',
    name: 'Me',
    color: '#ff5b4c',
    salaryHistory: [{ id: 's1', personId: 'me', effectiveFrom: '2026-01-01', grossAnnual: 40000, taxCode: '1257L', studentLoanPlan: 'none', payFrequency: 'monthly', deductions: [] }],
    salaryOverrides: [],
  }
  const loan: Loan = {
    id: 'car-loan',
    name: 'Car Loan',
    principal: 12000,
    monthlyPayment: 250,
    termMonths: 48,
    startDate: '2026-01-15',
    categoryId: 'car',
    location: 'personal',
    ownerId: 'me',
    payee: 'me',
    payeeSharePercent: 100,
    overpayments: [],
    active: true,
  }
  const card: CreditCard = {
    id: 'card-1',
    name: 'Visa',
    color: '#8b5cf6',
    interestRatePercent: 20,
    currentBalance: 2000,
    balanceAsOfDate: '2026-01-01',
    minimumPayment: { type: 'fixed', amount: 50 },
    paymentDayOfMonth: 15,
    ownerId: 'me',
    lumpPayments: [],
    active: true,
  }
  const ledgerData: AppDataV2 = {
    people: [me],
    categories: [],
    recurringTemplates: [],
    loans: [loan],
    creditCards: [card],
    transactions: [],
    payCycles: [],
    savingsPots: [],
    scenarios: [],
    primaryPersonId: 'me',
  }
  const data = buildLegacyAppData(ledgerData)
  const run = (...actions: Omit<Action, 'id' | 'label'>[]) => calculateScenarioImpact(scenario(...actions), data, 'me', 1000)
  const lump = (value: number, date: string, id = 'car-loan', kind: 'loan' | 'credit_card' = 'loan', recastMode?: 'reduce_term' | 'reduce_payment') => ({ type: 'pay_off_loan' as const, value, date, recastMode, targets: [{ kind, id }] })
  const overpay = (value: number, date: string, id = 'car-loan', kind: 'loan' | 'credit_card' = 'loan') => ({ type: 'loan_overpayment' as const, value, date, linkedTargetKind: kind, linkedTargetId: id })

  // ---- Now ----
  const single = run(lump(2000, d1))
  const di = single.debtImpacts[0]
  const original = summarizeLoan(data.loans[0])
  check('One debt card', single.debtImpacts.length, 1)
  check('Now: balance, payment and months match the loan as it stands', [di.balanceNow, di.monthlyPaymentNow, di.monthsRemainingNow], [original.remaining, 250, original.monthsRemaining])
  check('Now: finish date', di.finishDateNow, original.finalPaymentDate)
  check('Dated: loans are dated', di.dated, true)

  // ---- One dated lump sum ----
  const s = di.sections
  check('Lump sum: one section on its date', [s.length, s[0].date], [1, d1])
  check('Lump sum: amount is what the target absorbed', s[0].lumpSum, 2000)
  // Regression (Adam-reported, 2026-09-17): the first section's "before"
  // used today's balance, not the scheduled balance on its own date, so a
  // £2,000 lump sum looked like it removed £2,000 plus every payment in
  // between. The loan keeps paying down on its own before the lump lands.
  const monthsUntil = Math.max(0, differenceInCalendarMonths(parseLocalDate(d1), new Date()))
  checkTrue('Lump sum: "before" is the scheduled balance on that date, not today\'s', s[0].balanceOnDateBefore < di.balanceNow, { balanceNow: di.balanceNow, before: s[0].balanceOnDateBefore, monthsUntil })
  check('Lump sum: before − after is exactly the lump sum', round2(s[0].balanceOnDateBefore - s[0].balanceOnDateAfter), 2000)
  checkTrue('Lump sum: balance on that date drops by about the lump sum', s[0].balanceOnDateBefore - s[0].balanceOnDateAfter >= 1900, { before: s[0].balanceOnDateBefore, after: s[0].balanceOnDateAfter })
  checkTrue('Lump sum: finishes sooner', s[0].monthsSaved > 0 && Boolean(s[0].finishDateAfter && s[0].finishDateBefore && s[0].finishDateAfter < s[0].finishDateBefore), s[0])
  check('Lump sum (reduce_term): the monthly payment is unchanged', s[0].monthlyPaymentAfter, s[0].monthlyPaymentBefore)
  check('Lump sum (reduce_term): no monthly cash change', s[0].monthlyCashChange, 0)
  check('Summary fields follow the last section', [di.balanceAfterAll, di.finishDateAfterAll, di.totalMonthsSaved], [s[0].balanceOnDateAfter, s[0].finishDateAfter, s[0].monthsSaved])

  const recast = run(lump(2000, d1, 'car-loan', 'loan', 'reduce_payment')).debtImpacts[0].sections[0]
  checkTrue('Lump sum (reduce_payment): the payment falls and frees cash', recast.monthlyPaymentAfter < recast.monthlyPaymentBefore && recast.monthlyCashChange > 0, recast)

  // ---- Recurring overpayment ----
  const rec = run(overpay(100, d1))
  const rs = rec.debtImpacts[0].sections[0]
  check('Recurring: extra per month recorded', rs.newRecurringOverpayment, 100)
  check('Recurring: payment rises by the extra', round2(rs.monthlyPaymentAfter - rs.monthlyPaymentBefore), 100)
  check('Recurring: costs that much available cash', rs.monthlyCashChange, -100)
  checkTrue('Recurring: finishes sooner', rs.monthsSaved > 0, rs.monthsSaved)

  // ---- Two dates build on each other ----
  const combined = run(lump(2000, d1), overpay(100, d2))
  const cs = combined.debtImpacts[0].sections
  check('Two dates: two sections in date order', cs.map((x) => x.date), [d1, d2])
  check("Two dates: section 2's balance before is section 1's after", cs[1].balanceOnDateBefore <= cs[0].balanceOnDateAfter, true)
  check("Two dates: section 2's finish-before is section 1's finish-after", cs[1].finishDateBefore, cs[0].finishDateAfter)
  check('Two dates: summary finish is the last section after', combined.debtImpacts[0].finishDateAfterAll, cs[1].finishDateAfter)
  check('Two dates: total months saved vs now', combined.debtImpacts[0].totalMonthsSaved, original.monthsRemaining - cs[1].monthsRemainingAfter)
  check('Two dates: total monthly cash change is the sum of the sections', combined.debtImpacts[0].totalMonthlyCashChange, round2(cs[0].monthlyCashChange + cs[1].monthlyCashChange))
  const reversed = run(overpay(100, d2), lump(2000, d1))
  check('Action order in the form does not matter, only dates', JSON.stringify(reversed.debtImpacts), JSON.stringify(combined.debtImpacts))
  const sameDay = run(lump(2000, d1), overpay(100, d1)).debtImpacts[0].sections
  check('Lump sum and overpayment on the same date share one section', [sameDay.length, sameDay[0].lumpSum, sameDay[0].newRecurringOverpayment], [1, 2000, 100])

  // ---- Agreement with the untouched loanImpacts path ----
  check('Section lump sums equal the loanImpacts payoff figure', combined.debtImpacts[0].totalLumpSum, combined.loanImpacts.find((li) => li.kind === 'payoff')!.lumpSumApplied)
  check('Summary months saved equals the payoff record when that is the only action', single.debtImpacts[0].totalMonthsSaved, single.loanImpacts.find((li) => li.kind === 'payoff')!.monthsSaved)
  check('Monthly impact still matches the sections', rec.monthlyImpact, rs.monthlyCashChange)

  // ---- Credit card: one undated section ----
  const cardImpact = run(lump(500, d1, 'card-1', 'credit_card')).debtImpacts[0]
  check('Credit card: undated, one section dated today', [cardImpact.dated, cardImpact.sections.length, cardImpact.sections[0].date], [false, 1, todayIso()])
  const liveCardBalance = data.creditCards[0].currentBalance // the bridge exposes the DERIVED balance (interest since balanceAsOfDate), not the stored anchor
  check('Credit card: balance falls by the lump sum', [cardImpact.sections[0].balanceOnDateBefore, cardImpact.sections[0].balanceOnDateAfter], [liveCardBalance, round2(liveCardBalance - 500)])
  check('Credit card: no finish dates, months instead', [cardImpact.finishDateNow, cardImpact.sections[0].finishDateAfter], [null, null])
  checkTrue('Credit card: paid off sooner, minimum payment unchanged (fixed £50)', cardImpact.totalMonthsSaved > 0 && cardImpact.monthlyPaymentNow === 50, cardImpact)
  const cardCleared = run(lump(5000, d1, 'card-1', 'credit_card')).debtImpacts[0]
  check('Credit card: a lump sum bigger than the balance clears it', [cardCleared.balanceAfterAll, cardCleared.fullyPaidOff, cardCleared.sections[0].monthlyPaymentAfter], [0, true, 0])

  // ---- Exclude keeps its own card ----
  const excluded = run({ type: 'exclude_loan', value: 0, linkedTargetKind: 'loan', linkedTargetId: 'car-loan' })
  check('Exclude produces no debt card, only its loanImpact', [excluded.debtImpacts.length, excluded.loanImpacts.length, excluded.loanImpacts[0].kind], [0, 1, 'exclude'])

  // ---- Household ----
  const mum: Person = { ...me, id: 'mum', name: 'Mum', salaryHistory: [{ ...me.salaryHistory[0], id: 's2', personId: 'mum' }] }
  const jointLoan: Loan = { ...loan, id: 'joint-loan', name: 'Joint Loan', location: 'joint', payee: 'me', payeeSharePercent: 50 }
  const householdData = buildLegacyAppData({ ...ledgerData, people: [me, mum], loans: [loan, jointLoan] })
  const jointScenario = scenario({ type: 'loan_overpayment', value: 100, date: d1, linkedTargetKind: 'loan', linkedTargetId: 'joint-loan' })
  const mine = calculateScenarioImpact(jointScenario, householdData, 'me', 0)
  const household = calculateHouseholdScenarioImpact(jointScenario, householdData, 0)
  check('A 50/50 joint loan costs me half the extra', mine.debtImpacts[0].sections[0].monthlyCashChange, -50)
  check('Household sums both shares back to the full £100', household.debtImpacts[0].sections[0].monthlyCashChange, -100)
  check('Household: one card, totals summed too', [household.debtImpacts.length, household.debtImpacts[0].totalMonthlyCashChange], [1, -100])
}

console.log("\n2. Adam's real backup")
{
  const raw = JSON.parse(readFileSync('/Users/adamcox/Downloads/App Development & Bug Tracking/shared-finance-ledger/finance-ledger-backup-2026-09-15.json', 'utf8'))
  const data: AppData = buildLegacyAppData(migrateLedgerData(raw.data ?? raw))
  const loan = data.loans[0]
  checkTrue('At least one real loan to act on', Boolean(loan), data.loans.map((l) => l.name))

  const impact = calculateScenarioImpact(
    scenario({ type: 'pay_off_loan', value: 500, date: d1, targets: [{ kind: 'loan', id: loan.id }] }, { type: 'loan_overpayment', value: 50, date: d2, linkedTargetKind: 'loan', linkedTargetId: loan.id }),
    data,
    data.primaryPersonId,
    0,
  )
  const di = impact.debtImpacts[0]
  check('One card, two sections', [impact.debtImpacts.length, di.sections.length], [1, 2])
  check('Now matches the real loan', [di.balanceNow, di.monthsRemainingNow], [summarizeLoan(loan).remaining, summarizeLoan(loan).monthsRemaining])
  check('Sections chain', di.sections[1].finishDateBefore, di.sections[0].finishDateAfter)
  checkTrue('The £500 lump sum brings the finish date forward', Boolean(di.sections[0].finishDateAfter && di.finishDateNow && di.sections[0].finishDateAfter <= di.finishDateNow), { now: di.finishDateNow, after: di.sections[0].finishDateAfter })
  check("The overpayment's cash change matches the viewer's share in the untouched loanImpacts path (£0 here: the loan is the other person's)", di.sections[1].monthlyCashChange, round2(impact.loanImpacts.find((li) => li.kind === 'overpayment')!.originalMonthlyCostForPerson - impact.loanImpacts.find((li) => li.kind === 'overpayment')!.newMonthlyCostForPerson))
  check('The overpayment still raises the payment shown on the card', round2(di.sections[1].monthlyPaymentAfter - di.sections[1].monthlyPaymentBefore), 50)
  check('Lump sums agree with the loanImpacts path', di.totalLumpSum, impact.loanImpacts.find((li) => li.kind === 'payoff')!.lumpSumApplied)
  check("The lump sum's section removes exactly the lump sum, no more", round2(di.sections[0].balanceOnDateBefore - di.sections[0].balanceOnDateAfter), 500)
  checkTrue('...and the balance before it is lower than today (payments in between)', di.sections[0].balanceOnDateBefore < di.balanceNow, { now: di.balanceNow, before: di.sections[0].balanceOnDateBefore })
  checkTrue("Every existing saved scenario still computes without throwing", data.scenarios.every((sc) => Boolean(calculateScenarioImpact(sc, data, data.primaryPersonId, 0))), data.scenarios.map((s) => s.name))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

console.log(failures === 0 ? '\nAll debt section checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
